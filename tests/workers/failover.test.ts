import { describe, it, expect } from 'vitest';
import { classifyCandidateFailure, isFailoverWorthy, runCandidateLoop } from '../../src/workers/failover.js';
import type { CandidateLoopHooks } from '../../src/workers/failover.js';
import type { ConcreteCandidate } from '../../src/providers/types.js';
import type { WorkerExecResult } from '../../src/workers/runner.js';

const ok = (): WorkerExecResult => ({ code: 0, stdout: 'done', stderr: '', timedOut: false });
const timeout = (): WorkerExecResult => ({ code: null, stdout: '', stderr: '', timedOut: true });
const unspawnable = (): WorkerExecResult => ({ code: null, stdout: '', stderr: 'ENOENT', timedOut: false });
const rate = (): WorkerExecResult => ({ code: 1, stdout: '', stderr: 'Error 429 too many requests', timedOut: false });
const auth = (): WorkerExecResult => ({ code: 1, stdout: '', stderr: 'authentication failed', timedOut: false });
const taskFail = (): WorkerExecResult => ({ code: 1, stdout: 'tests failed', stderr: 'AssertionError', timedOut: false });

describe('classifyCandidateFailure', () => {
  it('returns null on a clean exit', () => expect(classifyCandidateFailure(ok())).toBeNull());
  it('classifies a timeout', () => expect(classifyCandidateFailure(timeout())).toBe('timed_out'));
  it('classifies an unspawnable run (code null, no timeout)', () => expect(classifyCandidateFailure(unspawnable())).toBe('unspawnable'));
  it('classifies a 429/quota non-zero exit as rate_limited', () => expect(classifyCandidateFailure(rate())).toBe('rate_limited'));
  it('classifies an auth-failure non-zero exit as auth_failed', () => expect(classifyCandidateFailure(auth())).toBe('auth_failed'));
  it('classifies a plain non-zero exit as task_failed', () => expect(classifyCandidateFailure(taskFail())).toBe('task_failed'));
});

describe('isFailoverWorthy', () => {
  it('treats capacity/timeout/unspawnable/auth as failover-worthy (mark unavailable)', () => {
    expect(isFailoverWorthy('timed_out')).toBe(true);
    expect(isFailoverWorthy('unspawnable')).toBe(true);
    expect(isFailoverWorthy('rate_limited')).toBe(true);
    expect(isFailoverWorthy('auth_failed')).toBe(true);
  });
  it('treats a plain task failure as NOT failover-worthy (do not mark unavailable)', () => {
    expect(isFailoverWorthy('task_failed')).toBe(false);
  });
});

const claudeA: ConcreteCandidate = { provider: 'claude', account: 'a1' };
const claudeB: ConcreteCandidate = { provider: 'claude', account: 'a2' };
const codex: ConcreteCandidate = { provider: 'codex' };

interface Recorder {
  hooks: CandidateLoopHooks;
  created: string[];
  removed: string[];
  failed: { candidate: ConcreteCandidate; kind: string }[];
  failovers: { from: ConcreteCandidate; to: ConcreteCandidate }[];
  marked: ConcreteCandidate[];
  cleanupErrors: { worktree: string; error: string }[];
}

