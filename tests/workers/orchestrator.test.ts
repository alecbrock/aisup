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
    auditBoundary: async () => opts.auditOk ?? true,
    sanitizePatch: () => (opts.sanitizeOk ?? true ? { ok: true, violations: [] } : { ok: false, violations: ['forbidden_path:.env'] }),
    patchSha256: () => 'hash',
    removeWorktree: async ({ path }) => { removed.push(path); },
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
