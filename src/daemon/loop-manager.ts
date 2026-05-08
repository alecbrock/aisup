import { RateLimitMonitor } from './loops/rate-limit-monitor.js';
import { RecoveryHandler, readLogTail, detect429InOutput } from './loops/recovery-handler.js';
import { HealthChecker, checkAccountHealth } from './loops/health-checker.js';
import { IdleWatchdog, isSessionIdle } from './loops/idle-watchdog.js';
import { isProcessDead } from '../session/tmux.js';
import { readTelemetryForActiveSession } from '../statusline/store.js';
import { selectSwitchTarget } from '../failover/switcher.js';
import { SwitchReason } from '../failover/types.js';
import type { SessionManager } from '../session/manager.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { JournalWriter } from '../journal/types.js';
import type { HealthCheckResult } from './loops/health-checker.js';
import type { ThresholdCheckResult } from './loops/rate-limit-monitor.js';

const RECOVERY_LOG_SCAN_BYTES = 65536; // 64KB
const RESTART_FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESTARTS_BEFORE_SWITCH = 3;

export interface LoopManagerDeps {
  sessionManager: SessionManager;
  accountRegistry: AccountRegistry;
  softPct: number;
  hardPct: number;
  idleBoundarySeconds: number;
  statuslineDir: string;
  statuslineFreshnessWindowS: number;
  tmuxSocket: string;
  journal: JournalWriter;
  /** Called when a loop determines a switch should be triggered. */
  onSwitch: (sessionId: string, reason: SwitchReason) => Promise<void>;
  /** Called when same-account restart should be triggered. */
  onRestart: (sessionId: string) => Promise<void>;
}

export interface LoopManagerOpts {
  rateLimitIntervalMs: number;
  healthIntervalMs: number;
  recoveryIntervalMs: number;
  idleIntervalMs: number;
  onThresholdBreach: (result: ThresholdCheckResult) => void;
  onCrashDetected: (sessionId: string, has429: boolean) => void;
  onHealthResult: (result: HealthCheckResult) => void;
  onIdle: (sessionId: string) => void;
  deps?: LoopManagerDeps;
}

export class LoopManager {
  rateLimitMonitor: RateLimitMonitor;
  recoveryHandler: RecoveryHandler;
  healthChecker: HealthChecker;
  idleWatchdog: IdleWatchdog;
  failoverInProgress = false;
  private deps: LoopManagerDeps | undefined;
  private onHealthResult: (result: HealthCheckResult) => void;
  private onIdle: (sessionId: string) => void;
  private restartAttempts = new Map<string, { count: number; firstAt: number }>();

  constructor(opts: LoopManagerOpts) {
    this.deps = opts.deps;
    this.onHealthResult = opts.onHealthResult;
    this.onIdle = opts.onIdle;
    this.rateLimitMonitor = new RateLimitMonitor({
      intervalMs: opts.rateLimitIntervalMs,
      onThresholdBreach: opts.onThresholdBreach,
    });
    this.recoveryHandler = new RecoveryHandler({
      intervalMs: opts.recoveryIntervalMs,
      onCrashDetected: opts.onCrashDetected,
    });
    this.healthChecker = new HealthChecker({
      intervalMs: opts.healthIntervalMs,
      onResult: opts.onHealthResult,
    });
    this.idleWatchdog = new IdleWatchdog({
      intervalMs: opts.idleIntervalMs,
      onIdle: opts.onIdle,
    });
  }

  startAll(): void {
    const d = this.deps;

    if (d) {
      this.rateLimitMonitor.start(() => this.rateLimitTick(d));
      this.recoveryHandler.start(() => void this.recoveryTick(d));
      this.healthChecker.start(() => this.healthTick(d));
      this.idleWatchdog.start(() => this.idleTick(d));
    } else {
      this.rateLimitMonitor.start();
      this.recoveryHandler.start();
      this.healthChecker.start();
      this.idleWatchdog.start();
    }
  }

  stopAll(): void {
    this.rateLimitMonitor.stop();
    this.recoveryHandler.stop();
    this.healthChecker.stop();
    this.idleWatchdog.stop();
  }

