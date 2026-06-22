import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import type { OrchestratorDeps, WorktreeOps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import { CONFIG_DEFAULTS } from '../../src/config/defaults.js';
import type { WorkersConfig } from '../../src/config/schema.js';
import type { WorkerExec } from '../../src/workers/runner.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';
import type { ConcreteCandidate } from '../../src/providers/types.js';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';
import { AccountRegistry } from '../../src/accounts/registry.js';
import { ClaudeProviderUsage } from '../../src/providers/claude-usage.js';
import { CodexProviderUsage } from '../../src/providers/codex-usage.js';
import { resolveCandidates } from '../../src/providers/selector.js';
import type { AisupConfig, RoleCandidateConfig, AccountConfig } from '../../src/config/schema.js';

function spyJournal(): { journal: JournalWriter; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return { events, journal: { append: async (e) => { events.push(e); } } };
}

function workersConfig(over: Partial<WorkersConfig> = {}): WorkersConfig {
  const base = JSON.parse(JSON.stringify(CONFIG_DEFAULTS.workers)) as WorkersConfig;
  base.enabled = true;
  base.adapters.codex.enabled = true;
  base.adapters.gemini.enabled = true;
  return { ...base, ...over };
}

async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  orch: WorkerOrchestrator;
  store: WorkerStore;
  events: JournalEvent[];
  removed: string[];
}

function makeHarness(opts: {
  config?: WorkersConfig;
  runImplementer?: WorkerExec;
  auditOk?: boolean;
  sanitizeOk?: boolean;
  validationPassed?: boolean;
  reviewVerdict?: 'approve' | 'reject';
  mergeMerged?: boolean;
  validateOutput?: OrchestratorDeps['validateOutput'];
  reviewOutput?: OrchestratorDeps['reviewOutput'];
  mergeOutput?: OrchestratorDeps['mergeOutput'];
  resolveCwd?: () => string | null;
  selectCandidates?: OrchestratorDeps['selectCandidates'];
  recordCodexUsage?: OrchestratorDeps['recordCodexUsage'];
  markCandidateUnavailable?: OrchestratorDeps['markCandidateUnavailable'];
  getClaudeAccountConfigDir?: OrchestratorDeps['getClaudeAccountConfigDir'];
  resolvePinnedClaude?: OrchestratorDeps['resolvePinnedClaude'];
  removeWorktreeImpl?: (path: string) => Promise<void>;
  auditBoundaryImpl?: () => Promise<boolean>;
  stateDir: string;
}): Harness {
  const { journal, events } = spyJournal();
  const store = new WorkerStore(opts.stateDir);
  const removed: string[] = [];
  let wtCounter = 0;

  const worktreeOps: WorktreeOps = {
    resolveBaseSha: async () => 'basesha000000000000000000000000000000000',
    createWorktree: async ({ taskId }) => {
      const p = join(opts.stateDir, 'wt', `${taskId}-${wtCounter++}`);
      mkdirSync(join(p, '.home'), { recursive: true });
      return p;
    },
    captureDiff: async () => ({ patch: 'diff --git a/x b/x\n+x\n', changedFiles: ['x.ts'] }),
    snapshotMainTree: async () => ({ status: '', forbidden: {} }),
    auditBoundary: opts.auditBoundaryImpl ? () => opts.auditBoundaryImpl!() : async () => opts.auditOk ?? true,
    sanitizePatch: () => (opts.sanitizeOk ?? true ? { ok: true, violations: [] } : { ok: false, violations: ['forbidden_path:.env'] }),
    patchSha256: () => 'hash',
    removeWorktree: async ({ path }) => { if (opts.removeWorktreeImpl) await opts.removeWorktreeImpl(path); removed.push(path); },
    isGitRepo: async () => true,
    applyCheck: async () => true,
    applyReverseCheck: async () => false,
  };

  const deps: OrchestratorDeps = {
    store,
    config: opts.config ?? workersConfig(),
    journal,
    worktreeOps,
    runImplementer: opts.runImplementer ?? (async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false })),
    validateOutput: opts.validateOutput ?? (async () => ({ passed: opts.validationPassed ?? true, failed_gates: opts.validationPassed === false ? ['unit'] : [] })),
    reviewOutput: opts.reviewOutput ?? (async () => ({ reviewer: 'gemini', verdict: opts.reviewVerdict ?? 'approve', degraded: false, findings: [], raw_output_tail: '' })),
    mergeOutput: opts.mergeOutput ?? (async () => ({ merged: opts.mergeMerged ?? true, reason: null, resetApproval: false })),
    resolveActiveSessionCwd: opts.resolveCwd ?? (() => '/repo'),
    selectCandidates: opts.selectCandidates,
    recordCodexUsage: opts.recordCodexUsage,
    markCandidateUnavailable: opts.markCandidateUnavailable,
    getClaudeAccountConfigDir: opts.getClaudeAccountConfigDir,
    resolvePinnedClaude: opts.resolvePinnedClaude,
  };

  return { orch: new WorkerOrchestrator(deps), store, events, removed };
}

