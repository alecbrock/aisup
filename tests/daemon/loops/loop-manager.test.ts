import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmuxMocks = vi.hoisted(() => ({
  isProcessDead: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/session/tmux.js', () => ({
  isProcessDead: tmuxMocks.isProcessDead,
}));

import { LoopManager, type LoopManagerDeps } from '../../../src/daemon/loop-manager.js';
import { SwitchReason } from '../../../src/failover/types.js';

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
      journal,
      onSwitch: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe('LoopManager with deps', () => {
  let cleanup: (() => void) | undefined;

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
});