  private rateLimitTick(d: LoopManagerDeps): void {
    const session = d.sessionManager.getActiveSession();
    if (!session) return;

    const account = d.accountRegistry.get(session.account);
    if (!account) return;

    const telemetry = readTelemetryForActiveSession({
      launchStartedAt: session.launch_started_at,
      currentAccountConfigDir: account.configDir,
      expectedCwd: session.cwd,
      statuslineDir: d.statuslineDir,
      freshnessWindowS: d.statuslineFreshnessWindowS,
    });

    // Hydrate claude_session_id and transcript_path from telemetry when first available
    if (telemetry && !session.claude_session_id && telemetry.session_id) {
      d.sessionManager.patchState(session.aisup_session_id, {
        claude_session_id: telemetry.session_id,
        transcript_path: telemetry.transcript_path ?? null,
      });
    }

    if (!telemetry?.rate_limits) return;

    const result = this.rateLimitMonitor.tick(telemetry.rate_limits, d.softPct, d.hardPct);

    if (result.level === 'hard') {
      if (this.failoverInProgress) {
        void d.journal.append({
          ts: new Date().toISOString(),
          event_type: 'failover.skipped_concurrent',
          aisup_session_id: session.aisup_session_id,
          details: { reason: 'hard_threshold', level: 'hard' },
        });
        return;
      }
      this.failoverInProgress = true;
      void d.onSwitch(session.aisup_session_id, SwitchReason.HardThreshold).finally(() => {
        this.failoverInProgress = false;
      });
      return;
    }

    if (result.level === 'soft') {
      if (session.status === 'SWITCH_PENDING_AT_IDLE') {
        // Already pending — check if idle condition met
        if (isSessionIdle(session.output_log_path, d.idleBoundarySeconds)) {
          const accounts = d.accountRegistry.getAll();
          const target = selectSwitchTarget(accounts, session.account, []);
          if (!target) {
            d.sessionManager.patchState(session.aisup_session_id, { status: 'ACTIVE' });
            void d.journal.append({
              ts: new Date().toISOString(),
              event_type: 'failover.no_target_available',
              aisup_session_id: session.aisup_session_id,
              details: { terminal: false, reason: 'soft_threshold_idle_no_target' },
            });
            return;
          }
          if (this.failoverInProgress) return;
          this.failoverInProgress = true;
          void d.onSwitch(session.aisup_session_id, SwitchReason.SoftThreshold).finally(() => {
            this.failoverInProgress = false;
          });
        }
        return;
      }

      // Not yet pending — precheck target availability
      const accounts = d.accountRegistry.getAll();
      const target = selectSwitchTarget(accounts, session.account, []);
      if (!target) {
        void d.journal.append({
          ts: new Date().toISOString(),
          event_type: 'failover.no_target_available',
          aisup_session_id: session.aisup_session_id,
          details: { terminal: false, reason: 'soft_threshold_no_target' },
        });
        return;
      }
      d.sessionManager.patchState(session.aisup_session_id, { status: 'SWITCH_PENDING_AT_IDLE' });
    }
  }

  private healthTick(d: LoopManagerDeps): void {
    for (const account of d.accountRegistry.getAll()) {
      const result = checkAccountHealth(account);
      if (!result.configDirExists || !result.configDirWritable) {
        this.onHealthResult(result);
      }
    }
  }

  private idleTick(d: LoopManagerDeps): void {
    const session = d.sessionManager.getActiveSession();
    if (!session) return;
    if (isSessionIdle(session.output_log_path, d.idleBoundarySeconds)) {
      this.onIdle(session.aisup_session_id);
    }
  }

  private async recoveryTick(d: LoopManagerDeps): Promise<void> {
    const session = d.sessionManager.getActiveSession();
    if (!session) return;

    // Only process ACTIVE and SWITCH_PENDING_AT_IDLE sessions
    if (session.status !== 'ACTIVE' && session.status !== 'SWITCH_PENDING_AT_IDLE') return;

    const paneDead = isProcessDead(d.tmuxSocket, session.tmux_name);

    if (!paneDead) {
      // Pane alive — advance cursor to current EOF
      const cursor = this.recoveryHandler.getCursor(session.aisup_session_id);
      if (cursor) {
        try {
          const currentSize = RecoveryHandler.getFileSize(session.output_log_path);
          cursor.advance(currentSize);
        } catch { /* non-fatal */ }
      }
      return;
    }

    // Pane is dead — read log tail and check for 429
    const cursor = this.recoveryHandler.getCursor(session.aisup_session_id);
    const cursorOffset = cursor?.offset ?? 0;
    const logContent = readLogTail(session.output_log_path, cursorOffset, RECOVERY_LOG_SCAN_BYTES);
    const has429 = detect429InOutput(logContent);

    await d.journal.append({
      ts: new Date().toISOString(),
      event_type: 'failure.detected',
      aisup_session_id: session.aisup_session_id,
      details: { has429, source: 'recovery_handler', tmux_name: session.tmux_name },
    });

    if (has429 || session.status === 'SWITCH_PENDING_AT_IDLE') {
      // 429 crash or crash-while-pending → immediate account switch
      if (this.failoverInProgress) {
        void d.journal.append({
          ts: new Date().toISOString(),
          event_type: 'failover.skipped_concurrent',
          aisup_session_id: session.aisup_session_id,
          details: { reason: 'crash_detected' },
        });
        return;
      }
      this.failoverInProgress = true;
      this.restartAttempts.delete(session.aisup_session_id);
      const switchReason = has429 ? SwitchReason.RateLimit429 : SwitchReason.ProcessCrash;
      await d.onSwitch(session.aisup_session_id, switchReason).finally(() => {
        this.failoverInProgress = false;
      });
      return;
    }

    // No 429 — attempt same-account restart
    const attempts = this.restartAttempts.get(session.aisup_session_id);
    const now = Date.now();

    if (attempts && (now - attempts.firstAt) < RESTART_FAILURE_WINDOW_MS && attempts.count >= MAX_RESTARTS_BEFORE_SWITCH) {
      // Too many restarts — escalate to account switch
      this.restartAttempts.delete(session.aisup_session_id);
      if (this.failoverInProgress) return;
      this.failoverInProgress = true;
      await d.onSwitch(session.aisup_session_id, SwitchReason.RestartFailures).finally(() => {
        this.failoverInProgress = false;
      });
      return;
    }

    // Track this restart attempt
    if (!attempts || (now - attempts.firstAt) >= RESTART_FAILURE_WINDOW_MS) {
      this.restartAttempts.set(session.aisup_session_id, { count: 1, firstAt: now });
    } else {
      attempts.count += 1;
    }

    await d.onRestart(session.aisup_session_id);
  }
}
