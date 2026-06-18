import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmuxMocks = vi.hoisted(() => ({
  isProcessDead: vi.fn().mockReturnValue(false),
  hasSession: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/session/tmux.js', () => ({
  isProcessDead: tmuxMocks.isProcessDead,
  hasSession: tmuxMocks.hasSession,
}));

import { LoopManager, type LoopManagerDeps } from '../../../src/daemon/loop-manager.js';
import { PermissionDetector } from '../../../src/permissions/detector.js';
import { SwitchReason } from '../../../src/failover/types.js';
import { AccountRegistry } from '../../../src/accounts/registry.js';
import type { AisupConfig } from '../../../src/config/schema.js';

function makeFakeDeps(overrides: Record<string, unknown> = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-lm-'));
  const stateDir = join(tmpDir, 'sessions');
  mkdirSync(stateDir, { recursive: true });
  const logPath = join(tmpDir, 'output.log');
  writeFileSync(logPath, 'line\n');

  const sessionId = 'test-session-001';
  const sessionStateDir = join(stateDir, sessionId);
  mkdirSync(sessionStateDir, { recursive: true });
  writeFileSync(join(sessionStateDir, 'state.json'), JSON.stringify({
    aisup_session_id: sessionId,
    status: 'ACTIVE',
    account: 'primary',
    tmux_name: 'aisup-test',
    tmux_session_id: null,
    pane_id: null,
    cwd: tmpDir,
    launch_started_at: new Date().toISOString(),
    claude_session_id: null,
    transcript_path: null,
    plan_path: null,
    active_skill: null,
    output_log_path: logPath,
    switch_tx: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  const fakeSession = {
    aisup_session_id: sessionId,
    status: 'ACTIVE' as const,
    account: 'primary',
    tmux_name: 'aisup-test',
    output_log_path: logPath,
    cwd: tmpDir,
    launch_started_at: new Date().toISOString(),
    claude_session_id: null,
    transcript_path: null,
    tmux_session_id: null,
    pane_id: null,
    plan_path: null,
    active_skill: null,
    switch_tx: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const fakeAccount = {
    name: 'primary',
    configDir: tmpDir,
    priority: 1,
    enabled: true,
    state: 'HEALTHY' as const,
    score: null,
    cooldownUntil: null,
  };

  const sessionManager = {
    getActiveSession: vi.fn().mockReturnValue(fakeSession),
    patchState: vi.fn(),
    getStateDir: vi.fn().mockReturnValue(stateDir),
    getSocket: vi.fn().mockReturnValue('aisup-test'),
  };

  const accountRegistry = {
    getAll: vi.fn().mockReturnValue([fakeAccount]),
    get: vi.fn().mockReturnValue(fakeAccount),
    setScore: vi.fn(),
    setState: vi.fn(),
    applyTelemetry: vi.fn(),
  };

  const journal = {
    append: vi.fn().mockResolvedValue(undefined),
  };

  return {
    tmpDir,
    sessionId,
    deps: {
      sessionManager,
      accountRegistry,
      softPct: 85,
      hardPct: 95,
      idleBoundarySeconds: 30,
      statuslineDir: tmpDir,
      statuslineFreshnessWindowS: 300,
      networkErrorThreshold: 3,
      journal,
      onSwitch: vi.fn().mockResolvedValue(undefined),
      onRestart: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  };
}

describe('LoopManager with deps', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    tmuxMocks.isProcessDead.mockReturnValue(false);
    tmuxMocks.hasSession.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('should start and stop cleanly without deps (backward compat)', () => {
    const onBreach = vi.fn();
    const lm = new LoopManager({
      rateLimitIntervalMs: 1000,
      healthIntervalMs: 1000,
      recoveryIntervalMs: 1000,
      idleIntervalMs: 1000,
      onThresholdBreach: onBreach,
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
    });
    lm.startAll();
    lm.stopAll();
    // no-op ticks, no exceptions
  });

  it('should wire rate-limit tick and call onBreach when hard threshold breached via mocked telemetry', async () => {
    const { tmpDir, deps } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });

    // Provide telemetry with hard breach via statusline file in tmpDir
    // isSessionIdle with 30s boundary won't trigger on a fresh log file
    const onBreach = vi.fn();

    const lm = new LoopManager({
      rateLimitIntervalMs: 50,
      healthIntervalMs: 50,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: onBreach,
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    lm.startAll();
    await new Promise((r) => setTimeout(r, 120));
    lm.stopAll();

    // getActiveSession called on each tick
    expect(deps.sessionManager.getActiveSession).toHaveBeenCalled();
  });

  it('failoverInProgress flag prevents concurrent switches', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });

    // Provide telemetry that triggers hard threshold by writing a statusline file
    const statuslineFile = join(tmpDir, `statusline-${sessionId}.json`);
    writeFileSync(statuslineFile, JSON.stringify({
      session_id: sessionId,
      transcript_path: join(tmpDir, 'projects', 'test', `${sessionId}.jsonl`),
      cwd: tmpDir,
      rate_limits: {
        five_hour: { used_percentage: 96, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 60, resets_at: Math.floor(Date.now() / 1000) + 86400 },
      },
    }));

    let switchCallCount = 0;
    const onSwitch = vi.fn().mockImplementation(() => {
      switchCallCount++;
      // Simulate long-running switch
      return new Promise<void>((r) => setTimeout(r, 1000));
    });
    deps.onSwitch = onSwitch;

    const onBreach = vi.fn();
    const lm = new LoopManager({
      rateLimitIntervalMs: 30,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: onBreach,
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    lm.startAll();
    await new Promise((r) => setTimeout(r, 150));
    lm.stopAll();

    // Should only trigger switch once despite multiple ticks
    expect(switchCallCount).toBeLessThanOrEqual(1);
  });

  it('healthTick should call onHealthResult for unhealthy accounts', async () => {
    const { tmpDir, deps } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });

    // Make account have non-existent configDir to trigger health failure
    const badAccount = {
      name: 'primary',
      configDir: '/nonexistent/path/that/does/not/exist',
      priority: 1,
      enabled: true,
      state: 'HEALTHY' as const,
      score: null,
      cooldownUntil: null,
    };
    deps.accountRegistry.getAll = vi.fn().mockReturnValue([badAccount]);
    deps.accountRegistry.get = vi.fn().mockReturnValue(badAccount);
    // Also make getActiveSession return null so rate-limit tick is skipped
    deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(null);

    const onHealthResult = vi.fn();
    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 50,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult,
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    lm.startAll();
    await new Promise((r) => setTimeout(r, 120));
    lm.stopAll();

    expect(onHealthResult).toHaveBeenCalledWith(expect.objectContaining({
      account: 'primary',
      configDirExists: false,
    }));
  });

  it('idle observation invokes onIdle once per idle period, not on every tick', () => {
    const { tmpDir, deps } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const logPath = deps.sessionManager.getActiveSession().output_log_path as string;

    const onIdle = vi.fn();
    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle,
      deps: deps as unknown as LoopManagerDeps,
    });
    const idleTick = (lm as unknown as { idleTick(d: LoopManagerDeps): void }).idleTick.bind(lm);

    // Backdate the output log so the session is idle (boundary is 30s).
    const old = new Date(Date.now() - 60_000);
    utimesSync(logPath, old, old);
    idleTick(deps as unknown as LoopManagerDeps);
    idleTick(deps as unknown as LoopManagerDeps);
    idleTick(deps as unknown as LoopManagerDeps);
    expect(onIdle).toHaveBeenCalledTimes(1); // one idle period → one emit

    // Activity → no longer idle, then idle again → new period emits again.
    const now = new Date();
    utimesSync(logPath, now, now);
    idleTick(deps as unknown as LoopManagerDeps);
    utimesSync(logPath, old, old);
    idleTick(deps as unknown as LoopManagerDeps);
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  describe('gate triggering on idle', () => {
    const idleSessionWithSkill = (deps: ReturnType<typeof makeFakeDeps>['deps'], skill: string | null) => {
      const base = deps.sessionManager.getActiveSession();
      const session = { ...base, active_skill: skill };
      deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(session);
      const old = new Date(Date.now() - 60_000);
      utimesSync(base.output_log_path as string, old, old); // idle (boundary 30s)
      return session;
    };

    const buildLoop = (deps: ReturnType<typeof makeFakeDeps>['deps']): LoopManager => new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    const idleTick = (lm: LoopManager, deps: ReturnType<typeof makeFakeDeps>['deps']): void =>
      (lm as unknown as { idleTick(d: LoopManagerDeps): void }).idleTick(deps as unknown as LoopManagerDeps);

    it('triggers gates when idle with a non-null active_skill and clears the skill', () => {
      const onGateTrigger = vi.fn().mockResolvedValue(undefined);
      const { tmpDir, deps, sessionId } = makeFakeDeps({ onGateTrigger, gateDebounceMs: 60_000 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      idleSessionWithSkill(deps, '/spec');
      const lm = buildLoop(deps);

      idleTick(lm, deps);

      expect(onGateTrigger).toHaveBeenCalledWith(sessionId, '/spec');
      expect(deps.sessionManager.patchState).toHaveBeenCalledWith(sessionId, { active_skill: null });
    });

    it('does not trigger gates when idle without an active_skill', () => {
      const onGateTrigger = vi.fn().mockResolvedValue(undefined);
      const { tmpDir, deps } = makeFakeDeps({ onGateTrigger, gateDebounceMs: 60_000 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      idleSessionWithSkill(deps, null);
      const lm = buildLoop(deps);

      idleTick(lm, deps);

      expect(onGateTrigger).not.toHaveBeenCalled();
    });

    it('debounces repeated gate triggers within the debounce window', () => {
      const onGateTrigger = vi.fn().mockResolvedValue(undefined);
      const { tmpDir, deps } = makeFakeDeps({ onGateTrigger, gateDebounceMs: 60_000 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      idleSessionWithSkill(deps, '/spec'); // patchState is a mock, so active_skill stays set
      const lm = buildLoop(deps);

      idleTick(lm, deps);
      idleTick(lm, deps);
      idleTick(lm, deps);

      expect(onGateTrigger).toHaveBeenCalledTimes(1); // debounce blocks re-triggers in the window
    });

    it('does not trigger when no onGateTrigger is wired (manual trigger mode)', () => {
      const { tmpDir, deps } = makeFakeDeps(); // no onGateTrigger
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      idleSessionWithSkill(deps, '/spec');
      const lm = buildLoop(deps);
      expect(() => idleTick(lm, deps)).not.toThrow();
    });
  });

  it('recovery tick scans live output deltas for 429 before advancing the cursor', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const session = deps.sessionManager.getActiveSession();
    writeFileSync(session.output_log_path, 'Claude says rate limit 429\n');
    tmuxMocks.isProcessDead.mockReturnValue(false);

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

    await (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.RateLimit429);
    expect(deps.journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'failure.detected',
      details: expect.objectContaining({ has429: true, source: 'live_output' }),
    }));
  });

  it('soft-threshold precheck refreshes account scores and finds a strictly-better target', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });

    // Real registry with the current account (primary) plus a second eligible account.
    const primaryConfigDir = join(tmpDir, 'primary');
    const secondaryConfigDir = join(tmpDir, 'secondary');
    mkdirSync(primaryConfigDir, { recursive: true });
    mkdirSync(secondaryConfigDir, { recursive: true });
    const registry = new AccountRegistry({
      accounts: [
        { name: 'primary', config_dir: primaryConfigDir, priority: 1, enabled: true },
        { name: 'secondary', config_dir: secondaryConfigDir, priority: 2, enabled: true },
      ],
    } as AisupConfig);
    deps.accountRegistry = registry as unknown as typeof deps.accountRegistry;

    const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
    // Current session telemetry: soft threshold breached (five-hour 88% ≥ soft 85), low headroom.
    // File name must be UUID-shaped to be picked up by the telemetry scanner.
    writeFileSync(join(tmpDir, 'statusline-99999999-1111-2222-3333-444444444444.json'), JSON.stringify({
      session_id: '99999999-1111-2222-3333-444444444444',
      transcript_path: join(primaryConfigDir, 'projects', 'p', 'cur.jsonl'),
      cwd: tmpDir,
      rate_limits: {
        five_hour: { used_percentage: 88, resets_at: futureEpoch },
        seven_day: { used_percentage: 20, resets_at: futureEpoch },
      },
    }));
    // Secondary account telemetry: high headroom → high score (a strictly better target).
    writeFileSync(join(tmpDir, 'statusline-bbbbbbbb-cccc-dddd-eeee-ffffffffffff.json'), JSON.stringify({
      session_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      transcript_path: join(secondaryConfigDir, 'projects', 's', 'x.jsonl'),
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: futureEpoch },
        seven_day: { used_percentage: 5, resets_at: futureEpoch },
      },
    }));

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    (lm as unknown as { rateLimitTick(d: LoopManagerDeps): void }).rateLimitTick(deps as unknown as LoopManagerDeps);

    // Without the refresh, secondary's score stays null and the strictly-better-target
    // check never matches → no transition. With it, the session arms for an idle switch.
    expect(deps.sessionManager.patchState).toHaveBeenCalledWith(sessionId, { status: 'SWITCH_PENDING_AT_IDLE' });
    expect(registry.get('secondary')?.score).not.toBeNull();
  });

  it('emits telemetry.session_mismatch with safe expected identity and no transcript contents', () => {
    const { tmpDir, deps } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const claudeId = '12345678-1111-2222-3333-444444444444';
    const session = { ...deps.sessionManager.getActiveSession(), claude_session_id: claudeId, account: 'primary', cwd: tmpDir };
    deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(session);
    deps.accountRegistry.get = vi.fn().mockReturnValue({ name: 'primary', configDir: tmpDir, priority: 1, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null });

    // Telemetry for the known session id but with a mismatching cwd → resolver rejects it.
    writeFileSync(join(tmpDir, `statusline-${claudeId}.json`), JSON.stringify({
      session_id: claudeId,
      transcript_path: join(tmpDir, 'projects', 'x', `${claudeId}.jsonl`),
      cwd: '/some/other/cwd',
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    }));

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    (lm as unknown as { rateLimitTick(d: LoopManagerDeps): void }).rateLimitTick(deps as unknown as LoopManagerDeps);

    const events = (deps.journal.append as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const mismatch = events.find((e) => e.event_type === 'telemetry.session_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.details.expected_account).toBe('primary');
    expect(mismatch?.details.expected_session_id).toBe(claudeId);
    expect(mismatch?.details.expected_cwd).toBe(tmpDir);
    // Never leak transcript contents into the journal.
    expect(JSON.stringify(mismatch?.details)).not.toContain('"content"');
  });

  it('emits telemetry.invalid_json with a safe summary when the active-session telemetry file is malformed', () => {
    const { tmpDir, deps } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const claudeId = '12345678-1111-2222-3333-444444444444';
    const session = { ...deps.sessionManager.getActiveSession(), claude_session_id: claudeId, account: 'primary', cwd: tmpDir };
    deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(session);
    deps.accountRegistry.get = vi.fn().mockReturnValue({ name: 'primary', configDir: tmpDir, priority: 1, enabled: true, state: 'HEALTHY', score: null, cooldownUntil: null });
    writeFileSync(join(tmpDir, `statusline-${claudeId}.json`), '{ broken json contents here');

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    (lm as unknown as { rateLimitTick(d: LoopManagerDeps): void }).rateLimitTick(deps as unknown as LoopManagerDeps);

    const events = (deps.journal.append as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const invalid = events.find((e) => e.event_type === 'telemetry.invalid_json');
    expect(invalid).toBeDefined();
    expect(invalid?.details.error).toBeTruthy();
    expect(typeof invalid?.details.stale).toBe('boolean');
    // Never leak the file contents into the journal.
    expect(JSON.stringify(invalid?.details)).not.toContain('broken json contents');
  });

  it('soft-threshold with no better target stays ACTIVE and emits a nonterminal no-target event', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });

    // Only the current account exists → no eligible failover target.
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(tmpDir, 'statusline-77777777-1111-2222-3333-444444444444.json'), JSON.stringify({
      session_id: '77777777-1111-2222-3333-444444444444',
      transcript_path: join(tmpDir, 'projects', 'p', 'cur.jsonl'),
      cwd: tmpDir,
      rate_limits: {
        five_hour: { used_percentage: 88, resets_at: futureEpoch },
        seven_day: { used_percentage: 20, resets_at: futureEpoch },
      },
    }));

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    (lm as unknown as { rateLimitTick(d: LoopManagerDeps): void }).rateLimitTick(deps as unknown as LoopManagerDeps);

    // No transition to SWITCH_PENDING_AT_IDLE; the session stays ACTIVE.
    expect(deps.sessionManager.patchState).not.toHaveBeenCalledWith(sessionId, { status: 'SWITCH_PENDING_AT_IDLE' });
    const events = (deps.journal.append as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as { event_type: string; details: Record<string, unknown> });
    const noTarget = events.find((e) => e.event_type === 'failover.no_target_available');
    expect(noTarget?.details.terminal).toBe(false);
    expect(noTarget?.details.requires_better_soft_target).toBe(true);
  });

  it('recovery tick scans live output deltas for tracked skill invocations', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps({ trackedSkills: ['/spec'] });
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const session = deps.sessionManager.getActiveSession();
    writeFileSync(session.output_log_path, 'Launching skill: spec-plan\n');
    tmuxMocks.isProcessDead.mockReturnValue(false);

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

    await (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    expect(deps.sessionManager.patchState).toHaveBeenCalledWith(sessionId, { active_skill: '/spec' });
    expect(deps.journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'skill.detected',
      details: expect.objectContaining({ skill: '/spec' }),
    }));
  });

  it('emits session.destroyed_externally and preserves 429 classification when the tmux session is gone', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const session = deps.sessionManager.getActiveSession();
    writeFileSync(session.output_log_path, 'fatal: rate limit 429 exceeded\n');
    // tmux session container externally destroyed (not merely a dead runner pane).
    tmuxMocks.hasSession.mockReturnValue(false);

    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

    await (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    // Distinct evidence event for a destroyed session container, with 429 classification preserved.
    expect(deps.journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'session.destroyed_externally',
      details: expect.objectContaining({ has429: true, tmux_name: 'aisup-test' }),
    }));
    // Same recovery matrix: a 429 routes to an account switch.
    expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.RateLimit429);
    // The generic dead-pane failure event is not emitted for a destroyed container.
    expect(deps.journal.append).not.toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'failure.detected',
      details: expect.objectContaining({ source: 'recovery_handler' }),
    }));
  });

  function deadPaneLoop(deps: ReturnType<typeof makeFakeDeps>['deps'], sessionId: string): LoopManager {
    const session = deps.sessionManager.getActiveSession();
    writeFileSync(session.output_log_path, 'runner process exited unexpectedly\n');
    tmuxMocks.isProcessDead.mockReturnValue(true); // dead pane, no 429
    const lm = new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });
    lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);
    return lm;
  }

  it('escalates to a switch only after the third failed same-account restart in the window', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    deps.onRestart = vi.fn().mockResolvedValue(false); // every restart fails
    const lm = deadPaneLoop(deps, sessionId);
    const tick = () => (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    await tick(); // failed restart 1
    await tick(); // failed restart 2
    expect(deps.onSwitch).not.toHaveBeenCalled();
    await tick(); // failed restart 3 → escalate

    expect(deps.onRestart).toHaveBeenCalledTimes(3);
    expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.RestartFailures);
  });

  it('clears the restart counter when the pane recovers (alive) — genuine recovery', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    deps.onRestart = vi.fn().mockResolvedValue(true);
    const lm = deadPaneLoop(deps, sessionId);
    const tick = () => (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    await tick(); // crash 1 (pane dead)
    await tick(); // crash 2 (pane dead)
    tmuxMocks.isProcessDead.mockReturnValue(false); // pane recovers → counter cleared on this tick
    await tick(); // alive tick clears the crash counter (genuine recovery)
    tmuxMocks.isProcessDead.mockReturnValue(true);  // dies again → fresh window
    await tick(); // crash 1 (fresh window)
    await tick(); // crash 2 (fresh window)

    // Never three crashes within one window → no escalation (recovery reset the counter).
    expect(deps.onSwitch).not.toHaveBeenCalled();
  });

  it('bounds a flapping launch-then-exit runner: escalates + records a breaker failure (F2)', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    // onRestart "succeeds" (a pane is spawned) every time, but the pane keeps dying → flapping.
    // Previously this cleared the counter each tick and looped forever; now it must be bounded.
    deps.onRestart = vi.fn().mockResolvedValue(true);
    const recordFailure = vi.fn();
    (deps as unknown as { circuitBreaker: unknown }).circuitBreaker = {
      getState: vi.fn().mockReturnValue('CLOSED'),
      recordFailure,
      getCooldownEta: vi.fn().mockReturnValue(null),
    };
    const lm = deadPaneLoop(deps, sessionId); // pane stays dead each tick (flapping)
    const tick = () => (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    await tick(); // crash 1, onRestart→true
    await tick(); // crash 2, onRestart→true
    expect(deps.onSwitch).not.toHaveBeenCalled(); // not looping forever on the same account
    await tick(); // crash 3 → bounded → escalate

    expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.RestartFailures);
    expect(recordFailure).toHaveBeenCalledWith('primary'); // circuit-breaker failure recorded
  });

  it('does not escalate when failed restarts fall outside the five-minute window', async () => {
    const { tmpDir, deps, sessionId } = makeFakeDeps();
    cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    deps.onRestart = vi.fn().mockResolvedValue(false);
    const lm = deadPaneLoop(deps, sessionId);
    const tick = () => (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> }).recoveryTick(deps as unknown as LoopManagerDeps);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      await tick(); // fail 1
      await tick(); // fail 2
      vi.advanceTimersByTime(6 * 60 * 1000); // window expires
      await tick(); // fail → fresh window, count 1, no escalation
      expect(deps.onSwitch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('auth and network failure detection', () => {
    type RecoveryDeps = ReturnType<typeof makeFakeDeps>['deps'];

    const buildLoop = (deps: RecoveryDeps): LoopManager => new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    const tick = (lm: LoopManager, deps: RecoveryDeps): Promise<void> =>
      (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> })
        .recoveryTick(deps as unknown as LoopManagerDeps);

    it('triggers an account switch with AuthFailure when auth failure appears in live output', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      const session = deps.sessionManager.getActiveSession();
      writeFileSync(session.output_log_path, 'API Error: 401 Unauthorized\n');
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps);

      expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.AuthFailure);
      expect(deps.journal.append).toHaveBeenCalledWith(expect.objectContaining({
        event_type: 'failure.auth_detected',
        details: expect.objectContaining({ source: 'live_output' }),
      }));
    });

    it('prioritizes auth failure over a 429 present in the same output delta', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      const session = deps.sessionManager.getActiveSession();
      writeFileSync(session.output_log_path, 'rate limit 429 then 401 Unauthorized\n');
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps);

      expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.AuthFailure);
      expect(deps.onSwitch).not.toHaveBeenCalledWith(sessionId, SwitchReason.RateLimit429);
    });

    it('restarts the runner once network errors reach the configured threshold', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps({ networkErrorThreshold: 3 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      deps.onRestart = vi.fn().mockResolvedValue(true);
      const session = deps.sessionManager.getActiveSession();
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      writeFileSync(session.output_log_path, 'connect ECONNREFUSED 127.0.0.1:443\n');
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps); // count 1
      appendFileSync(session.output_log_path, 'request failed: ETIMEDOUT\n');
      await tick(lm, deps); // count 2
      expect(deps.onRestart).not.toHaveBeenCalled();
      appendFileSync(session.output_log_path, 'getaddrinfo ENOTFOUND api\n');
      await tick(lm, deps); // count 3 → restart

      expect(deps.onRestart).toHaveBeenCalledWith(sessionId);
      expect(deps.onSwitch).not.toHaveBeenCalled();
    });

    it('escalates to a switch with NetworkError when the threshold restart fails', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps({ networkErrorThreshold: 2 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      deps.onRestart = vi.fn().mockResolvedValue(false); // restart cannot relaunch
      const session = deps.sessionManager.getActiveSession();
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      writeFileSync(session.output_log_path, 'network error: connection refused\n');
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps); // count 1
      appendFileSync(session.output_log_path, 'read ECONNRESET\n');
      await tick(lm, deps); // count 2 → restart fails → switch

      expect(deps.onRestart).toHaveBeenCalledWith(sessionId);
      expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.NetworkError);
    });

    it('resets the network-error window when clean output appears before the threshold', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps({ networkErrorThreshold: 2 });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      deps.onRestart = vi.fn().mockResolvedValue(true);
      const session = deps.sessionManager.getActiveSession();
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      writeFileSync(session.output_log_path, 'connect ECONNREFUSED\n');
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps); // count 1
      appendFileSync(session.output_log_path, 'all systems nominal, continuing\n');
      await tick(lm, deps); // clean output → counter reset
      appendFileSync(session.output_log_path, 'read ETIMEDOUT\n');
      await tick(lm, deps); // count 1 again (not 2)

      expect(deps.onRestart).not.toHaveBeenCalled();
    });

    it('does not run auth/network detection for non-active statuses', async () => {
      const { tmpDir, deps, sessionId } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      const session = { ...deps.sessionManager.getActiveSession(), status: 'SWITCHING' as const };
      deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(session);
      writeFileSync(session.output_log_path, 'API Error: 401 Unauthorized\n');
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps);

      expect(deps.onSwitch).not.toHaveBeenCalled();
    });
  });

  describe('permission detection', () => {
    type RecoveryDeps = ReturnType<typeof makeFakeDeps>['deps'];

    const buildLoop = (deps: RecoveryDeps): LoopManager => new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    const tick = (lm: LoopManager, deps: RecoveryDeps): Promise<void> =>
      (lm as unknown as { recoveryTick(d: LoopManagerDeps): Promise<void> })
        .recoveryTick(deps as unknown as LoopManagerDeps);

    it('emits permission.detected and invokes onPermissionDetected for a live prompt', async () => {
      const onPermissionDetected = vi.fn();
      const { tmpDir, deps, sessionId } = makeFakeDeps({
        permissionDetector: new PermissionDetector([]),
        onPermissionDetected,
      });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      const session = deps.sessionManager.getActiveSession();
      writeFileSync(session.output_log_path, 'Do you want to proceed?\n');
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps);

      expect(onPermissionDetected).toHaveBeenCalledWith(sessionId, expect.objectContaining({ tool: 'unknown' }));
      expect(deps.journal.append).toHaveBeenCalledWith(expect.objectContaining({
        event_type: 'permission.detected',
      }));
      expect(deps.onSwitch).not.toHaveBeenCalled();
    });

    it('does not block a 429 switch present in the same output delta', async () => {
      const onPermissionDetected = vi.fn();
      const { tmpDir, deps, sessionId } = makeFakeDeps({
        permissionDetector: new PermissionDetector([]),
        onPermissionDetected,
      });
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      const session = deps.sessionManager.getActiveSession();
      writeFileSync(session.output_log_path, 'Do you want to proceed?\nrate limit 429 reached\n');
      tmuxMocks.isProcessDead.mockReturnValue(false);
      const lm = buildLoop(deps);
      lm.recoveryHandler.initCursor(sessionId, session.output_log_path, 0);

      await tick(lm, deps);

      expect(onPermissionDetected).toHaveBeenCalled();
      expect(deps.onSwitch).toHaveBeenCalledWith(sessionId, SwitchReason.RateLimit429);
    });
  });

  describe('cost snapshots', () => {
    const COST_CLAUDE_ID = 'cccccccc-1111-2222-3333-444444444444';

    type CostDeps = ReturnType<typeof makeFakeDeps>['deps'];

    const buildLoop = (deps: CostDeps) => new LoopManager({
      rateLimitIntervalMs: 5000,
      healthIntervalMs: 5000,
      recoveryIntervalMs: 5000,
      idleIntervalMs: 5000,
      onThresholdBreach: vi.fn(),
      onCrashDetected: vi.fn(),
      onHealthResult: vi.fn(),
      onIdle: vi.fn(),
      deps: deps as unknown as LoopManagerDeps,
    });

    const knownSessionDeps = (deps: CostDeps, tmpDir: string): void => {
      const session = { ...deps.sessionManager.getActiveSession(), claude_session_id: COST_CLAUDE_ID, account: 'primary', cwd: tmpDir };
      deps.sessionManager.getActiveSession = vi.fn().mockReturnValue(session);
    };

    const writeTelemetry = (
      tmpDir: string,
      fields: { cost?: number; rateLimits?: boolean; model?: string; ctx?: number }
    ): void => {
      const body: Record<string, unknown> = {
        session_id: COST_CLAUDE_ID,
        transcript_path: join(tmpDir, 'projects', 'p', `${COST_CLAUDE_ID}.jsonl`),
        cwd: tmpDir,
      };
      if (fields.cost !== undefined) body.cost = { total_cost_usd: fields.cost };
      if (fields.model !== undefined) body.model = { id: fields.model };
      if (fields.ctx !== undefined) body.context_window = { context_window_size: fields.ctx };
      if (fields.rateLimits) {
        const future = Math.floor(Date.now() / 1000) + 3600;
        body.rate_limits = {
          five_hour: { used_percentage: 10, resets_at: future },
          seven_day: { used_percentage: 5, resets_at: future },
        };
      }
      writeFileSync(join(tmpDir, `statusline-${COST_CLAUDE_ID}.json`), JSON.stringify(body));
    };

    const tick = (lm: LoopManager, deps: CostDeps): void =>
      (lm as unknown as { rateLimitTick(d: LoopManagerDeps): void }).rateLimitTick(deps as unknown as LoopManagerDeps);

    const costEvents = (deps: CostDeps): Array<{ event_type: string; account?: string; claude_session_id?: string; details: Record<string, unknown> }> =>
      (deps.journal.append as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as { event_type: string; account?: string; claude_session_id?: string; details: Record<string, unknown> })
        .filter((e) => e.event_type === 'cost.snapshot');

    it('emits a cost.snapshot carrying segment identity even when rate_limits are absent', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      writeTelemetry(tmpDir, { cost: 5, model: 'claude-opus-4', ctx: 200000 }); // no rate_limits

      tick(buildLoop(deps), deps);

      const events = costEvents(deps);
      expect(events).toHaveLength(1);
      expect(events[0].claude_session_id).toBe(COST_CLAUDE_ID);
      expect(events[0].account).toBe('primary');
      expect(events[0].details.total_cost_usd).toBe(5);
      expect(events[0].details.model_id).toBe('claude-opus-4');
      expect(events[0].details.context_window_size).toBe(200000);
    });

    it('does not emit a cost.snapshot when telemetry has no cost field', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      writeTelemetry(tmpDir, { rateLimits: true }); // rate limits but no cost

      tick(buildLoop(deps), deps);

      expect(costEvents(deps)).toHaveLength(0);
    });

    it('emits only on an upward delta of at least $0.01', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      const lm = buildLoop(deps);

      writeTelemetry(tmpDir, { cost: 5.0 }); tick(lm, deps);   // emit (first)
      writeTelemetry(tmpDir, { cost: 5.005 }); tick(lm, deps); // sub-cent → no emit
      writeTelemetry(tmpDir, { cost: 5.5 }); tick(lm, deps);   // +0.50 → emit

      const events = costEvents(deps);
      expect(events.map((e) => e.details.total_cost_usd)).toEqual([5.0, 5.5]);
    });

    it('does not journal a downward reset at a segment boundary', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      const lm = buildLoop(deps);

      writeTelemetry(tmpDir, { cost: 5.0 }); tick(lm, deps); // emit
      writeTelemetry(tmpDir, { cost: 0.0 }); tick(lm, deps); // reset → no emit

      expect(costEvents(deps).map((e) => e.details.total_cost_usd)).toEqual([5.0]);
    });

    it('captureFinalCostSnapshot emits the last observed cost with the given trigger', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      const lm = buildLoop(deps);
      writeTelemetry(tmpDir, { cost: 5.0, model: 'claude-opus-4' }); tick(lm, deps);

      (lm as unknown as { captureFinalCostSnapshot(id: string, trigger: string): void })
        .captureFinalCostSnapshot('test-session-001', 'pre_switch');

      const lifecycle = costEvents(deps).filter((e) => e.details.trigger === 'pre_switch');
      expect(lifecycle).toHaveLength(1);
      expect(lifecycle[0].details.total_cost_usd).toBe(5.0);
      expect(lifecycle[0].claude_session_id).toBe(COST_CLAUDE_ID);
    });

    it('clearCostTracking removes cached cost so captureFinalCostSnapshot becomes a no-op', () => {
      const { tmpDir, deps } = makeFakeDeps();
      cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
      knownSessionDeps(deps, tmpDir);
      const lm = buildLoop(deps);
      writeTelemetry(tmpDir, { cost: 5.0 }); tick(lm, deps);

      (lm as unknown as { clearCostTracking(id: string): void }).clearCostTracking('test-session-001');
      (deps.journal.append as ReturnType<typeof vi.fn>).mockClear();
      (lm as unknown as { captureFinalCostSnapshot(id: string, trigger: string): void })
        .captureFinalCostSnapshot('test-session-001', 'pre_stop');

      expect(costEvents(deps)).toHaveLength(0);
    });
  });
});