function recorder(opts: {
  run: (c: ConcreteCandidate) => WorkerExecResult;
  auditOk?: (c: ConcreteCandidate, i: number) => boolean;
  removeThrows?: (wt: string) => boolean;
  cancelAfter?: number; // cancel once this many candidates have been created
}): Recorder {
  const created: string[] = [];
  const removed: string[] = [];
  const failed: { candidate: ConcreteCandidate; kind: string }[] = [];
  const failovers: { from: ConcreteCandidate; to: ConcreteCandidate }[] = [];
  const marked: ConcreteCandidate[] = [];
  const cleanupErrors: { worktree: string; error: string }[] = [];
  let auditIdx = 0;

  const hooks: CandidateLoopHooks = {
    createWorktree: async (_c, i) => { const wt = `wt-${i}`; created.push(wt); return wt; },
    runCandidate: async (c) => opts.run(c),
    auditBoundary: async () => (opts.auditOk ? opts.auditOk({} as ConcreteCandidate, auditIdx++) : true),
    removeWorktree: async (wt) => { if (opts.removeThrows?.(wt)) throw new Error('rm failed'); removed.push(wt); },
    markUnavailable: (c) => { marked.push(c); },
    isCancelled: () => opts.cancelAfter !== undefined && created.length >= opts.cancelAfter,
    onCandidateFailed: async (c, kind) => { failed.push({ candidate: c, kind }); },
    onFailover: async (from, to) => { failovers.push({ from, to }); },
    onCleanupError: async (worktree, error) => { cleanupErrors.push({ worktree, error }); },
  };
  return { hooks, created, removed, failed, failovers, marked, cleanupErrors };
}

describe('runCandidateLoop', () => {
  it('fails over a 429 first candidate to the next and returns success on it', async () => {
    const r = recorder({ run: (c) => (c.account === 'a1' ? rate() : ok()) });
    const out = await runCandidateLoop([claudeA, claudeB], r.hooks);
    expect(out.kind).toBe('success');
    if (out.kind === 'success') expect(out.candidate).toEqual(claudeB);
    expect(r.failed).toEqual([{ candidate: claudeA, kind: 'rate_limited' }]);
    expect(r.failovers).toEqual([{ from: claudeA, to: claudeB }]);
    expect(r.marked).toEqual([claudeA]); // failover-worthy → marked unavailable
    expect(r.removed).toEqual(['wt-0']); // first worktree cleaned before the second
  });

  it('exhausts all candidates and removes every worktree (no stale subdirs)', async () => {
    const r = recorder({ run: () => rate() });
    const out = await runCandidateLoop([claudeA, claudeB, codex], r.hooks);
    expect(out.kind).toBe('exhausted');
    if (out.kind === 'exhausted') expect(out.tried).toEqual([claudeA, claudeB, codex]);
    expect(r.removed).toEqual(['wt-0', 'wt-1', 'wt-2']); // including the last candidate's
  });

  it('a boundary violation on a failed candidate is terminal with NO failover', async () => {
    const r = recorder({ run: () => rate(), auditOk: (_c, i) => i !== 0 });
    const out = await runCandidateLoop([claudeA, claudeB], r.hooks);
    expect(out.kind).toBe('boundary_violation');
    if (out.kind === 'boundary_violation') expect(out.candidate).toEqual(claudeA);
    expect(r.failovers).toEqual([]); // no failover after a boundary violation
    expect(r.failed).toEqual([]); // terminal before candidate_failed/cleanup
  });

  it('a removeWorktree error is reported but does not block the next candidate', async () => {
    const r = recorder({ run: (c) => (c.account === 'a1' ? rate() : ok()), removeThrows: (wt) => wt === 'wt-0' });
    const out = await runCandidateLoop([claudeA, claudeB], r.hooks);
    expect(out.kind).toBe('success');
    expect(r.cleanupErrors).toEqual([{ worktree: 'wt-0', error: 'rm failed' }]);
    expect(r.failovers).toEqual([{ from: claudeA, to: claudeB }]); // still advanced
  });

  it('a plain task failure advances but does NOT mark the candidate unavailable', async () => {
    const r = recorder({ run: (c) => (c.account === 'a1' ? taskFail() : ok()) });
    const out = await runCandidateLoop([claudeA, claudeB], r.hooks);
    expect(out.kind).toBe('success');
    expect(r.failed).toEqual([{ candidate: claudeA, kind: 'task_failed' }]);
    expect(r.marked).toEqual([]); // task failure is not a capacity signal
  });

  it('honors cancellation between candidates', async () => {
    const r = recorder({ run: () => rate(), cancelAfter: 1 });
    const out = await runCandidateLoop([claudeA, claudeB], r.hooks);
    // first candidate runs, fails, then cancellation is observed before the second is created
    expect(out.kind).toBe('cancelled');
  });
});
