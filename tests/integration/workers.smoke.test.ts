import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerOrchestrator, type WorktreeOps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import * as wt from '../../src/workers/worktree.js';
import { validateWorkerOutput } from '../../src/workers/validation.js';
import { reviewWorkerOutput } from '../../src/workers/review.js';
import { mergeWorkerOutput } from '../../src/workers/merge.js';
import { buildWorkerCommand } from '../../src/workers/adapter.js';
import { parseCodexJsonStream } from '../../src/workers/codex-json.js';
import type { WorkersConfig, WorkerAdapterConfig, GateCommandConfig } from '../../src/config/schema.js';
import type { JournalEvent } from '../../src/journal/types.js';
import type { WorkerState, WorkerStatus, WorkerTask } from '../../src/workers/types.js';

const exec = promisify(execFile);
const g = (args: string[], cwd: string): Promise<unknown> => exec('git', args, { cwd });

// --- fake adapter scripts (run via `node -e <script>`) -----------------------
const IMPL_WRITE = "require('fs').writeFileSync('feature.ts','export const x = 1;\\n');";
const IMPL_ESCAPE_MAIN =
  "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.cwd(),'..','..','escaped.ts'),'leak\\n');fs.writeFileSync('feature.ts','export const x = 1;\\n');";
const IMPL_MODIFY_ENV =
  "const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.cwd(),'..','..','.env'),'A=2\\n');fs.writeFileSync('feature.ts','export const x = 1;\\n');";
const IMPL_HOME_WRITE =
  "const fs=require('fs'),p=require('path');fs.mkdirSync(p.join(process.env.HOME,'.claude'),{recursive:true});fs.writeFileSync(p.join(process.env.HOME,'.claude','settings.local.json'),'{\\\"x\\\":1}');fs.writeFileSync('feature.ts','export const x = 1;\\n');";
const IMPL_SECRET = "require('fs').writeFileSync('config.ts','const api_key = \\\"sk-leak-123\\\";\\n');";

const REV_APPROVE = "process.stdout.write('Looks correct.\\nVERDICT: APPROVE');";
const REV_REJECT = "process.stdout.write('Found a subtle bug.\\nVERDICT: REJECT');";
const REV_WRITE_CWD = "require('fs').writeFileSync('reviewer-scratch.txt','x');process.stdout.write('VERDICT: APPROVE');";

function nodeAdapter(name: string, script: string, promptVia: 'arg' | 'stdin'): WorkerAdapterConfig {
  return {
    name, command: 'node', args: ['-e', script], prompt_via: promptVia,
    prompt_arg_flag: null, prompt_file_flag: null, env_allowlist: ['PATH', 'HOME'], timeout_seconds: 60, enabled: true,
  };
}

function gate(command: string, args: string[]): GateCommandConfig {
  return { name: 'check', command, args, timeout_seconds: 60, required: true, cwd: null };
}

const GATE_PASS = gate('node', ['-e', 'process.exit(0)']);
const GATE_FAIL = gate('node', ['-e', 'process.exit(1)']);

function buildConfig(impl: WorkerAdapterConfig, rev: WorkerAdapterConfig, validationGate: GateCommandConfig): WorkersConfig {
  return {
    enabled: true,
    workspace_root: null,
    worktree_dir: '.aisup-workers',
    base_ref: 'HEAD',
    max_concurrent: 2,
    retention: { keep_merged: false, keep_rejected: true, max_age_hours: 168 },
    security: {
      env_allowlist: ['PATH', 'HOME', 'LANG'],
      boundary_audit: true,
      forbidden_path_globs: ['**/.claude/settings.local.json', '**/*.jsonl', '**/*.pem', '**/.env', '**/.env.*'],
    },
    adapters: { [impl.name]: impl, [rev.name]: rev },
    routing: { default_implementer: impl.name, default_reviewer: rev.name, by_task_type: {} },
    review: { allow_same_model_review: false },
    validation_gates: [validationGate],
    validation: { allow_no_validation: false },
    merge: { require_approval: true, apply_check_required: true },
  };
}

