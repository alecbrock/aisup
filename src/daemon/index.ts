import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { RotatingLog } from '../util/rotating-log.js';
import { loadConfig } from '../config/loader.js';
import { createJournalWriter } from '../journal/writer.js';
import { createDaemonServer } from './server.js';
import { writePidFile, removePidFile } from '../cli/pid.js';
import { LoopManager } from './loop-manager.js';
import { SessionManager } from '../session/manager.js';
import { AccountRegistry } from '../accounts/registry.js';
import { CircuitBreaker } from '../accounts/circuit-breaker.js';
import { refreshAccountScores } from '../accounts/refresh.js';
import { UsageLedger } from '../accounts/usage-ledger.js';
import { buildLaunchCommand, buildResumeCommand, validateRunner } from '../runner/builder.js';
import { rehydrateSessions } from './rehydration.js';
import { setTmuxTimeoutHandler, sendText, sendEnter, captureOutput } from '../session/tmux.js';
import { SlackService } from '../slack/service.js';
import { RecoveryHandler } from './loops/recovery-handler.js';
import { ExhaustedRecovery, resumeExhaustedSession } from '../recovery/exhausted.js';
import { PermissionDetector } from '../permissions/detector.js';
import { PermissionBroker } from '../permissions/broker.js';
import { runGates } from '../gates/engine.js';
import type { GateRunResult } from '../gates/types.js';
import { WorkerOrchestrator } from '../workers/orchestrator.js';
import { WorkerStore } from '../workers/store.js';
import { validateWorkerOutput } from '../workers/validation.js';
import { reviewWorkerOutput } from '../workers/review.js';
import { mergeWorkerOutput } from '../workers/merge.js';
import {
  resolveBaseSha,
  createWorktree,
  captureDiff,
  snapshotMainTree,
  auditBoundary,
  sanitizePatch,
  patchSha256,
  removeWorktree,
  isGitRepo,
  applyCheck,
  applyReverseCheck,
} from '../workers/worktree.js';
import { SwitchReason } from '../failover/types.js';
import type { SwitchSnapshot } from '../failover/types.js';
import type { LaunchMode } from '../failover/switcher.js';
import type { AccountInfo } from '../accounts/types.js';
import type { SessionState } from '../session/types.js';

const AISUP_DIR = join(homedir(), '.aisup');
const PID_PATH = join(AISUP_DIR, 'daemon.pid');
const TOKEN_PATH = join(AISUP_DIR, 'api-token');
const LOG_PATH = join(AISUP_DIR, 'daemon.log');