describe('WorkerOrchestrator', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-orch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('dispatch returns the id before the pipeline completes, then advances to AWAITING_APPROVAL; approve → MERGED (MD-002)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runImplementer: WorkerExec = async () => { await gate; return { code: 0, stdout: 'done', stderr: '', timedOut: false }; };
    const h = makeHarness({ stateDir: dir, runImplementer });

    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'do it' });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await waitFor(() => h.store.read(id)?.status === 'RUNNING');
    expect(h.store.read(id)!.status).toBe('RUNNING'); // pipeline still in-flight, dispatch already returned

    release();
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    const res = await h.orch.approve(id, 'user');
    expect(res.ok).toBe(true);
    expect(h.store.read(id)!.status).toBe('MERGED');
    const types = h.events.map((e) => e.event_type);
    expect(types).toContain('worker.queued');
    expect(types).toContain('worker.dispatched');
    expect(types).toContain('worker.completed');
    expect(types).toContain('worker.awaiting_approval');
    expect(types).toContain('worker.approved');
  });

  it('deny → REJECTED; cancel of a terminal worker is refused', async () => {
    const h = makeHarness({ stateDir: dir });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    const denied = await h.orch.deny(id, 'user');
    expect(denied.ok).toBe(true);
    expect(h.store.read(id)!.status).toBe('REJECTED');
    const cancel = await h.orch.cancel(id);
    expect(cancel.ok).toBe(false); // already terminal
  });

  it('a gate failure stops at REJECTED before approval', async () => {
    const h = makeHarness({ stateDir: dir, validationPassed: false });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'REJECTED');
    expect(h.store.read(id)!.status).toBe('REJECTED');
    expect(h.store.read(id)!.error_summary).toBe('validation_failed');
  });

  it('a boundary violation stops at FAILED', async () => {
    const h = makeHarness({ stateDir: dir, auditOk: false });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'FAILED');
    expect(h.events.some((e) => e.event_type === 'worker.boundary_violation')).toBe(true);
  });

  it('a sanitizer hit stops at REJECTED and persists no raw patch/tails (HI-002)', async () => {
    const h = makeHarness({ stateDir: dir, sanitizeOk: false });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'REJECTED');
    const out = h.store.read(id)!.output!;
    expect(out.patch).toBe(''); // raw patch not persisted
    expect(out.stdout_tail).not.toContain('ok');
    expect(h.events.find((e) => e.event_type === 'worker.security_denied')?.details.violations).toBeTruthy();
  });

  it('dispatch resolves workspace via the active session cwd, and rejects when none resolves (LO-005)', async () => {
    const ok = makeHarness({ stateDir: dir, resolveCwd: () => '/repo' });
    await expect(ok.orch.dispatch({ task_type: 'implement', prompt: 'p' })).resolves.toMatch(/[0-9a-f-]{36}/);

    const none = makeHarness({ stateDir: join(dir, 'b'), resolveCwd: () => null, config: workersConfig({ workspace_root: null }) });
    await expect(none.orch.dispatch({ task_type: 'implement', prompt: 'p' })).rejects.toThrow(/workspace_root/i);
  });

  it('respects max_concurrent: a 3rd worker stays QUEUED until a slot frees (MD-002)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const runImplementer: WorkerExec = async () => { started++; await gate; return { code: 0, stdout: '', stderr: '', timedOut: false }; };
    const h = makeHarness({ stateDir: dir, runImplementer, config: workersConfig({ max_concurrent: 2 }) });

    const ids = [
      await h.orch.dispatch({ task_type: 'implement', prompt: 'a' }),
      await h.orch.dispatch({ task_type: 'implement', prompt: 'b' }),
      await h.orch.dispatch({ task_type: 'implement', prompt: 'c' }),
    ];
    await waitFor(() => started === 2);
    expect(h.store.read(ids[2])!.status).toBe('QUEUED'); // 3rd held back

    release();
    await waitFor(() => h.store.read(ids[2])?.status === 'AWAITING_APPROVAL');
    expect(started).toBe(3); // pumped once a slot freed
  });

  it('cancel during RUNNING ends CANCELLED, frees the slot, cleans up, and a late completion does not resurrect it (MD-006)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    const runImplementer: WorkerExec = async () => { started++; await gate; return { code: 0, stdout: '', stderr: '', timedOut: false }; };
    const h = makeHarness({
      stateDir: dir,
      runImplementer,
      config: workersConfig({ max_concurrent: 1, retention: { keep_merged: false, keep_rejected: false, max_age_hours: 168 } }),
    });

    const id1 = await h.orch.dispatch({ task_type: 'implement', prompt: 'a' });
    await waitFor(() => h.store.read(id1)?.status === 'RUNNING');
    const cancelled = await h.orch.cancel(id1);
    expect(cancelled.ok).toBe(true);
    expect(h.store.read(id1)!.status).toBe('CANCELLED');

    // slot freed → a second worker can start despite the first subprocess still "running"
    const id2 = await h.orch.dispatch({ task_type: 'implement', prompt: 'b' });
    await waitFor(() => started === 2);

    release();
    await waitFor(() => h.store.read(id2)?.status === 'AWAITING_APPROVAL');
    expect(h.store.read(id1)!.status).toBe('CANCELLED'); // late completion did NOT resurrect
    expect(h.events.some((e) => e.event_type === 'worker.cleanup' && e.details.worker_task_id === id1)).toBe(true);
    expect(h.removed.length).toBeGreaterThan(0); // worktree removed (keep_rejected:false)
  });

  it('cancel during VALIDATING is not clobbered by a failing gate result — stays CANCELLED (MD-006)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const validateOutput: OrchestratorDeps['validateOutput'] = async () => { await gate; return { passed: false, failed_gates: ['unit'] }; };
    const h = makeHarness({ stateDir: dir, validateOutput });

    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'VALIDATING');
    const cancelled = await h.orch.cancel(id);
    expect(cancelled.ok).toBe(true);
    expect(h.store.read(id)!.status).toBe('CANCELLED');

    release(); // a failing validation now resolves into the cancelled worker — it must be discarded
    await waitFor(() => h.events.some((e) => e.event_type === 'worker.cleanup' && e.details.worker_task_id === id));
    expect(h.store.read(id)!.status).toBe('CANCELLED'); // NOT REJECTED
    expect(h.store.read(id)!.error_summary).not.toBe('validation_failed');
  });

  it('cancel during REVIEWING is not clobbered by a rejecting review — stays CANCELLED (MD-006)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reviewOutput: OrchestratorDeps['reviewOutput'] = async () => { await gate; return { reviewer: 'gemini', verdict: 'reject', degraded: false, findings: [], raw_output_tail: '' }; };
    const h = makeHarness({ stateDir: dir, reviewOutput });

    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'REVIEWING');
    const cancelled = await h.orch.cancel(id);
    expect(cancelled.ok).toBe(true);
    expect(h.store.read(id)!.status).toBe('CANCELLED');

    release(); // a rejecting review now resolves into the cancelled worker — it must be discarded
    await waitFor(() => h.events.some((e) => e.event_type === 'worker.cleanup' && e.details.worker_task_id === id));
    expect(h.store.read(id)!.status).toBe('CANCELLED'); // NOT REJECTED
    expect(h.store.read(id)!.error_summary).not.toBe('review_rejected');
  });

  it('concurrent approve merges exactly once; the loser observes MERGING and is rejected (no double-apply)', async () => {
    let mergeCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const mergeOutput: OrchestratorDeps['mergeOutput'] = async () => { mergeCalls++; await gate; return { merged: true, reason: null, resetApproval: false }; };
    const h = makeHarness({ stateDir: dir, mergeOutput });

    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');

    const p1 = h.orch.approve(id, 'u1');
    const p2 = h.orch.approve(id, 'u2');
    release();
    const results = await Promise.all([p1, p2]);

    expect(mergeCalls).toBe(1); // the patch was applied only once
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.reason).toBe('not_awaiting_approval');
    expect(h.store.read(id)!.status).toBe('MERGED'); // not reset back to AWAITING_APPROVAL
  });
});

