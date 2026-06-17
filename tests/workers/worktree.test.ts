import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveBaseSha,
  createWorktree,
  captureDiff,
  snapshotMainTree,
  auditBoundary,
  sanitizePatch,
  patchSha256,
  removeWorktree,
} from '../../src/workers/worktree.js';

const exec = promisify(execFile);
const g = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
  exec('git', args, { cwd });

const WORKTREE_DIR = '.aisup-workers';
const FORBIDDEN = ['**/.claude/settings.local.json', '**/*.jsonl', '**/*.pem', '**/.env', '**/.env.*'];

async function initRepo(dir: string): Promise<void> {
  await g(['init', '-b', 'main'], dir);
  await g(['config', 'user.email', 't@t.dev'], dir);
  await g(['config', 'user.name', 'Tester'], dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(join(dir, '.gitignore'), `${WORKTREE_DIR}/\n.claude/\n.env\n`);
  await g(['add', 'README.md', '.gitignore'], dir);
  await g(['commit', '-m', 'init'], dir);
}

describe('worktree lifecycle & boundary (@requires_git)', () => {
  let repo: string;
  const taskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'aisup-wt-'));
    await initRepo(repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('resolveBaseSha refuses a base_ref beginning with "-" before running git', async () => {
    await expect(resolveBaseSha({ workspaceRoot: repo, baseRef: '--help' })).rejects.toThrow(/base_ref/i);
  });

  it('createWorktree + write + captureDiff yields a patch with the file; the audit snapshot is unchanged', async () => {
    const before = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    const baseSha = await resolveBaseSha({ workspaceRoot: repo, baseRef: 'HEAD' });
    const wt = await createWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, baseSha, taskId });
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1;\n');
    const { patch, changedFiles } = await captureDiff({ worktree: wt, baseSha });
    expect(patch).toContain('feature.ts');
    expect(patch).toContain('export const x = 1;');
    expect(changedFiles).toContain('feature.ts');
    const after = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    expect(after.status).toBe(before.status);
  });

  it('a $HOME-resolved write into <worktree>/.home is absent from BOTH patch text and changed_files', async () => {
    const baseSha = await resolveBaseSha({ workspaceRoot: repo, baseRef: 'HEAD' });
    const wt = await createWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, baseSha, taskId });
    mkdirSync(join(wt, '.home', '.claude'), { recursive: true });
    writeFileSync(join(wt, '.home', '.claude', 'settings.local.json'), '{"secret":true}\n');
    writeFileSync(join(wt, 'real-change.ts'), 'export const y = 2;\n');
    const { patch, changedFiles } = await captureDiff({ worktree: wt, baseSha });
    expect(changedFiles).toContain('real-change.ts');
    expect(changedFiles.some((f) => f.includes('.home'))).toBe(false);
    expect(patch).not.toContain('.home');
    expect(patch).not.toContain('"secret"');
  });

  it('captureDiff still diffs against the stored base_sha after the source branch advances', async () => {
    const baseSha = await resolveBaseSha({ workspaceRoot: repo, baseRef: 'HEAD' });
    const wt = await createWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, baseSha, taskId });
    writeFileSync(join(wt, 'wfile.ts'), 'export const z = 3;\n');
    // advance main after worktree creation
    writeFileSync(join(repo, 'other.ts'), 'export const a = 9;\n');
    await g(['add', 'other.ts'], repo);
    await g(['commit', '-m', 'advance'], repo);
    const { changedFiles } = await captureDiff({ worktree: wt, baseSha });
    expect(changedFiles).toEqual(['wfile.ts']); // not polluted by main's new commit
  });

  it('auditBoundary returns false when a worker writes into the main workspace (tracked path)', async () => {
    const before = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    writeFileSync(join(repo, 'escaped.ts'), 'leak\n');
    const ok = await auditBoundary({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, before, forbiddenPathGlobs: FORBIDDEN });
    expect(ok).toBe(false);
  });

  it('auditBoundary returns false for a write to a gitignored main path (proves --ignored)', async () => {
    const before = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"x":1}\n');
    const ok = await auditBoundary({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, before, forbiddenPathGlobs: FORBIDDEN });
    expect(ok).toBe(false);
  });

  it('auditBoundary returns false on a content change to a pre-existing ignored .env (HI-004)', async () => {
    writeFileSync(join(repo, '.env'), 'A=1\n'); // pre-existing ignored file
    const before = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    const statusBefore = before.status;
    writeFileSync(join(repo, '.env'), 'A=2\n'); // same size, different content
    const after = await snapshotMainTree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, forbiddenPathGlobs: FORBIDDEN });
    expect(after.status).toBe(statusBefore); // git status line identical
    const ok = await auditBoundary({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, before, forbiddenPathGlobs: FORBIDDEN });
    expect(ok).toBe(false); // content hash caught it
  });

  it('createWorktree refuses a symlinked worktree_dir, and "." / ".git"', async () => {
    const baseSha = await resolveBaseSha({ workspaceRoot: repo, baseRef: 'HEAD' });
    mkdirSync(join(repo, 'realdir'));
    symlinkSync(join(repo, 'realdir'), join(repo, 'linkdir'));
    await expect(
      createWorktree({ workspaceRoot: repo, worktreeDir: 'linkdir', baseSha, taskId })
    ).rejects.toThrow(/symlink|worktree_dir/i);
    await expect(
      createWorktree({ workspaceRoot: repo, worktreeDir: '.', baseSha, taskId })
    ).rejects.toThrow(/worktree_dir/i);
    await expect(
      createWorktree({ workspaceRoot: repo, worktreeDir: '.git', baseSha, taskId })
    ).rejects.toThrow(/worktree_dir/i);
  });

  it('sanitizePatch flags forbidden paths and secret assignment lines; a clean patch passes', () => {
    const envHit = sanitizePatch(['.env'], '+SECRET=zzz\n', FORBIDDEN);
    expect(envHit.ok).toBe(false);
    const pemHit = sanitizePatch(['keys/server.pem'], '+stuff\n', FORBIDDEN);
    expect(pemHit.ok).toBe(false);
    const jsonlHit = sanitizePatch(['transcripts/a.jsonl'], '+log\n', FORBIDDEN);
    expect(jsonlHit.ok).toBe(false);
    const secretLine = sanitizePatch(['src/config.ts'], '+const api_key = "sk-123"\n', FORBIDDEN);
    expect(secretLine.ok).toBe(false);
    expect(secretLine.violations.join(',')).not.toContain('sk-123'); // never carries content
    const clean = sanitizePatch(['src/app.ts'], '+export const z = 1;\n', FORBIDDEN);
    expect(clean.ok).toBe(true);
    expect(clean.violations).toEqual([]);
  });

  it('patchSha256 matches the sha256 of the patch bytes written to disk', async () => {
    const patch = 'diff --git a/x b/x\n+content\n';
    const hash = patchSha256(patch);
    const file = join(repo, 'patch.diff');
    writeFileSync(file, patch);
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash);
  });

  it('removeWorktree refuses a path outside worktree_dir', async () => {
    await expect(
      removeWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, path: join(repo, 'README.md') })
    ).rejects.toThrow(/outside|worktree_dir/i);
  });

  it('removeWorktree removes a valid worktree under worktree_dir', async () => {
    const baseSha = await resolveBaseSha({ workspaceRoot: repo, baseRef: 'HEAD' });
    const wt = await createWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, baseSha, taskId });
    expect(existsSync(wt)).toBe(true);
    await removeWorktree({ workspaceRoot: repo, worktreeDir: WORKTREE_DIR, path: wt });
    expect(existsSync(wt)).toBe(false);
  });
});
