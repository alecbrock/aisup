import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewWorkerOutput, buildReviewPrompt } from '../../src/workers/review.js';
import { patchSha256 } from '../../src/workers/worktree.js';
import type { WorkerExec } from '../../src/workers/runner.js';
import type { WorkerAdapterConfig, WorkerReviewConfig } from '../../src/config/schema.js';
import type { WorkerTask, WorkerOutput } from '../../src/workers/types.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';

function spyJournal(): { journal: JournalWriter; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return { events, journal: { append: async (e) => { events.push(e); } } };
}

function reviewerAdapter(partial: Partial<WorkerAdapterConfig> = {}): WorkerAdapterConfig {
  return {
    name: 'gemini',
    command: 'gemini',
    args: [],
    prompt_via: 'stdin',
    prompt_arg_flag: null,
    prompt_file_flag: null,
    env_allowlist: ['PATH'],
    timeout_seconds: 30,
    enabled: true,
    ...partial,
  };
}

const review: WorkerReviewConfig = { allow_same_model_review: false };

function makeCtx(root: string): { workspaceRoot: string; worktreePath: string; reviewDir: string; output: WorkerOutput; task: WorkerTask } {
  const workspaceRoot = join(root, 'repo');
  const worktreePath = join(workspaceRoot, '.aisup-workers', 'tid');
  const reviewDir = join(root, 'state', 'review');
  const stateDir = join(root, 'state');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });
  const patch = 'diff --git a/x.ts b/x.ts\n--- /dev/null\n+++ b/x.ts\n+export const x = 1;\n';
  const patchPath = join(stateDir, 'patch.diff');
  writeFileSync(patchPath, patch);
  const output: WorkerOutput = {
    exit_code: 0,
    timed_out: false,
    stdout_tail: '',
    stderr_tail: '',
    patch,
    patch_path: patchPath,
    patch_sha256: patchSha256(patch),
    patch_bytes: Buffer.byteLength(patch),
    changed_files: ['x.ts'],
    boundary_ok: true,
  };
  const task: WorkerTask = {
    id: 'tid',
    task_type: 'implement',
    title: 't',
    prompt: 'do x',
    base_ref: 'HEAD',
    base_sha: 'sha',
    implementer: 'codex',
    reviewer: 'gemini',
    workspace_root: workspaceRoot,
    created_at: 'now',
    updated_at: 'now',
  };
  return { workspaceRoot, worktreePath, reviewDir, output, task };
}

const approveRunner: WorkerExec = async () => ({ code: 0, stdout: 'Looks correct.\nVERDICT: APPROVE', stderr: '', timedOut: false });
const rejectRunner: WorkerExec = async () => ({ code: 0, stdout: 'Found a subtle bug.\nVERDICT: REJECT', stderr: '', timedOut: false });
const garbageRunner: WorkerExec = async () => ({ code: 0, stdout: 'I am not sure, here are some thoughts...', stderr: '', timedOut: false });

describe('reviewWorkerOutput', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aisup-review-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('buildReviewPrompt embeds the patch and instructs the strict VERDICT format', () => {
    const { task, output } = makeCtx(root);
    const prompt = buildReviewPrompt(task, output.patch);
    expect(prompt).toContain('export const x = 1;');
    expect(prompt).toMatch(/VERDICT:\s*APPROVE/);
    expect(prompt).toMatch(/VERDICT:\s*REJECT/);
  });

  it('a fake reviewer that approves yields verdict:approve + worker.review_passed', async () => {
    const ctx = makeCtx(root);
    const { journal, events } = spyJournal();
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter(), review, journal, runner: approveRunner });
    expect(v.verdict).toBe('approve');
    expect(events.some((e) => e.event_type === 'worker.review_passed')).toBe(true);
  });

  it('a fake reviewer that rejects a seeded-bug patch yields verdict:reject + worker.review_failed', async () => {
    const ctx = makeCtx(root);
    const { journal, events } = spyJournal();
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter(), review, journal, runner: rejectRunner });
    expect(v.verdict).toBe('reject');
    expect(events.some((e) => e.event_type === 'worker.review_failed')).toBe(true);
  });

  it('same-model reviewer with allow_same_model_review:false rejects + worker.review_degraded WITHOUT running the model', async () => {
    const ctx = makeCtx(root);
    const { journal, events } = spyJournal();
    let ran = false;
    const trap: WorkerExec = async () => { ran = true; return { code: 0, stdout: 'VERDICT: APPROVE', stderr: '', timedOut: false }; };
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter({ name: 'codex' }), review, journal, runner: trap });
    expect(v.verdict).toBe('reject');
    expect(v.degraded).toBe(true);
    expect(ran).toBe(false);
    expect(events.some((e) => e.event_type === 'worker.review_degraded')).toBe(true);
  });

  it('unparseable reviewer output fails closed to reject (no config can make it approve)', async () => {
    const ctx = makeCtx(root);
    const { journal, events } = spyJournal();
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter(), review, journal, runner: garbageRunner });
    expect(v.verdict).toBe('reject');
    const failed = events.find((e) => e.event_type === 'worker.review_failed');
    expect(failed?.details.reason).toBe('parse_failed');
  });

  it('a reviewer cwd-write is contained (worktree/main/patch_sha256 unchanged) → review proceeds', async () => {
    const ctx = makeCtx(root);
    const { journal } = spyJournal();
    const cwdWriteRunner: WorkerExec = async (_c, _a, opts) => {
      writeFileSync(join(opts.cwd, 'reviewer-side-effect.txt'), 'scratch');
      return { code: 0, stdout: 'VERDICT: APPROVE', stderr: '', timedOut: false };
    };
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter(), review, journal, runner: cwdWriteRunner });
    expect(v.verdict).toBe('approve'); // write contained in reviewDir → not flagged
    expect(existsSync(join(ctx.reviewDir, 'reviewer-side-effect.txt'))).toBe(true);
  });

  it('a reviewer that writes into the implementation worktree fails closed with reviewer_side_effect', async () => {
    const ctx = makeCtx(root);
    const { journal, events } = spyJournal();
    const escapeRunner: WorkerExec = async () => {
      writeFileSync(join(ctx.worktreePath, 'sneaky.ts'), 'leak');
      return { code: 0, stdout: 'VERDICT: APPROVE', stderr: '', timedOut: false };
    };
    const v = await reviewWorkerOutput({ ...ctx, reviewerAdapter: reviewerAdapter(), review, journal, runner: escapeRunner });
    expect(v.verdict).toBe('reject');
    const failed = events.find((e) => e.event_type === 'worker.review_failed');
    expect(failed?.details.reason).toBe('reviewer_side_effect');
  });
});
