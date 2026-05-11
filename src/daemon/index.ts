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
import { buildLaunchCommand, buildResumeCommand, validateRunner } from '../runner/builder.js';
import { rehydrateSessions } from './rehydration.js';
import { setTmuxTimeoutHandler } from '../session/tmux.js';
import { SlackService } from '../slack/service.js';
import { RecoveryHandler } from './loops/recovery-handler.js';
import { SwitchReason } from '../failover/types.js';

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
  const tmuxSocket = 'aisup';

  const sessionManager = new SessionManager({
    tmuxSocket,
    stateDir: join(AISUP_DIR, 'sessions'),
    outputLogMaxSizeMb: config.session.output_log_max_size_mb,
    outputLogRetentionDays: config.session.output_log_retention_days,
  });

  let slackService: SlackService | null = null;
  if (config.slack.enabled) {
    const channelMapPath = join(AISUP_DIR, 'channel-map.json');
    slackService = new SlackService({
      config: config.slack,
      sessionManager,
      tmuxSocket,
      journal,
      channelMapPath,
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
    onSessionStart: (session) => slackService?.onSessionStart(session),
    onSessionStop: (session) => slackService?.onSessionStop(session.aisup_session_id),
  });

  await server.listen({ host: '127.0.0.1', port: config.daemon.port });

  await writePidFile(PID_PATH, { pid: process.pid, port: config.daemon.port });

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.started',
    details: { pid: process.pid, port: config.daemon.port },
  });

  const liveSessions = new Set(sessionManager.listTmuxSessions());

  await rehydrateSessions({
    stateDir: join(AISUP_DIR, 'sessions'),
    tmuxSocket,
    liveSessions,
    setSessionState: (session) => server.setSessionState(session),
    journal,
  });

  // Register tmux timeout handler — emits tmux.command_timeout journal events
  setTmuxTimeoutHandler((event) => {
    void journal.append({
      ts: new Date().toISOString(),
      event_type: 'tmux.command_timeout',
      details: { operation: event.operation, target: event.target, timeout_ms: event.timeoutMs },
    });
  });

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
      void journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.stop',
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
      tmuxSocket,
      journal,
      trackedSkills: config.skills.tracked,
      onOutputLogRotated: (sessionId, path) => {
        slackService?.resetRelayCursor(sessionId, path);
      },
      circuitBreaker,
      onSwitch: async (sessionId, reason) => {
        const state = sessionManager.getActiveSession();
        if (!state) return;
        const accounts = accountRegistry.getAll();
        const { performSwitch, selectSwitchTarget } = await import('../failover/switcher.js');
        const target = selectSwitchTarget(accounts, state.account, []);
        if (!target) {
          await journal.append({
            ts: new Date().toISOString(),
            event_type: 'failover.no_target_available',
            aisup_session_id: sessionId,
            details: {
              reason,
              terminal: true,
              from_account: state.account,
              excluded_accounts: [state.account],
              tried_accounts: [],
              source_runner_alive: true,
              earliest_cooldown_eta: null,
              requires_better_soft_target: reason === SwitchReason.SoftThreshold,
            },
          });
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
          {
            sessionManager,
            journal,
            createSessionForTarget: async (acct, snapshot) => {
              const cmd = snapshot.claudeSessionId
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
              return sessionManager.createSession({
                aisupSessionId: snapshot.aisupSessionId,
                account: acct.name,
                accountConfigDir: acct.configDir,
                command: cmd.command,
                args: cmd.args,
                env: cmd.env,
                cwd: state.cwd,
                planPath: snapshot.planFilePath,
              });
            },
          }
        );
        if (result.status === 'exhausted') {
          server.setSessionState({ status: 'EXHAUSTED', aisup_session_id: sessionId, hasTmux: false });
        } else if (result.status === 'completed' && result.targetAccount) {
          circuitBreaker.recordSuccess(result.targetAccount);
          accountRegistry.setState(result.targetAccount, 'HEALTHY', null);
        }
      },
      onRestart: async (sessionId) => {
        const state = sessionManager.readState(sessionId);
        if (!state) return;
        const account = accountRegistry.get(state.account);
        if (!account) return;
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
        } catch (err) {
          await journal.append({
            ts: new Date().toISOString(),
            event_type: 'recovery.failed',
            aisup_session_id: sessionId,
            details: { error: String(err), action: 'same_account_restart_failed' },
          });
        }
      },
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
