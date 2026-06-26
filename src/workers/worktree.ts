import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  statSync,
  lstatSync,
  realpathSync,
  rmdirSync,
} from 'node:fs';
import { join, isAbsolute, dirname, sep } from 'node:path';
import picomatch from 'picomatch';
import { MAX_BUFFER } from '../gates/engine.js';

const execFileAsync = promisify(execFile);

/** Shell-free git — never a shell string. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return String(stdout ?? '');
}

// Secret keywords mirror the journal denylist (src/journal/writer.ts:5) but match assignment
// LINES (key + : or =), because SECRET_KEY_PATTERN is ^…$-anchored to whole keys and matches
// nothing in diff text (MD-004).
const SECRET_LINE =
  /(token|secret|api[_-]?key|password|authorization|bot_token|app_token|signing_secret)\s*[:=]/i;

// Dirs created in the worker's cwd by session hooks / MCP servers — CodeGraph's SessionStart hook
// (`~/.pilot/hooks/codegraph_init.py` → `.codegraph/`) and Serena (`.serena/`) — plus the isolated
// `.home/`. None are the worker's task output. They are excluded from BOTH the worktree-local
// info/exclude (so `git add -A -N` skips them) AND the captured-diff pathspec, so they can never
// pollute the patch when the worker's workspace repo does not already gitignore them (a fresh scratch
// repo, or a user repo without these entries). An unexcluded tool dir breaks reviewer verdict parsing.
const DIFF_EXCLUDE_DIRS = ['.home/', '.codegraph/', '.serena/'] as const;
const EXCLUDE_PATHSPECS = DIFF_EXCLUDE_DIRS.map((d) => `:(exclude)${d}`);

export interface MainTreeSnapshot {
  status: string; // `git status --porcelain --ignored`, worktreeDir lines removed
  forbidden: Record<string, string>; // matched forbidden path -> "size:mtimeMs:sha256"
}

/** Resolve base_ref to an immutable commit sha; reject a leading-"-" ref (argument-injection guard, LO-006). */
export async function resolveBaseSha(opts: { workspaceRoot: string; baseRef: string }): Promise<string> {
  const { workspaceRoot, baseRef } = opts;
  if (baseRef.startsWith('-')) {
    throw new Error(`worktree: base_ref must not begin with "-": "${baseRef}"`);
  }
  const out = await git(['rev-parse', '--verify', `${baseRef}^{commit}`], workspaceRoot);
  return out.trim();
}

function validateWorktreeDir(workspaceRoot: string, worktreeDir: string): string {
  if (typeof worktreeDir !== 'string' || worktreeDir === '' || worktreeDir === '.') {
    throw new Error(`createWorktree: invalid worktree_dir "${worktreeDir}"`);
  }
  if (isAbsolute(worktreeDir) || worktreeDir.startsWith('/')) {
    throw new Error(`createWorktree: worktree_dir must be relative: "${worktreeDir}"`);
  }
  const segments = worktreeDir.split('/');
  if (segments.includes('..') || segments.includes('.git')) {
    throw new Error(`createWorktree: worktree_dir must not contain ".." or ".git": "${worktreeDir}"`);
  }
  const target = join(workspaceRoot, worktreeDir);
  if (target === workspaceRoot) {
    throw new Error('createWorktree: worktree_dir must not resolve to workspace_root');
  }
  // Reject any existing symlink component between workspaceRoot and target (mirror migrator.ts:65-77).
  let current = target;
  while (current !== workspaceRoot && current.length > workspaceRoot.length) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      throw new Error(`createWorktree: symlinked worktree_dir component rejected: ${current}`);
    }
    current = dirname(current);
  }
  return target;
}