async function main(): Promise<void> {
  await mkdir(AISUP_DIR, { recursive: true, mode: 0o700 });

  const rotatingLog = new RotatingLog({ path: LOG_PATH, maxSizeMb: 10, maxFiles: 3 });
  process.stdout.write = (data: string | Uint8Array) => rotatingLog.write(data);
  process.stderr.write = (data: string | Uint8Array) => rotatingLog.write(data);

  const loadedConfig = await loadConfig();
  const config = {
    ...loadedConfig,
    runner: {
      ...loadedConfig.runner,
      command: validateRunner(loadedConfig.runner),
    },
  };
  const journal = createJournalWriter(config.journal.path);
  const accountRegistry = new AccountRegistry(config);
  const circuitBreaker = new CircuitBreaker({
    maxFailures: config.failover.circuit_breaker_max_failures,
    cooldownSeconds: config.failover.circuit_breaker_cooldown_seconds,
    statePath: join(AISUP_DIR, 'circuit-breaker-state.json'),
  });
  const tmuxSocket = config.session.tmux_socket;

  // Persistent per-account usage ledger: captures live usage while a session is active and decays
  // idle windows to 0% once their reset passes, so scoring/selection never trusts stale telemetry.
  const usageLedger = new UsageLedger(
    join(AISUP_DIR, 'usage-ledger.json'),
    config.statusline.freshness_window_s * 1000,
  );

  // Refresh account scores/state from telemetry (via the ledger) + circuit breaker before any
  // automatic selection decision (start admission, soft/hard failover). Without this, scores stay
  // null and the canonical selector falls back to priority order, ignoring scoring.
  const refreshAccounts = (): void => refreshAccountScores({
    registry: accountRegistry,
    statuslineDir: config.statusline.directory,
    freshnessWindowS: config.statusline.freshness_window_s,
    softPct: config.thresholds.soft_pct,
    hardPct: config.thresholds.hard_pct,
    circuitBreaker,
    ledger: usageLedger,
  });

  const sessionManager = new SessionManager({
    tmuxSocket,
    stateDir: join(AISUP_DIR, 'sessions'),
    outputLogMaxSizeMb: config.session.output_log_max_size_mb,
    outputLogRetentionDays: config.session.output_log_retention_days,
  });

  // Multi-LLM worker orchestrator (Phase 3) — gated by config.workers.enabled. Constructed before
  // the server so its handlers can be injected; rehydrated/started after session rehydration.
  let workerOrchestrator: WorkerOrchestrator | undefined;
  if (config.workers.enabled) {
    const workerStore = new WorkerStore(join(AISUP_DIR, 'workers'));
    workerOrchestrator = new WorkerOrchestrator({
      store: workerStore,
      config: config.workers,
      journal,
      worktreeOps: {
        resolveBaseSha,
        createWorktree,
        captureDiff,
        snapshotMainTree,
        auditBoundary,
        sanitizePatch,
        patchSha256,
        removeWorktree,
        isGitRepo,
        applyCheck,
        applyReverseCheck,
      },
      validateOutput: validateWorkerOutput,
      reviewOutput: reviewWorkerOutput,
      mergeOutput: mergeWorkerOutput,
      resolveActiveSessionCwd: () => sessionManager.getActiveSession()?.cwd ?? null,
    });
  }

  // Validation gates: run the configured executable/arg-array gates (manual via API/Slack/CLI,
  // automatic via the idle+skill trigger). The latest run is cached for GET /api/gates.
  let latestGateRun: GateRunResult | null = null;
  const runConfiguredGates = async (): Promise<GateRunResult> => {
    const active = sessionManager.getActiveSession();
    const result = await runGates(config.gates.gates, { journal, defaultCwd: active?.cwd });
    latestGateRun = result;
    return result;
  };

  let slackService: SlackService | null = null;
  if (config.slack.enabled) {
    const channelMapPath = join(AISUP_DIR, 'channel-map.json');
    slackService = new SlackService({
      config: config.slack,
      sessionManager,
      tmuxSocket,
      journal,
      channelMapPath,
      permissionsConfig: config.permissions,
      onPermissionGrant: (sessionId) => permissionBrokerRef?.resolveFromSlack(sessionId, 'grant') ?? Promise.resolve(false),
      onPermissionDeny: (sessionId) => permissionBrokerRef?.resolveFromSlack(sessionId, 'deny') ?? Promise.resolve(false),
      onGateRun: runConfiguredGates,
      getLatestGateRun: () => latestGateRun,
      onWorkerApprove: workerOrchestrator ? (id) => workerOrchestrator!.approve(id, 'slack') : undefined,
      onWorkerDeny: workerOrchestrator ? (id) => workerOrchestrator!.deny(id, 'slack') : undefined,
      getWorkerStatus: workerOrchestrator ? () => workerOrchestrator!.list() : undefined,
    });
  }

  const server = await createDaemonServer({
    tokenPath: TOKEN_PATH,
    host: '127.0.0.1',
    port: config.daemon.port,
    sessionManager,
    accountRegistry,
    journal,
    journalPath: config.journal.path,
    runner: config.runner,
    runGates: runConfiguredGates,
    getLatestGateRun: () => latestGateRun,
    dispatchWorker: workerOrchestrator ? (input) => workerOrchestrator!.dispatch(input) : undefined,
    listWorkers: workerOrchestrator ? () => workerOrchestrator!.list() : undefined,
    getWorker: workerOrchestrator ? (id) => workerOrchestrator!.get(id) : undefined,
    approveWorker: workerOrchestrator ? (id, by) => workerOrchestrator!.approve(id, by) : undefined,
    denyWorker: workerOrchestrator ? (id, by) => workerOrchestrator!.deny(id, by) : undefined,
    cancelWorker: workerOrchestrator ? (id) => workerOrchestrator!.cancel(id) : undefined,
    onSessionStart: (session) => slackService?.onSessionStart(session),
    onSessionStop: (session) => {
      // R13: a stopped session ends the recovery cycle — clear its restart + network windows.
      loopManagerRef?.clearRecoveryCounters(session.aisup_session_id);
      // A terminal stop also ends any EXHAUSTED auto-resume polling for the session.
      exhaustedRecoveryRef?.stop(session.aisup_session_id);
      return slackService?.onSessionStop(session.aisup_session_id);
    },
    refreshAccounts,
    statuslineDir: config.statusline.directory,
    statuslineFreshnessWindowS: config.statusline.freshness_window_s,
    usageLedger,
    // Lifecycle cost snapshots: stop/manual-failover live in server.ts, so the snapshot/cleanup
    // are injected from the loop manager (late-bound; no-op until it exists).
    captureCostSnapshot: (id, trigger) => loopManagerRef?.captureFinalCostSnapshot(id, trigger),
    clearCostTracking: (id) => loopManagerRef?.clearCostTracking(id),
  });

  await server.listen({ host: '127.0.0.1', port: config.daemon.port });

  await writePidFile(PID_PATH, { pid: process.pid, port: config.daemon.port });

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.started',
    details: { pid: process.pid, port: config.daemon.port },
  });

  // Late-bound LoopManager handle: onSwitch/onSessionStop are defined before the loop
  // manager exists (rehydration uses them), so they clear the recovery counters via
  // this ref (no-op during rehydration, before the manager is constructed).
  let loopManagerRef: LoopManager | undefined;
  let exhaustedRecoveryRef: ExhaustedRecovery | undefined;
  let permissionBrokerRef: PermissionBroker | undefined;

  // Shared target-launch callback: resume only when migration produced a valid transcript
  // in the target, else fresh. Used by both automatic failover and EXHAUSTED auto-resume.
  const createSessionForTarget = async (
    acct: AccountInfo,
    snapshot: SwitchSnapshot,
    launchMode: LaunchMode,
  ): Promise<SessionState> => {
    const cmd = (launchMode === 'resumed' && snapshot.claudeSessionId)
      ? buildResumeCommand(config.runner, acct.configDir, snapshot.claudeSessionId)
      : buildLaunchCommand(config.runner, acct.configDir);
    if (!snapshot.claudeSessionId) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.restart_fresh_no_session_id',
        aisup_session_id: snapshot.aisupSessionId,
        details: { account: acct.name, reason: snapshot.reason },
      });
    }
    const cwd = sessionManager.readState(snapshot.aisupSessionId)?.cwd ?? process.cwd();
    return sessionManager.createSession({
      aisupSessionId: snapshot.aisupSessionId,
      account: acct.name,
      accountConfigDir: acct.configDir,
      command: cmd.command,
      args: cmd.args,
      env: cmd.env,
      cwd,
      planPath: snapshot.planFilePath,
    });
  };

  // Daemon-level recovery callbacks. Defined before rehydration so the rehydration pass
  // can drive corrective recovery for interrupted switches and state-without-tmux sessions,
  // and reused as the LoopManager's onSwitch/onRestart. onSwitch reads readState(sessionId)
  // (not getActiveSession) so it can also act on mid-switch SWITCHING sessions.
  const onSwitch = async (sessionId: string, reason: SwitchReason): Promise<void> => {
    const state = sessionManager.readState(sessionId);
    if (!state) return;
    // R13: a switch ends the recovery cycle — clear its restart + network windows.
    loopManagerRef?.clearRecoveryCounters(sessionId);
    // Task 3: capture the pre-switch final cost snapshot before performSwitch destroys the source.
    loopManagerRef?.captureFinalCostSnapshot(sessionId, 'pre_switch');
    refreshAccounts();
    const accounts = accountRegistry.getAll();
    const { performSwitch, selectSwitchTarget, handleNoTarget } = await import('../failover/switcher.js');
    // Pass reason + the source's refreshed score so the actual switch honours the same
    // soft-threshold "strictly better target" rule the loop-manager precheck applied.
    const currentScore = accountRegistry.get(state.account)?.score ?? null;
    const target = selectSwitchTarget(accounts, state.account, [], { reason, currentScore });
    if (!target) {
      // Soft-threshold no-better-target is nonterminal; every other reason persists EXHAUSTED.
      const { terminal } = await handleNoTarget(
        { sessionId, fromAccount: state.account, reason, triedAccounts: [], sourceRunnerAlive: true },
        {
          sessionManager,
          journal,
          setSessionVisible: (s) => server.setSessionState(s),
          notifyExhausted: (id) => slackService?.onSessionExhausted(id, String(reason)),
        }
      );
      if (terminal) exhaustedRecoveryRef?.start(sessionId);
      return;
    }
    const result = await performSwitch(
      {
        aisupSessionId: sessionId,
        claudeSessionId: state.claude_session_id,
        transcriptPath: state.transcript_path,
        activeSkill: state.active_skill,
        planFilePath: state.plan_path,
        sourceAccount: state.account,
        targetAccount: target.name,
        reason,
        selectionMode: reason === SwitchReason.Manual ? 'manual' : 'automatic',
      },
      accounts,
      { sessionManager, journal, createSessionForTarget }
    );
    if (result.status === 'exhausted') {
      server.setSessionState({ status: 'EXHAUSTED', aisup_session_id: sessionId, hasTmux: false });
      exhaustedRecoveryRef?.start(sessionId);
    } else if (result.status === 'completed' && result.targetAccount) {
      circuitBreaker.recordSuccess(result.targetAccount);
      accountRegistry.setState(result.targetAccount, 'HEALTHY', null);
    }
  };

  const onRestart = async (sessionId: string): Promise<boolean> => {
    const state = sessionManager.readState(sessionId);
    if (!state) return false;
    const account = accountRegistry.get(state.account);
    if (!account) return false;
    const cmd = state.claude_session_id
      ? buildResumeCommand(config.runner, account.configDir, state.claude_session_id)
      : buildLaunchCommand(config.runner, account.configDir);
    if (!state.claude_session_id) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.restart_fresh_no_session_id',
        aisup_session_id: sessionId,
        details: { account: state.account },
      });
    }
    try {
      await sessionManager.restartInPlace(sessionId, cmd.command, cmd.args, cmd.env);
      return true;
    } catch (err) {
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.failed',
        aisup_session_id: sessionId,
        details: { error: String(err), action: 'same_account_restart_failed' },
      });
      return false;
    }
  };

  // EXHAUSTED auto-recovery: poll for a runnable account, then relaunch the persisted
  // session via the canonical performSwitch path (migration owns resume vs fresh). The
  // resume is never a bare state flip — onAccountAvailable reads the persisted source account.
  const exhaustedRecovery = new ExhaustedRecovery({
    circuitBreaker,
    accountRegistry,
    config: config.recovery,
    journal,
    // Refresh registry state from telemetry before the poller picks a resume target.
    refreshAccounts,
    onAccountAvailable: async (sessionId, account) => {
      // If the session already left EXHAUSTED (manual failover/stop/another resume), end polling.
      const current = sessionManager.readState(sessionId);
      if (!current || current.status !== 'EXHAUSTED') {
        exhaustedRecoveryRef?.stop(sessionId);
        return;
      }
      refreshAccounts();
      const { performSwitch } = await import('../failover/switcher.js');
      const ok = await resumeExhaustedSession(sessionId, account, {
        sessionManager,
        accounts: accountRegistry.getAll(),
        journal,
        performSwitch,
        switchDeps: { sessionManager, journal, createSessionForTarget },
        onResumed: (target) => {
          circuitBreaker.recordSuccess(target);
          accountRegistry.setState(target, 'HEALTHY', null);
        },
      });
      // Success ends polling; a failed relaunch leaves the session EXHAUSTED for the next tick.
      if (ok) exhaustedRecoveryRef?.stop(sessionId);
    },
  });
  exhaustedRecoveryRef = exhaustedRecovery;

  const liveSessions = new Set(sessionManager.listTmuxSessions());

  const { exhaustedSessionIds } = await rehydrateSessions({
    stateDir: join(AISUP_DIR, 'sessions'),
    tmuxSocket,
    liveSessions,
    setSessionState: (session) => server.setSessionState(session),
    journal,
    onSwitch,
    onRestart,
    statuslineDir: config.statusline.directory,
    statuslineFreshnessWindowS: config.statusline.freshness_window_s,
    accountConfigDir: (account) => accountRegistry.get(account)?.configDir,
  });

  // R8/Task 7 handoff: re-arm the exhausted poller for sessions rehydrated as EXHAUSTED.
  // start() is a no-op when auto_resume_exhausted is disabled.
  for (const sessionId of exhaustedSessionIds) exhaustedRecovery.start(sessionId);

  // Worker rehydration: reconcile interrupted workers (in-flight → FAILED, MERGING reconciled
  // against the patch) and pump any QUEUED workers (Phase 3, HI-003).
  if (workerOrchestrator) await workerOrchestrator.start();

  // Register tmux timeout handler — emits tmux.command_timeout journal events
  setTmuxTimeoutHandler((event) => {
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'tmux.command_timeout',
      details: { operation: event.operation, target: event.target, timeout_ms: event.timeoutMs },
    });
  });

  // Permission detection runs only when enabled; the empty config list falls back to the
  // detector's built-in default patterns. The broker (policy + Slack) is wired in onPermissionDetected.
  const permissionDetector = config.permissions.enabled
    ? new PermissionDetector(config.permissions.detection_patterns)
    : undefined;

  // Broker side effects (tmux keystrokes, Slack routing) live here, not in the pure policy.
  const permissionBroker = config.permissions.enabled
    ? new PermissionBroker({
        permissions: config.permissions,
        journal,
        sendKeystroke: (sessionId, key) => {
          const s = sessionManager.readState(sessionId);
          if (!s || (s.status !== 'ACTIVE' && s.status !== 'SWITCH_PENDING_AT_IDLE')) return false;
          sendText(tmuxSocket, s.tmux_name, key);
          sendEnter(tmuxSocket, s.tmux_name);
          return true;
        },
        promptStillActive: (sessionId) => {
          const s = sessionManager.readState(sessionId);
          if (!s) return false;
          const recent = captureOutput(tmuxSocket, s.tmux_name, 40);
          return new PermissionDetector(config.permissions.detection_patterns).scan(recent).length > 0;
        },
        routeToSlack: config.slack.enabled
          ? (sessionId, request) => { void slackService?.notifyPermissionRequest(sessionId, request); }
          : undefined,
      })
    : undefined;
  permissionBrokerRef = permissionBroker;

  const loopManager = new LoopManager({
    rateLimitIntervalMs: config.monitoring.rate_limit_interval_s * 1000,
    healthIntervalMs: config.monitoring.health_interval_s * 1000,
    recoveryIntervalMs: config.monitoring.recovery_interval_s * 1000,
    idleIntervalMs: config.monitoring.idle_interval_s * 1000,
    onThresholdBreach: (result) => {
      if (result.level !== 'none') {
        void journal.append({
          ts: new Date().toISOString(),
          event_type: 'rate_limit.threshold_crossed',
          details: {
            level: result.level,
            triggered_window: result.triggeredWindow,
            five_hour_pct: result.fiveHourPct ?? null,
            seven_day_pct: result.sevenDayPct ?? null,
            soft_pct: config.thresholds.soft_pct,
            hard_pct: config.thresholds.hard_pct,
            reset_eta: result.resetsAt?.toISOString() ?? null,
          },
        });
      }
    },
    onCrashDetected: (sessionId, has429) => {
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'failure.detected',
        aisup_session_id: sessionId,
        details: { has429, source: 'recovery_handler' },
      });
    },
    onHealthResult: (result) => {
      if (!result.configDirExists || !result.configDirWritable) {
        void journal.append({
          ts: new Date().toISOString(),
          event_type: 'failure.detected',
          details: { account: result.account, configDirExists: result.configDirExists, configDirWritable: result.configDirWritable },
        });
      }
    },
    onIdle: (sessionId) => {
      // Idle is observation, not a lifecycle stop. session.stop is reserved for terminal
      // user/API/Slack stop paths; idle emits the canonical non-lifecycle idle event.
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.idle_detected',
        aisup_session_id: sessionId,
        details: { reason: 'idle_timeout' },
      });
    },
    deps: {
      sessionManager,
      accountRegistry,
      softPct: config.thresholds.soft_pct,
      hardPct: config.thresholds.hard_pct,
      idleBoundarySeconds: config.thresholds.idle_boundary_seconds,
      statuslineDir: config.statusline.directory,
      statuslineFreshnessWindowS: config.statusline.freshness_window_s,
      usageLedger,
      tmuxSocket,
      networkErrorThreshold: config.recovery.network_error_threshold,
      journal,
      trackedSkills: config.skills.tracked,
      onOutputLogRotated: (sessionId, path) => {
        slackService?.resetRelayCursor(sessionId, path);
      },
      circuitBreaker,
      permissionDetector,
      onPermissionDetected: permissionBroker
        ? (sessionId, request) => { void permissionBroker.onDetected(sessionId, request); }
        : undefined,
      onGateTrigger: (config.gates.enabled && config.gates.trigger === 'idle_and_skill')
        ? async () => { await runConfiguredGates(); }
        : undefined,
      gateDebounceMs: config.gates.idle_delay_seconds * 1000,
      onSwitch,
      onRestart,
    },
  });

  // Init recovery handler cursor for any rehydrated session
  const activeSession = sessionManager.getActiveSession();
  if (activeSession) {
    const fileSize = RecoveryHandler.getFileSize(activeSession.output_log_path);
    // Live pane: start at EOF. Dead/missing pane: start at max(0, size - 64KB)
    const cursorOffset = liveSessions.has(activeSession.tmux_name)
      ? fileSize
      : Math.max(0, fileSize - 65536);
    loopManager.recoveryHandler.initCursor(
      activeSession.aisup_session_id,
      activeSession.output_log_path,
      cursorOffset
    );
  }

  loopManagerRef = loopManager;
  loopManager.startAll();

  server.setReady();

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.ready',
    details: {},
  });

  if (slackService) {
    void slackService.start().catch((err) => {
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'slack.connection_error',
        details: { error: String(err) },
      });
      slackService = null;
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    loopManager.stopAll();
    exhaustedRecovery.stopAll();
    if (slackService) { try { await slackService.stop(); } catch { /* best effort */ } }
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'daemon.stopped',
      details: { signal },
    });
    await server.close();
    await removePidFile(PID_PATH);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`[aisup daemon] fatal: ${String(err)}\n`);
  process.exit(1);
});
