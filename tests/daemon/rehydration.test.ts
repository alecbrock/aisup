/**
 * Deterministic fixture tests for rehydration recovery.
 * Uses vi.mock for tmux operations and real filesystem for state files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock tmux operations before importing rehydration
vi.mock('../../src/session/tmux.js', () => ({
  isPipePaneActive: vi.fn().mockReturnValue(true),
  startOutputLog: vi.fn(),
  isProcessDead: vi.fn().mockReturnValue(false),
  destroyTmuxSession: vi.fn(),
  listSessions: vi.fn().mockReturnValue([]),
  createTmuxSession: vi.fn().mockResolvedValue(undefined),
  stopPipePane: vi.fn(),
  sendInterrupt: vi.fn(),
  sendEnter: vi.fn(),
  sendText: vi.fn(),
  sendControl: vi.fn(),
  captureOutput: vi.fn().mockReturnValue(''),
  getSessionId: vi.fn().mockReturnValue('$1'),
  getPaneId: vi.fn().mockReturnValue('%1'),
  respawnPane: vi.fn(),
  getPaneDeadStatus: vi.fn().mockReturnValue(''),
}));

import { rehydrateSessions, type RehydrationDeps } from '../../src/daemon/rehydration.js';
import * as tmuxModule from '../../src/session/tmux.js';
import type { SessionState, SwitchTx } from '../../src/session/types.js';
import { SwitchReason } from '../../src/failover/types.js';

function switchingState(phase: SwitchTx['switch_phase'], overrides: Partial<SwitchTx> = {}): SessionState {
  return makeSessionState({
    status: 'SWITCHING',
    switch_tx: {
      switch_phase: phase,
      source_account: 'primary',
      target_account: 'account2',
      source_tmux_name: 'aisup-sess0001',
      source_tmux_session_id: '$1',
      source_pane_id: '%1',
      target_tmux_name: null,
      target_tmux_session_id: null,
      target_pane_id: null,
      source_transcript_path: null,
      source_transcript_sha256: null,
      source_destroyed: true,
      tried_accounts: [],
      phase_timestamps: {},
      error_summary: null,
      ...overrides,
    },
  });
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    aisup_session_id: 'sess-001',
    status: 'ACTIVE',
    account: 'primary',
    tmux_name: 'aisup-sess0001',
    tmux_session_id: '$1',
    pane_id: '%1',
    cwd: '/tmp/project',
    launch_started_at: new Date().toISOString(),
    claude_session_id: null,
    transcript_path: null,
    plan_path: null,
    active_skill: null,
    output_log_path: '/tmp/output.log',
    switch_tx: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function setupStateDir(tmpDir: string, sessions: SessionState[]): string {
  const stateDir = join(tmpDir, 'sessions');
  for (const s of sessions) {
    const sessionDir = join(stateDir, s.aisup_session_id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  return stateDir;
}

function makeFakeDeps(overrides: Partial<RehydrationDeps> = {}): RehydrationDeps & { tmpDir: string; setSessionState: ReturnType<typeof vi.fn>; journal: { append: ReturnType<typeof vi.fn> } } {
  const setSessionState = vi.fn();
  const journal = { append: vi.fn().mockResolvedValue(undefined) };
  return {
    stateDir: '/placeholder',
    tmuxSocket: 'aisup-test',
    liveSessions: new Set<string>(),
    setSessionState,
    journal,
    ...overrides,
    tmpDir: '',
  } as unknown as ReturnType<typeof makeFakeDeps>;
}

describe('rehydrateSessions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-rehy-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should restore pipe-pane for live ACTIVE session where pipe-pane is disabled', async () => {
    const session = makeSessionState({ output_log_path: join(tmpDir, 'output.log') });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isPipePaneActive).mockReturnValue(false);

    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState: vi.fn(),
      journal: { append: vi.fn().mockResolvedValue(undefined) },
    };

    await rehydrateSessions(deps);

    expect(tmuxModule.startOutputLog).toHaveBeenCalledWith(
      'aisup-test', session.tmux_name, session.output_log_path
    );
  });

  it('uses the shared resolver to flag stale source-account telemetry for a rehydrated known session', async () => {
    const statuslineDir = join(tmpDir, 'statusline');
    const currentConfigDir = join(tmpDir, '.claude-current');
    const oldConfigDir = join(tmpDir, '.claude-old');
    mkdirSync(statuslineDir, { recursive: true });
    mkdirSync(currentConfigDir, { recursive: true });
    mkdirSync(oldConfigDir, { recursive: true });
    const claudeId = '99999999-1111-2222-3333-444444444444';
    // The lingering statusline file's transcript belongs to the OLD account → identity mismatch.
    writeFileSync(join(statuslineDir, `statusline-${claudeId}.json`), JSON.stringify({
      session_id: claudeId,
      transcript_path: `${oldConfigDir}/projects/p/x.jsonl`,
      cwd: '/tmp/project',
    }));

    const session = makeSessionState({
      output_log_path: join(tmpDir, 'output.log'),
      claude_session_id: claudeId,
      account: 'current',
      cwd: '/tmp/project',
    });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isPipePaneActive).mockReturnValue(true);

    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState: vi.fn(),
      journal,
      statuslineDir,
      statuslineFreshnessWindowS: 300,
      accountConfigDir: (account: string) => (account === 'current' ? currentConfigDir : oldConfigDir),
    });

    const events = journal.append.mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const mismatch = events.find((e) => e.event_type === 'telemetry.session_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.details.expected_account).toBe('current');
    expect(mismatch?.details.expected_session_id).toBe(claudeId);
  });

  it('should NOT call startOutputLog when pipe-pane is already active', async () => {
    const session = makeSessionState({ output_log_path: join(tmpDir, 'output.log') });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isPipePaneActive).mockReturnValue(true);

    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState: vi.fn(),
      journal: { append: vi.fn().mockResolvedValue(undefined) },
    };

    await rehydrateSessions(deps);

    expect(tmuxModule.startOutputLog).not.toHaveBeenCalled();
  });

  it('should clear switch_tx and return to ACTIVE for snapshot phase', async () => {
    const session = makeSessionState({
      status: 'SWITCHING',
      switch_tx: {
        switch_phase: 'snapshot',
        source_account: 'primary',
        target_account: 'account2',
        source_tmux_name: 'aisup-sess0001',
        source_tmux_session_id: '$1',
        source_pane_id: '%1',
        target_tmux_name: null,
        target_tmux_session_id: null,
        target_pane_id: null,
        source_transcript_path: null,
        source_transcript_sha256: null,
        source_destroyed: false,
        tried_accounts: [],
        phase_timestamps: {},
        error_summary: null,
      },
    });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isProcessDead).mockReturnValue(false);

    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const setSessionState = vi.fn();
    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState,
      journal,
    };

    await rehydrateSessions(deps);

    // Should journal a recovery event and restore to ACTIVE
    const appendCalls = journal.append.mock.calls.map((c) => c[0].event_type);
    expect(appendCalls).toContain('recovery.success');
    expect(setSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ACTIVE', aisup_session_id: session.aisup_session_id })
    );
  });

  it('should kill source tmux and advance for stopping phase when source pane is dead', async () => {
    const session = makeSessionState({
      status: 'SWITCHING',
      switch_tx: {
        switch_phase: 'stopping',
        source_account: 'primary',
        target_account: 'account2',
        source_tmux_name: 'aisup-sess0001',
        source_tmux_session_id: '$1',
        source_pane_id: '%1',
        target_tmux_name: null,
        target_tmux_session_id: null,
        target_pane_id: null,
        source_transcript_path: null,
        source_transcript_sha256: null,
        source_destroyed: false,
        tried_accounts: [],
        phase_timestamps: {},
        error_summary: null,
      },
    });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isProcessDead).mockReturnValue(true);

    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState: vi.fn(),
      journal,
    };

    await rehydrateSessions(deps);

    expect(tmuxModule.destroyTmuxSession).toHaveBeenCalledWith('aisup-test', session.tmux_name);
    const appendCalls = journal.append.mock.calls.map((c) => c[0].event_type);
    expect(appendCalls).toContain('recovery.failed');
  });

  it('should log recovery.failed and leave STOPPING → clear switch_tx when source pane is alive', async () => {
    const session = makeSessionState({
      status: 'SWITCHING',
      switch_tx: {
        switch_phase: 'stopping',
        source_account: 'primary',
        target_account: 'account2',
        source_tmux_name: 'aisup-sess0001',
        source_tmux_session_id: '$1',
        source_pane_id: '%1',
        target_tmux_name: null,
        target_tmux_session_id: null,
        target_pane_id: null,
        source_transcript_path: null,
        source_transcript_sha256: null,
        source_destroyed: false,
        tried_accounts: [],
        phase_timestamps: {},
        error_summary: null,
      },
    });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isProcessDead).mockReturnValue(false);

    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const setSessionState = vi.fn();
    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name]),
      setSessionState,
      journal,
    };

    await rehydrateSessions(deps);

    // Source alive during stopping → clear switch_tx, return to ACTIVE
    expect(setSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ACTIVE', aisup_session_id: session.aisup_session_id })
    );
  });

  it.each(['source_destroyed', 'migrating', 'creating'] as const)(
    'continues an interrupted %s phase via onSwitch when a recovery callback is provided',
    async (phase) => {
      const session = switchingState(phase);
      const stateDir = setupStateDir(tmpDir, [session]);
      vi.mocked(tmuxModule.isProcessDead).mockReturnValue(true);
      const onSwitch = vi.fn().mockResolvedValue(undefined);

      await rehydrateSessions({
        stateDir,
        tmuxSocket: 'aisup-test',
        liveSessions: new Set<string>(),
        setSessionState: vi.fn(),
        journal: { append: vi.fn().mockResolvedValue(undefined) },
        onSwitch,
        onRestart: vi.fn().mockResolvedValue(undefined),
      });

      expect(onSwitch).toHaveBeenCalledWith(session.aisup_session_id, SwitchReason.SourceDead);
    }
  );

  it('continues a resuming phase with a dead target via onSwitch', async () => {
    const session = switchingState('resuming', { target_tmux_name: 'aisup-target', target_account: 'account2' });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isProcessDead).mockReturnValue(true); // target dead
    const onSwitch = vi.fn().mockResolvedValue(undefined);

    await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set<string>(),
      setSessionState: vi.fn(),
      journal: { append: vi.fn().mockResolvedValue(undefined) },
      onSwitch,
      onRestart: vi.fn().mockResolvedValue(undefined),
    });

    expect(onSwitch).toHaveBeenCalledWith(session.aisup_session_id, SwitchReason.SourceDead);
  });

  it('falls back to deterministic needs_manual_failover for source_destroyed when no callback is provided', async () => {
    const session = switchingState('source_destroyed');
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isProcessDead).mockReturnValue(true);
    const journal = { append: vi.fn().mockResolvedValue(undefined) };

    await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set<string>(),
      setSessionState: vi.fn(),
      journal,
    });

    const failed = journal.append.mock.calls.map((c) => c[0]).find((e) => e.event_type === 'recovery.failed');
    expect(failed?.details.action).toBe('needs_manual_failover');
  });

  it('restarts an ACTIVE session whose tmux is gone via onRestart when provided', async () => {
    const session = makeSessionState();
    const stateDir = setupStateDir(tmpDir, [session]);
    const onRestart = vi.fn().mockResolvedValue(undefined);

    await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set<string>(), // tmux gone
      setSessionState: vi.fn(),
      journal: { append: vi.fn().mockResolvedValue(undefined) },
      onSwitch: vi.fn().mockResolvedValue(undefined),
      onRestart,
    });

    expect(onRestart).toHaveBeenCalledWith(session.aisup_session_id);
  });

  it('restores a persisted EXHAUSTED session for visibility and returns its id for poller re-arm', async () => {
    const session = makeSessionState({ status: 'EXHAUSTED' });
    const stateDir = setupStateDir(tmpDir, [session]);
    const setSessionState = vi.fn();

    const result = await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set<string>(),
      setSessionState,
      journal: { append: vi.fn().mockResolvedValue(undefined) },
    });

    // Visibility restored without putting the session into active loops.
    expect(setSessionState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'EXHAUSTED', aisup_session_id: session.aisup_session_id, hasTmux: false })
    );
    // Handoff to Task 7: persisted-EXHAUSTED ids surfaced for the daemon to re-arm polling.
    expect(result.exhaustedSessionIds).toEqual([session.aisup_session_id]);
  });

  it('reports an unmatched live tmux session as an orphan without destroying it', async () => {
    const session = makeSessionState({ output_log_path: join(tmpDir, 'output.log') });
    const stateDir = setupStateDir(tmpDir, [session]);
    vi.mocked(tmuxModule.isPipePaneActive).mockReturnValue(true);
    const journal = { append: vi.fn().mockResolvedValue(undefined) };

    const result = await rehydrateSessions({
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set([session.tmux_name, 'aisup-orphan99']),
      setSessionState: vi.fn(),
      journal,
    });

    // A live tmux session with no persisted state is reported as an orphan, never auto-destroyed.
    expect(result.orphans).toBe(1);
    expect(tmuxModule.destroyTmuxSession).not.toHaveBeenCalled();
    const rehydratedEvent = journal.append.mock.calls
      .map((c) => c[0])
      .find((e) => e.event_type === 'daemon.rehydrated');
    expect(rehydratedEvent?.details.orphan_count).toBe(1);
  });

  it('should handle state-without-tmux: ACTIVE session no live tmux logs event', async () => {
    const session = makeSessionState();
    const stateDir = setupStateDir(tmpDir, [session]);

    const journal = { append: vi.fn().mockResolvedValue(undefined) };
    const deps: RehydrationDeps = {
      stateDir,
      tmuxSocket: 'aisup-test',
      liveSessions: new Set<string>(), // no live tmux sessions
      setSessionState: vi.fn(),
      journal,
    };

    await rehydrateSessions(deps);

    const appendCalls = journal.append.mock.calls.map((c) => c[0].event_type);
    expect(appendCalls).toContain('session.destroyed_externally');
  });
});

// ---------------------------------------------------------------------------
// Worker rehydration (Task 10): subprocess phases fail; MERGING reconciles
// against the patch (HI-003); QUEUED/AWAITING_APPROVAL are preserved.
// ---------------------------------------------------------------------------
import { WorkerOrchestrator, type WorktreeOps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import { CONFIG_DEFAULTS } from '../../src/config/defaults.js';
import type { WorkersConfig } from '../../src/config/schema.js';
import type { WorkerState, WorkerStatus, WorkerOutput } from '../../src/workers/types.js';
import type { JournalEvent } from '../../src/journal/types.js';
import { randomUUID } from 'node:crypto';

function workerCfg(): WorkersConfig {
  const c = JSON.parse(JSON.stringify(CONFIG_DEFAULTS.workers)) as WorkersConfig;
  c.enabled = true;
  c.adapters.codex.enabled = true;
  c.adapters.gemini.enabled = true;
  return c;
}

function seedWorker(store: WorkerStore, status: WorkerStatus, output: WorkerOutput | null, granted = false): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.create({
    id, task_type: 'implement', title: 't', prompt: 'p', base_ref: 'HEAD', base_sha: 'sha',
    implementer: 'codex', reviewer: 'gemini', workspace_root: '/repo', created_at: now, updated_at: now,
  });
  const patch: Partial<WorkerState> = { status, output };
  if (granted) patch.approval = { decided: true, granted: true, by: 'u', at: now };
  store.patch(id, patch);
  return id;
}

function mkOutput(): WorkerOutput {
  return {
    exit_code: 0, timed_out: false, stdout_tail: '', stderr_tail: '',
    patch: 'p', patch_path: '/repo/.aisup-workers/x/patch.diff', patch_sha256: 'h', patch_bytes: 1,
    changed_files: ['x.ts'], boundary_ok: true,
  };
}

function rehydrationHarness(stateDir: string, applyReverse: boolean, applyOk: boolean): { orch: WorkerOrchestrator; store: WorkerStore; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  const store = new WorkerStore(stateDir);
  const wt: WorktreeOps = {
    resolveBaseSha: async () => 'sha', createWorktree: async () => '/wt', captureDiff: async () => ({ patch: '', changedFiles: [] }),
    snapshotMainTree: async () => ({ status: '', forbidden: {} }), auditBoundary: async () => true,
    sanitizePatch: () => ({ ok: true, violations: [] }), patchSha256: () => 'h', removeWorktree: async () => {},
    isGitRepo: async () => true, applyCheck: async () => applyOk, applyReverseCheck: async () => applyReverse,
  };
  const orch = new WorkerOrchestrator({
    store, config: workerCfg(), journal: { append: async (e) => { events.push(e); } }, worktreeOps: wt,
    runImplementer: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    validateOutput: async () => ({ passed: true, failed_gates: [] }),
    reviewOutput: async () => ({ reviewer: 'gemini', verdict: 'approve', degraded: false, findings: [], raw_output_tail: '' }),
    mergeOutput: async () => ({ merged: true, reason: null, resetApproval: false }),
    resolveActiveSessionCwd: () => '/repo',
  });
  return { orch, store, events };
}

describe('worker rehydration (HI-003)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-wreh-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('fails in-flight subprocess phases and preserves QUEUED / AWAITING_APPROVAL', async () => {
    const h = rehydrationHarness(dir, false, true);
    const running = seedWorker(h.store, 'RUNNING', null);
    const validating = seedWorker(h.store, 'VALIDATING', null);
    const reviewing = seedWorker(h.store, 'REVIEWING', mkOutput());
    const queued = seedWorker(h.store, 'QUEUED', null);
    const awaiting = seedWorker(h.store, 'AWAITING_APPROVAL', mkOutput());

    await h.orch.rehydrateWorkers();

    expect(h.store.read(running)!.status).toBe('FAILED');
    expect(h.store.read(validating)!.status).toBe('FAILED');
    expect(h.store.read(reviewing)!.status).toBe('FAILED');
    expect(h.store.read(queued)!.status).toBe('QUEUED');
    expect(h.store.read(awaiting)!.status).toBe('AWAITING_APPROVAL');
    expect(h.events.filter((e) => e.event_type === 'worker.rehydrated_failed').length).toBe(3);
  });

  it('reconciles a MERGING worker whose patch is already applied → MERGED + worker.rehydrated_merged', async () => {
    const h = rehydrationHarness(dir, true, false); // reverse-check passes → already applied
    const id = seedWorker(h.store, 'MERGING', mkOutput(), true);
    await h.orch.rehydrateWorkers();
    expect(h.store.read(id)!.status).toBe('MERGED');
    expect(h.events.some((e) => e.event_type === 'worker.rehydrated_merged')).toBe(true);
  });

  it('reconciles a MERGING worker interrupted before apply → AWAITING_APPROVAL with approval reset (HI-006)', async () => {
    const h = rehydrationHarness(dir, false, true); // reverse fails, apply --check passes → no apply happened
    const id = seedWorker(h.store, 'MERGING', mkOutput(), true);
    await h.orch.rehydrateWorkers();
    const s = h.store.read(id)!;
    expect(s.status).toBe('AWAITING_APPROVAL');
    expect(s.approval.granted).toBe(false); // fresh approval required for any retry
    expect(h.events.find((e) => e.event_type === 'worker.merge_failed')?.details.reason).toBe('merge_interrupted_before_apply');
  });

  it('reconciles a MERGING worker whose patch no longer applies → AWAITING_APPROVAL + apply_conflict', async () => {
    const h = rehydrationHarness(dir, false, false); // neither reverse nor apply --check passes
    const id = seedWorker(h.store, 'MERGING', mkOutput(), true);
    await h.orch.rehydrateWorkers();
    expect(h.store.read(id)!.status).toBe('AWAITING_APPROVAL');
    expect(h.events.find((e) => e.event_type === 'worker.merge_failed')?.details.reason).toBe('apply_conflict');
  });
});