/** Create a detached worktree at <worktreeDir>/<taskId> from baseSha; no branch ref (detached-only, MD-014). */
export async function createWorktree(opts: {
  workspaceRoot: string;
  worktreeDir: string;
  baseSha: string;
  taskId: string;
}): Promise<string> {
  const { workspaceRoot, worktreeDir, baseSha, taskId } = opts;
  validateWorktreeDir(workspaceRoot, worktreeDir);
  const worktree = join(workspaceRoot, worktreeDir, taskId);
  await git(['worktree', 'add', '--detach', worktree, baseSha], workspaceRoot);

  // Isolated throwaway HOME for the worker subprocess.
  mkdirSync(join(worktree, '.home'), { recursive: true, mode: 0o700 });

  // Worktree-local exclude so `git add -A -N` never stages .home/ or tool-data dirs (belt-and-suspenders
  // with the :(exclude) pathspecs in captureDiff — MD-003 + DIFF_EXCLUDE_DIRS).
  const excludeRaw = (await git(['rev-parse', '--git-path', 'info/exclude'], worktree)).trim();
  const excludePath = isAbsolute(excludeRaw) ? excludeRaw : join(worktree, excludeRaw);
  mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
  appendFileSync(excludePath, DIFF_EXCLUDE_DIRS.map((d) => `${d}\n`).join(''));

  return worktree;
}

/** Capture the worktree diff vs the immutable baseSha (excluding .home/). The only automatic git add. */
export async function captureDiff(opts: {
  worktree: string;
  baseSha: string;
}): Promise<{ patch: string; changedFiles: string[] }> {
  const { worktree, baseSha } = opts;
  // Intent-to-add so new files appear in the diff. .home/ + tool-data dirs are in the worktree-local
  // info/exclude so a plain `add -A -N` skips them; the diff calls add :(exclude) pathspecs as
  // belt-and-suspenders (MD-003/MD-012 + DIFF_EXCLUDE_DIRS). An explicit pathspec on `add` would error
  // on the now-ignored dirs, so it is omitted.
  await git(['add', '-A', '-N'], worktree);
  const patch = await git(['diff', baseSha, '--', '.', ...EXCLUDE_PATHSPECS], worktree);
  const namesOut = await git(['diff', '--name-only', baseSha, '--', '.', ...EXCLUDE_PATHSPECS], worktree);
  const changedFiles = namesOut.split('\n').map((l) => l.trim()).filter(Boolean);
  // Defense-in-depth: a diff path must never resolve outside the worktree (structurally it cannot).
  for (const f of changedFiles) {
    if (f.startsWith('/') || f.split('/').includes('..')) {
      throw new Error(`captureDiff: changed path escapes the worktree: ${f}`);
    }
  }
  return { patch, changedFiles };
}

function walkFiles(root: string, skipTop: Set<string>): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? join(root, rel) : root;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (rel === '' && (skipTop.has(e.name) || e.name === '.git')) continue;
      if (e.isSymbolicLink()) {
        out.push(childRel);
      } else if (e.isDirectory()) {
        stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/**
 * Snapshot the main tree two ways: `git status --porcelain --ignored` (worktreeDir lines removed)
 * PLUS existence+size+mtime+sha256 of every existing forbidden-glob file — `git status` cannot
 * see content changes to a pre-existing ignored file (HI-004).
 */
export async function snapshotMainTree(opts: {
  workspaceRoot: string;
  worktreeDir: string;
  forbiddenPathGlobs: string[];
}): Promise<MainTreeSnapshot> {
  const { workspaceRoot, worktreeDir, forbiddenPathGlobs } = opts;
  const raw = await git(['status', '--porcelain', '--ignored'], workspaceRoot);
  const status = raw
    .split('\n')
    .filter((line) => {
      if (!line) return false;
      const path = line.slice(3);
      return path !== worktreeDir && path !== `${worktreeDir}/` && !path.startsWith(`${worktreeDir}/`);
    })
    .join('\n');

  const isMatch = picomatch(forbiddenPathGlobs, { dot: true });
  const forbidden: Record<string, string> = {};
  for (const rel of walkFiles(workspaceRoot, new Set([worktreeDir]))) {
    if (!isMatch(rel)) continue;
    const abs = join(workspaceRoot, rel);
    try {
      const st = statSync(abs);
      const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      forbidden[rel] = `${st.size}:${st.mtimeMs}:${hash}`;
    } catch {
      forbidden[rel] = 'absent';
    }
  }
  return { status, forbidden };
}

/** True only when the main tree's status snapshot AND every forbidden-glob file hash are unchanged. */
export async function auditBoundary(opts: {
  workspaceRoot: string;
  worktreeDir: string;
  before: MainTreeSnapshot;
  forbiddenPathGlobs: string[];
}): Promise<boolean> {
  const after = await snapshotMainTree({
    workspaceRoot: opts.workspaceRoot,
    worktreeDir: opts.worktreeDir,
    forbiddenPathGlobs: opts.forbiddenPathGlobs,
  });
  if (after.status !== opts.before.status) return false;
  const keys = new Set([...Object.keys(opts.before.forbidden), ...Object.keys(after.forbidden)]);
  for (const k of keys) {
    if (opts.before.forbidden[k] !== after.forbidden[k]) return false;
  }
  return true;
}

/**
 * Sanitize a captured patch BEFORE persistence: (a) forbidden-path match over changedFiles via
 * picomatch (matches PATHS), (b) secret-content scan over added patch lines. Violations carry
 * only categories/paths, never content (MD-004).
 */
export function sanitizePatch(
  changedFiles: string[],
  patch: string,
  forbiddenGlobs: string[]
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const isMatch = picomatch(forbiddenGlobs, { dot: true });
  for (const f of changedFiles) {
    if (isMatch(f)) violations.push(`forbidden_path:${f}`);
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++') && SECRET_LINE.test(line)) {
      violations.push('secret_content');
      break;
    }
  }
  return { ok: violations.length === 0, violations };
}