const claudeCand = (account: string): ConcreteCandidate => ({ provider: 'claude', account, model: null, effort: null });
const codexCand = (): ConcreteCandidate => ({ provider: 'codex', model: null, effort: null });
const r429 = (): { code: number; stdout: string; stderr: string; timedOut: boolean } => ({ code: 1, stdout: '', stderr: 'Error 429 too many requests', timedOut: false });
const rOk = (): { code: number; stdout: string; stderr: string; timedOut: boolean } => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false });

describe('WorkerOrchestrator multi-provider failover (Part B)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-orch-fo-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a 429 on the first implementer candidate fails over to the next and reaches AWAITING_APPROVAL', async () => {
    let call = 0;
    const runImplementer: WorkerExec = async () => (++call === 1 ? r429() : rOk());
    const marks: ConcreteCandidate[] = [];
    const h = makeHarness({
      stateDir: dir, runImplementer,
      selectCandidates: (role) => (role === 'implementer' ? [claudeCand('a1'), claudeCand('a2')] : [codexCand()]),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
      markCandidateUnavailable: (c) => { marks.push(c); },
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    const idx = (t: string): number => h.events.findIndex((e) => e.event_type === t);
    expect(idx('worker.candidate_failed')).toBeGreaterThanOrEqual(0);
    expect(idx('worker.candidate_failed')).toBeLessThan(idx('worker.failover'));
    expect(idx('worker.failover')).toBeLessThan(idx('worker.awaiting_approval'));
    expect(marks).toEqual([claudeCand('a1')]); // failover-worthy → first candidate marked unavailable
    expect(h.removed.length).toBe(1); // first candidate's worktree cleaned before the second
  });

  it('all candidates failing ends FAILED with all_candidates_exhausted and no stale worktrees', async () => {
    const h = makeHarness({
      stateDir: dir, runImplementer: async () => r429(),
      selectCandidates: () => [claudeCand('a1'), codexCand()],
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'FAILED');
    expect(h.store.read(id)!.error_summary).toBe('all_candidates_exhausted');
    expect(h.events.find((e) => e.event_type === 'worker.all_candidates_exhausted')?.details.tried).toEqual(['claude:a1', 'codex']);
    expect(h.removed.length).toBe(2); // every candidate's worktree removed
  });

  it('a removeWorktree failure mid-loop emits worker.worktree_cleanup_error and does not block the next candidate', async () => {
    let call = 0;
    const h = makeHarness({
      stateDir: dir, runImplementer: async () => (++call === 1 ? r429() : rOk()),
      selectCandidates: (role) => (role === 'implementer' ? [claudeCand('a1'), claudeCand('a2')] : [codexCand()]),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
      removeWorktreeImpl: async () => { throw new Error('rm boom'); },
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    const ce = h.events.find((e) => e.event_type === 'worker.worktree_cleanup_error');
    expect(ce?.details.error).toContain('rm boom');
  });

  for (const [label, result] of [
    ['429', r429()],
    ['non-zero', { code: 1, stdout: 'fail', stderr: 'AssertionError', timedOut: false }],
    ['timeout', { code: null, stdout: '', stderr: '', timedOut: true }],
  ] as const) {
    it(`a ${label} candidate that mutated the main tree is terminal (boundary_violation, no failover)`, async () => {
      const h = makeHarness({
        stateDir: dir, runImplementer: async () => result,
        selectCandidates: () => [claudeCand('a1'), claudeCand('a2')],
        getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
        auditBoundaryImpl: async () => false, // main tree mutated
      });
      const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
      await waitFor(() => h.store.read(id)?.status === 'FAILED');
      expect(h.events.some((e) => e.event_type === 'worker.boundary_violation')).toBe(true);
      expect(h.events.some((e) => e.event_type === 'worker.failover')).toBe(false);
      expect(h.events.some((e) => e.event_type === 'worker.candidate_failed')).toBe(false);
    });
  }

  it('the reviewer falls over to a Claude account when codex is unavailable', async () => {
    let capturedName: string | undefined;
    let capturedFormat: string | undefined;
    const reviewOutput: OrchestratorDeps['reviewOutput'] = async (o) => {
      capturedName = o.reviewerOverride?.name;
      capturedFormat = o.reviewerOverride?.format;
      return { reviewer: 'x', verdict: 'approve', degraded: false, findings: [], raw_output_tail: '' };
    };
    const h = makeHarness({
      stateDir: dir, reviewOutput, runImplementer: async () => rOk(),
      selectCandidates: (role) => (role === 'implementer' ? [codexCand()] : [claudeCand('rev1')]),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(capturedName).toBe('claude:rev1');
    expect(capturedFormat).toBe('claude-json');
  });

  it('the reviewer fails over at run time when the first reviewer candidate hits a 429', async () => {
    let revCall = 0;
    const reviewOutput: OrchestratorDeps['reviewOutput'] = async (o) => {
      revCall++;
      const name = o.reviewerOverride?.name ?? o.reviewerAdapter?.name ?? '?';
      if (revCall === 1) return { reviewer: name, verdict: 'reject', degraded: false, findings: [], raw_output_tail: '429', run_failure: 'rate_limited' };
      return { reviewer: name, verdict: 'approve', degraded: false, findings: [], raw_output_tail: '', run_failure: null };
    };
    const marks: ConcreteCandidate[] = [];
    const h = makeHarness({
      stateDir: dir, reviewOutput, runImplementer: async () => rOk(),
      selectCandidates: (role) => (role === 'implementer' ? [codexCand()] : [codexCand(), claudeCand('rev1')]),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
      markCandidateUnavailable: (c) => { marks.push(c); },
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(revCall).toBe(2); // failed the codex reviewer over to the claude reviewer
    expect(marks).toEqual([codexCand()]); // the 429 reviewer was marked unavailable
    expect(h.events.some((e) => e.event_type === 'worker.candidate_failed' && e.details.role === 'reviewer')).toBe(true);
    expect(h.events.some((e) => e.event_type === 'worker.failover' && e.details.role === 'reviewer' && e.details.cross_provider === true)).toBe(true);
  });

  it('a genuine reviewer reject (no capacity failure) does NOT fail over', async () => {
    let revCall = 0;
    const reviewOutput: OrchestratorDeps['reviewOutput'] = async (o) => {
      revCall++;
      return { reviewer: o.reviewerAdapter?.name ?? '?', verdict: 'reject', degraded: false, findings: [], raw_output_tail: 'VERDICT: REJECT', run_failure: null };
    };
    const h = makeHarness({
      stateDir: dir, reviewOutput, runImplementer: async () => rOk(),
      selectCandidates: (role) => (role === 'implementer' ? [codexCand()] : [codexCand(), claudeCand('rev1')]),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'REJECTED');
    expect(revCall).toBe(1); // a real reject ends the loop — no reviewer failover
  });

  it('a codex run records its chargeable token usage into the budget meter', async () => {
    const usage: { provider: string; tokens: number }[] = [];
    const stdout = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":0}}',
    ].join('\n');
    const h = makeHarness({
      stateDir: dir, runImplementer: async () => ({ code: 0, stdout, stderr: '', timedOut: false }),
      selectCandidates: () => [codexCand()],
      recordCodexUsage: (provider, tokens) => { usage.push({ provider, tokens }); },
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(usage).toEqual([{ provider: 'codex', tokens: 150 }]);
  });

  it('an explicit adapter --implementer pins a single candidate (no failover)', async () => {
    let calls = 0;
    const h = makeHarness({
      stateDir: dir, runImplementer: async () => { calls++; return r429(); },
      selectCandidates: () => [codexCand(), { provider: 'gemini', model: null, effort: null }], // would fail over if not pinned
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p', implementer: 'codex' });
    await waitFor(() => h.store.read(id)?.status === 'FAILED');
    expect(calls).toBe(1); // pinned → one candidate only
  });

  it('an unsupported --implementer override fails fast with a dispatch validation error', async () => {
    const h = makeHarness({ stateDir: dir, selectCandidates: () => [codexCand()] });
    await expect(h.orch.dispatch({ task_type: 'implement', prompt: 'p', implementer: 'gpt5' }))
      .rejects.toThrow(/--implementer "gpt5" is not 'claude' or a defined adapter/);
  });

  it('a pinned --implementer claude resolves to a concrete account and launches claude with CLAUDE_CONFIG_DIR', async () => {
    let capturedCmd: string | undefined;
    let capturedEnv: Record<string, string> | undefined;
    const runImplementer: WorkerExec = async (cmd, _args, opts) => { capturedCmd = cmd; capturedEnv = opts.env; return rOk(); };
    const h = makeHarness({
      stateDir: dir, runImplementer,
      selectCandidates: (role) => (role === 'implementer' ? [codexCand()] : [codexCand()]), // role list is codex; the pin overrides to claude
      resolvePinnedClaude: () => claudeCand('acctX'),
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p', implementer: 'claude' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(capturedCmd).toBe('claude');
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe('/cfg/acctX');
  });

  it('a pinned --implementer claude with no available account exhausts (no concrete account to launch)', async () => {
    const h = makeHarness({
      stateDir: dir,
      selectCandidates: () => [codexCand()],
      resolvePinnedClaude: () => null,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p', implementer: 'claude' });
    await waitFor(() => h.store.read(id)?.status === 'FAILED');
    expect(h.store.read(id)!.error_summary).toBe('all_candidates_exhausted');
  });

  it('runs the failover loop once per RESOLVED candidate, not per account', async () => {
    // selectCandidates resolves to a SINGLE candidate even if more accounts exist — the loop runs once.
    let calls = 0;
    const h = makeHarness({
      stateDir: dir, runImplementer: async () => { calls++; return r429(); },
      selectCandidates: () => [claudeCand('a1')],
      getClaudeAccountConfigDir: (a) => `/cfg/${a}`,
    });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'FAILED');
    expect(calls).toBe(1);
    expect(h.removed.length).toBe(1);
  });
});

// Wire selectCandidates exactly as the daemon does, from a REAL UsageLedger + AccountRegistry +
// provider-usage signals + the pure selector — proving the daemon's glue produces a working selector.
const codexRole = (budget: RoleCandidateConfig['budget'] = null): RoleCandidateConfig => ({ provider: 'codex', model: null, effort: null, budget });
const claudeRole = (): RoleCandidateConfig => ({ provider: 'claude', model: null, effort: null, budget: null });
const acct = (name: string): AccountConfig => ({ name, config_dir: `/cfg/${name}`, priority: 1, enabled: true });

function daemonSelect(opts: { implementer: RoleCandidateConfig[]; reviewer: RoleCandidateConfig[]; accounts: AccountConfig[]; ledgerPath: string }): {
  selectCandidates: OrchestratorDeps['selectCandidates'];
  getClaudeAccountConfigDir: OrchestratorDeps['getClaudeAccountConfigDir'];
} {
  const ledger = new UsageLedger(opts.ledgerPath, 60_000);
  const registry = new AccountRegistry({ accounts: opts.accounts } as AisupConfig);
  const claudeUsage = new ClaudeProviderUsage({
    ledger,
    getAccount: (name) => {
      const a = registry.get(name);
      return a ? { name: a.name, enabled: a.enabled, inCooldown: false, reactivelyUnavailable: false } : null;
    },
  });
  const codexUsage = new CodexProviderUsage({ ledger, budget: null });
  const accounts = registry.getAll().map((a) => ({ name: a.name, enabled: a.enabled }));
  return {
    selectCandidates: (role) => resolveCandidates(role === 'implementer' ? opts.implementer : opts.reviewer, { claudeUsage, codexUsage, accounts }, Date.now()),
    getClaudeAccountConfigDir: (name) => registry.get(name)?.configDir ?? null,
  };
}

describe('WorkerOrchestrator daemon provider wiring (Task 8)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-orch-wire-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves a single-codex roles config and dispatches end-to-end (back-compat)', async () => {
    const wired = daemonSelect({ implementer: [codexRole()], reviewer: [{ provider: 'gemini', model: null, effort: null, budget: null }], accounts: [], ledgerPath: join(dir, 'ledger.json') });
    const h = makeHarness({ stateDir: dir, runImplementer: async () => rOk(), ...wired });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(h.store.read(id)!.status).toBe('AWAITING_APPROVAL');
  });

  it('expands claude accounts (account-first) and fails over a 429 to the next account', async () => {
    let call = 0;
    const wired = daemonSelect({ implementer: [claudeRole(), codexRole()], reviewer: [codexRole()], accounts: [acct('a1'), acct('a2')], ledgerPath: join(dir, 'ledger.json') });
    const h = makeHarness({ stateDir: dir, runImplementer: async () => (++call === 1 ? r429() : rOk()), ...wired });
    const id = await h.orch.dispatch({ task_type: 'implement', prompt: 'p' });
    await waitFor(() => h.store.read(id)?.status === 'AWAITING_APPROVAL');
    expect(h.events.some((e) => e.event_type === 'worker.candidate_failed')).toBe(true);
    expect(h.events.some((e) => e.event_type === 'worker.failover')).toBe(true);
  });
});