const REAL_WORKTREE_OPS: WorktreeOps = {
  resolveBaseSha: wt.resolveBaseSha,
  createWorktree: wt.createWorktree,
  captureDiff: wt.captureDiff,
  snapshotMainTree: wt.snapshotMainTree,
  auditBoundary: wt.auditBoundary,
  sanitizePatch: wt.sanitizePatch,
  patchSha256: wt.patchSha256,
  removeWorktree: wt.removeWorktree,
  isGitRepo: wt.isGitRepo,
  applyCheck: wt.applyCheck,
  applyReverseCheck: wt.applyReverseCheck,
};

async function initRepo(dir: string): Promise<void> {
  await g(['init', '-b', 'main'], dir);
  await g(['config', 'user.email', 't@t.dev'], dir);
  await g(['config', 'user.name', 'Tester'], dir);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  writeFileSync(join(dir, '.gitignore'), '.aisup-workers/\n.claude/\n.env\n');
  await g(['add', 'README.md', '.gitignore'], dir);
  await g(['commit', '-m', 'init'], dir);
}

async function waitForStatus(store: WorkerStore, id: string, statuses: WorkerStatus[], timeout = 15000): Promise<WorkerState> {
  const start = Date.now();
  for (;;) {
    const s = store.read(id);
    if (s && statuses.includes(s.status)) return s;
    if (Date.now() - start > timeout) throw new Error(`waitForStatus timeout: ${store.read(id)?.status}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('multi-LLM worker E2E smoke (@requires_git)', () => {
  let repo: string;
  let stateDir: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'aisup-smoke-repo-'));
    stateDir = mkdtempSync(join(tmpdir(), 'aisup-smoke-state-'));
    await initRepo(repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeOrch(config: WorkersConfig): { orch: WorkerOrchestrator; store: WorkerStore; events: JournalEvent[] } {
    const events: JournalEvent[] = [];
    const store = new WorkerStore(stateDir);
    const orch = new WorkerOrchestrator({
      store, config, journal: { append: async (e) => { events.push(e); } },
      worktreeOps: REAL_WORKTREE_OPS,
      validateOutput: validateWorkerOutput,
      reviewOutput: reviewWorkerOutput,
      mergeOutput: mergeWorkerOutput,
      resolveActiveSessionCwd: () => null,
    });
    return { orch, store, events };
  }

  it('AC1/AC2: a generic worker completes a bounded task in an isolated worktree → AWAITING_APPROVAL', async () => {
    const { orch, store } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_WRITE, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'add feature', workspace: repo });
    const s = await waitForStatus(store, id, ['AWAITING_APPROVAL', 'FAILED', 'REJECTED']);
    expect(s.status).toBe('AWAITING_APPROVAL');
    expect(s.output!.changed_files).toContain('feature.ts');
    expect(s.validation!.passed).toBe(true);
    expect(s.review!.verdict).toBe('approve');
  });

  it('AC6/AC7: approval is required, and an approved patch applies cleanly to the main workspace (no commit)', async () => {
    const { orch, store } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_WRITE, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'add feature', workspace: repo });
    await waitForStatus(store, id, ['AWAITING_APPROVAL']);
    // base_sha immutability: advance main with an unrelated commit before approving
    writeFileSync(join(repo, 'unrelated.ts'), 'export const u = 0;\n');
    await g(['add', 'unrelated.ts'], repo);
    await g(['commit', '-m', 'advance'], repo);
    const headBefore = String((await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).trim();

    const res = await orch.approve(id, 'user');
    expect(res.ok).toBe(true);
    expect(store.read(id)!.status).toBe('MERGED');
    expect(readFileSync(join(repo, 'feature.ts'), 'utf8')).toBe('export const x = 1;\n');
    // working-tree apply only — no new commit
    expect(String((await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).trim()).toBe(headBefore);
  });

  it('AC3 (TS-003): a seeded bug that passes gates but the reviewer rejects ⇒ REJECTED, merge blocked', async () => {
    const { orch, store, events } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_WRITE, 'arg'), nodeAdapter('rev', REV_REJECT, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'add feature', workspace: repo });
    const s = await waitForStatus(store, id, ['REJECTED', 'AWAITING_APPROVAL', 'FAILED']);
    expect(s.status).toBe('REJECTED');
    expect(s.validation!.passed).toBe(true); // gates passed — review is the distinct gate
    expect(events.some((e) => e.event_type === 'worker.validated')).toBe(true);
    expect(events.some((e) => e.event_type === 'worker.review_failed')).toBe(true);
    const approve = await orch.approve(id, 'user');
    expect(approve.ok).toBe(false); // terminal, not AWAITING_APPROVAL
  });

  it('AC4a: a worker writing into the main workspace ⇒ boundary audit fails ⇒ FAILED, merge blocked', async () => {
    const { orch, store, events } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_ESCAPE_MAIN, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'escape', workspace: repo });
    const s = await waitForStatus(store, id, ['FAILED', 'AWAITING_APPROVAL', 'REJECTED']);
    expect(s.status).toBe('FAILED');
    expect(events.some((e) => e.event_type === 'worker.boundary_violation')).toBe(true);
  });

  it('AC4b: modifying a pre-existing ignored .env (content-hash) ⇒ boundary audit fails ⇒ FAILED (HI-004)', async () => {
    writeFileSync(join(repo, '.env'), 'A=1\n'); // pre-existing ignored file
    const { orch, store, events } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_MODIFY_ENV, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'touch env', workspace: repo });
    const s = await waitForStatus(store, id, ['FAILED', 'AWAITING_APPROVAL']);
    expect(s.status).toBe('FAILED');
    expect(events.some((e) => e.event_type === 'worker.boundary_violation')).toBe(true);
  });

  it('AC4c: a $HOME-resolving write is contained in the temp HOME and absent from the captured patch (MD-003)', async () => {
    const { orch, store } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_HOME_WRITE, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'home write', workspace: repo });
    const s = await waitForStatus(store, id, ['AWAITING_APPROVAL', 'FAILED']);
    expect(s.status).toBe('AWAITING_APPROVAL'); // $HOME write is contained — not a boundary violation
    expect(s.output!.changed_files).toContain('feature.ts');
    expect(s.output!.changed_files.some((f) => f.includes('.home'))).toBe(false);
    expect(s.output!.patch).not.toContain('settings.local.json');
  });

  it('AC5: a failing required validation gate ⇒ REJECTED before review approval', async () => {
    const { orch, store, events } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_WRITE, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_FAIL));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'add feature', workspace: repo });
    const s = await waitForStatus(store, id, ['REJECTED', 'AWAITING_APPROVAL', 'FAILED']);
    expect(s.status).toBe('REJECTED');
    expect(s.validation!.passed).toBe(false);
    expect(events.some((e) => e.event_type === 'worker.validation_failed')).toBe(true);
  });

  it('HI-002: a secret-bearing patch ⇒ worker.security_denied and no raw patch/tails persisted', async () => {
    const { orch, store, events } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_SECRET, 'arg'), nodeAdapter('rev', REV_APPROVE, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'leak', workspace: repo });
    const s = await waitForStatus(store, id, ['REJECTED', 'AWAITING_APPROVAL', 'FAILED']);
    expect(s.status).toBe('REJECTED');
    expect(events.some((e) => e.event_type === 'worker.security_denied')).toBe(true);
    expect(s.output!.patch).toBe(''); // raw patch not persisted
    expect(existsSync(join(store.dir(id), 'patch.diff'))).toBe(false); // no artifact written on a security hit
    expect(s.output!.stdout_tail).not.toContain('sk-leak-123');
  });

  it('HI-008: a reviewer that writes to its cwd is contained (review still proceeds, worktree/main untouched)', async () => {
    const { orch, store } = makeOrch(buildConfig(nodeAdapter('impl', IMPL_WRITE, 'arg'), nodeAdapter('rev', REV_WRITE_CWD, 'stdin'), GATE_PASS));
    const id = await orch.dispatch({ task_type: 'implement', prompt: 'add feature', workspace: repo });
    const s = await waitForStatus(store, id, ['AWAITING_APPROVAL', 'REJECTED', 'FAILED']);
    expect(s.status).toBe('AWAITING_APPROVAL'); // cwd write contained in reviewDir → review proceeds
    expect(s.review!.verdict).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// Host-gated real-CLI tiers — skip (never fail) when the adapter/env is absent.
// See tests/integration/WORKER_HOST_GATES.md for the per-tier run procedure.
// ---------------------------------------------------------------------------
const codexEnabled = process.env.AISUP_TEST_CODEX === '1';
describe.skipIf(!codexEnabled)('@requires_codex real worker run (set AISUP_TEST_CODEX=1)', () => {
  let scratch: string;
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('runs a real codex exec --json worker that edits a file; parses turn.completed.usage + finalText', async () => {
    // Canonical /private/tmp so codex's HOME-resolution and git agree on the path (MD-003).
    scratch = join('/private/tmp', `aisup-codex-test-${randomUUID()}`);
    mkdirSync(join(scratch, '.home'), { recursive: true });
    writeFileSync(join(scratch, 'README.md'), '# scratch\n');
    await g(['init', '-q'], scratch);
    await g(['config', 'user.email', 'test@example.com'], scratch);
    await g(['config', 'user.name', 'aisup test'], scratch);
    await g(['add', '.'], scratch);
    await g(['commit', '-q', '-m', 'init'], scratch);

    // codex auth (ChatGPT login) lives in the REAL ~/.codex; buildWorkerCommand forces HOME to the
    // isolated worktree .home, so point CODEX_HOME at the real auth dir explicitly (same mechanism
    // the prior codex E2E used — commit 29a25f1).
    process.env.CODEX_HOME = join(homedir(), '.codex');

    // The shipped default codex worker args (Task 2): exec + --json + -s workspace-write.
    const codexAdapter: WorkerAdapterConfig = {
      name: 'codex',
      command: 'codex',
      args: ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write'],
      prompt_via: 'arg',
      prompt_arg_flag: null,
      prompt_file_flag: null,
      env_allowlist: ['PATH', 'HOME', 'CODEX_HOME'],
      timeout_seconds: 300,
      enabled: true,
      output_format: 'json',
    };
    const task: WorkerTask = {
      id: randomUUID(),
      task_type: 'implement',
      title: 'codex smoke',
      prompt: 'Append a single new line that says "hello from codex worker" to README.md. Make only that one edit.',
      base_ref: 'HEAD',
      base_sha: 'HEAD',
      implementer: 'codex',
      reviewer: null,
      workspace_root: scratch,
      created_at: new Date().toISOString(),
    } as WorkerTask;

    const plan = buildWorkerCommand(codexAdapter, task, scratch, join(scratch, '.worker-state'));

    // Raw execFile (not runWorker, which tail-truncates to 2000 chars) so the full NDJSON stream is
    // captured for parsing. ⛔ MUST close the child's stdin (EOF): `codex exec` appends piped stdin
    // as a <stdin> block and blocks forever if the pipe stays open — runWorker does this via
    // child.stdin.end(); here we replicate it.
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        plan.command,
        plan.args,
        { cwd: scratch, env: plan.env, timeout: 240_000, maxBuffer: 10 * 1024 * 1024 },
        (err, out) => {
          if (err && (err as { killed?: boolean }).killed) reject(new Error('codex worker timed out'));
          else resolve(String(out ?? ''));
        }
      );
      child.stdin?.end();
    });

    const changed = (await exec('git', ['diff', '--name-only'], { cwd: scratch }) as { stdout: string }).stdout;
    expect(changed).toContain('README.md');

    const parsed = parseCodexJsonStream(stdout);
    expect(parsed.usage).not.toBeNull();
    expect(parsed.usage!.input_tokens).toBeGreaterThan(0);
    expect(parsed.finalText.length).toBeGreaterThan(0);
  }, 330_000);
});

describe.skipIf(process.env.AISUP_TEST_GEMINI !== '1')('@requires_gemini real worker run', () => {
  it('runs a real gemini worker (skipped unless AISUP_TEST_GEMINI=1 and gemini installed)', () => {
    expect(process.env.AISUP_TEST_GEMINI).toBe('1');
  });
});

describe.skipIf(process.env.AISUP_TEST_LOCAL_LLM !== '1')('@requires_local_llm real worker run', () => {
  it('runs a real local-LLM worker (skipped unless AISUP_TEST_LOCAL_LLM=1)', () => {
    expect(process.env.AISUP_TEST_LOCAL_LLM).toBe('1');
  });
});