/** sha256 hex over the sanitized patch bytes — the review→merge integrity anchor (MD-009). */
export function patchSha256(patch: string): string {
  return createHash('sha256').update(patch, 'utf8').digest('hex');
}

function assertNoSymlinkComponents(path: string, baseDir: string): void {
  let current = dirname(path);
  while (current !== baseDir && current.length > baseDir.length) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      throw new Error(`removeWorktree: symlinked component rejected: ${current}`);
    }
    current = dirname(current);
  }
}

/** Remove a worktree — the only destructive git op; path-validated under worktree_dir, never the main tree. */
export async function removeWorktree(opts: {
  workspaceRoot: string;
  worktreeDir: string;
  path: string;
}): Promise<void> {
  const { workspaceRoot, worktreeDir, path } = opts;
  const baseDir = join(workspaceRoot, worktreeDir);
  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch {
    throw new Error(`removeWorktree: worktree_dir base does not exist: ${baseDir}`);
  }
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    throw new Error(`removeWorktree: path does not exist: ${path}`);
  }
  if (realPath !== realBase && !realPath.startsWith(realBase + sep)) {
    throw new Error(`removeWorktree: refuse path outside worktree_dir: ${path}`);
  }
  assertNoSymlinkComponents(path, baseDir);
  await git(['worktree', 'remove', '--force', path], workspaceRoot);

  // Tidy the now-empty worktree_dir base so a merged/cleaned worker leaves nothing behind
  // (`git worktree remove` deletes the worktree subdir but not its parent). Best-effort and
  // empty-only: rmdirSync throws ENOTEMPTY if another worker still has a worktree here.
  if (readdirSync(realBase).length === 0) {
    try {
      rmdirSync(realBase);
    } catch {
      // best-effort — a concurrent worker may have repopulated the base
    }
  }
}

/** Whether the worktree_dir is gitignored in the main repo (warn-level check for the orchestrator). */
export async function isWorktreeDirIgnored(workspaceRoot: string, worktreeDir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', worktreeDir], { cwd: workspaceRoot });
    return true;
  } catch {
    return false;
  }
}

/** Whether a path is inside a git work tree. */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(['rev-parse', '--is-inside-work-tree'], root);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Whether the patch applies cleanly to the main workspace (no mutation). */
export async function applyCheck(workspaceRoot: string, patchPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', '--check', patchPath], { maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

/** Whether the patch is already applied (reverse-applies cleanly) — used by MERGING rehydration (HI-003). */
export async function applyReverseCheck(workspaceRoot: string, patchPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', '--reverse', '--check', patchPath], { maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}
