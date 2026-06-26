import { RateLimitMonitor } from './loops/rate-limit-monitor.js';
import { RecoveryHandler, readLogTail, detect429InOutput } from './loops/recovery-handler.js';
import { detectAuthFailure, detectNetworkError } from '../recovery/patterns.js';
import type { PermissionDetector } from '../permissions/detector.js';
import type { PermissionRequest } from '../permissions/types.js';
import { HealthChecker, checkAccountHealth } from './loops/health-checker.js';
import { IdleWatchdog, isSessionIdle } from './loops/idle-watchdog.js';
import { isProcessDead, hasSession } from '../session/tmux.js';
import { readTelemetryForActiveSession } from '../statusline/store.js';
import { selectSwitchTarget } from '../failover/switcher.js';
import { refreshAccountScores } from '../accounts/refresh.js';
import type { UsageLedger } from '../accounts/usage-ledger.js';
import { SwitchReason } from '../failover/types.js';
import { detectSkill } from '../skills/detector.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionState } from '../session/types.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { CircuitBreaker } from '../accounts/circuit-breaker.js';
import type { JournalWriter } from '../journal/types.js';
import type { HealthCheckResult } from './loops/health-checker.js';
import type { ThresholdCheckResult } from './loops/rate-limit-monitor.js';
import type { StatuslineTelemetry } from '../statusline/types.js';

const RECOVERY_LOG_SCAN_BYTES = 65536; // 64KB
const RESTART_FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESTARTS_BEFORE_SWITCH = 3;
/** Default minimum interval between automatic gate runs for a session. */
const DEFAULT_GATE_DEBOUNCE_MS = 30 * 1000;
/** Minimum upward cost delta (USD) that is journaled as a periodic cost.snapshot. */
const COST_MIN_DELTA_USD = 0.01;

interface CostState {
  /** Latest observed cumulative cost for the active Claude segment. */
  observed: number;
  /** Last journaled (baseline) cost — upward deltas are measured from here. */
  emitted: number;
  modelId?: string;
  contextWindowSize?: number;
  claudeSessionId: string | null;
  account: string;
}

export interface LoopManagerDeps {
  sessionManager: SessionManager;
  accountRegistry: AccountRegistry;
  softPct: number;
  hardPct: number;
  idleBoundarySeconds: number;
  statuslineDir: string;
  statuslineFreshnessWindowS: number;
  /** Shared usage ledger so failover-time refresh uses decayed estimates, not stale telemetry. */
  usageLedger?: UsageLedger;
  tmuxSocket: string;
  /** Consecutive network errors required before escalating to a same-account restart. */
  networkErrorThreshold: number;
  journal: JournalWriter;
  trackedSkills?: string[];
  onOutputLogRotated?: (sessionId: string, path: string) => void;
  circuitBreaker?: CircuitBreaker;
  /** Called when a loop determines a switch should be triggered. */
  onSwitch: (sessionId: string, reason: SwitchReason) => Promise<void>;
  /** Called when same-account restart should be triggered. Returns true when the restart succeeded. */
  onRestart: (sessionId: string) => Promise<boolean>;
  /** Permission-prompt detector (present only when permissions are enabled). */
  permissionDetector?: PermissionDetector;
  /** Called for each detected permission prompt; the broker (policy/Slack) acts on it. */
  onPermissionDetected?: (sessionId: string, request: PermissionRequest) => void;
  /** Called when an idle session has a completed skill — runs validation gates (auto trigger). */
  onGateTrigger?: (sessionId: string, completedSkill: string) => Promise<void>;
  /** Minimum interval between automatic gate runs for a session (defaults to 30s). */
  gateDebounceMs?: number;
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
  /** Per-session consecutive network-error count; resets alongside restartAttempts. */
  private networkErrors = new Map<string, number>();
  private lastNoTargetNotice = new Map<string, number>();
  /** Sessions for which the current continuous idle period has already emitted onIdle. */
  private idleEmitted = new Set<string>();
  /** Last automatic gate-run time per session (debounce window). */
  private lastGateRun = new Map<string, number>();
  /** Per-session cost tracking for delta-filtered periodic + lifecycle cost snapshots. */
  private costState = new Map<string, CostState>();

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

    const telemetryResult = readTelemetryForActiveSession(
      session,
      account.configDir,
      d.statuslineDir,
      d.statuslineFreshnessWindowS
    );
    const telemetry = telemetryResult.telemetry;

    if (!telemetry && telemetryResult.mismatch) {
      // Safe expected/observed identity for diagnosis — the reason string carries the
      // observed criteria (session id / transcript path), never transcript contents.
      void d.journal.append({
        ts: new Date().toISOString(),
        event_type: 'telemetry.session_mismatch',
        aisup_session_id: session.aisup_session_id,
        details: {
          reason: telemetryResult.mismatch,
          expected_account: session.account,
          expected_session_id: session.claude_session_id,
          expected_cwd: session.cwd,
        },
      });
    }

    if (!telemetry && telemetryResult.invalidJson) {
      // R7/R12: malformed telemetry file for the active session — safe parse summary
      // plus freshness context, never the file contents.
      void d.journal.append({
        ts: new Date().toISOString(),
        event_type: 'telemetry.invalid_json',
        aisup_session_id: session.aisup_session_id,
        details: {
          account: session.account,
          error: telemetryResult.invalidJson.error,
          stale: telemetryResult.invalidJson.stale,
        },
      });
    }

    // Hydrate claude_session_id and transcript_path from telemetry when first available
    if (telemetry && !session.claude_session_id && telemetry.session_id) {
      d.sessionManager.patchState(session.aisup_session_id, {
        claude_session_id: telemetry.session_id,
        transcript_path: telemetry.transcript_path ?? null,
      });
    }

    // Cost snapshot — captured BEFORE the rate_limits guard so cost is recorded even when
    // rate-limit telemetry is temporarily absent (Task 3).
    if (telemetry) this.trackCost(d, session, telemetry);

    if (!telemetry?.rate_limits) return;

    const result = this.rateLimitMonitor.tick(telemetry.rate_limits, d.softPct, d.hardPct);

    if (result.level === 'hard') {
      // AF-324: a single boolean guard is adequate here — the monitor loops run on one Node event-loop
      // thread, so the check-then-set below is atomic (no await between them); `.finally` clears the flag
      // when the switch settles. Overlapping ticks observe `failoverInProgress=true` and skip.
      if (this.failoverInProgress) {
        void d.journal.append({
          ts: new Date().toISOString(),
          event_type: 'failover.skipped_concurrent',
          aisup_session_id: session.aisup_session_id,
          details: { reason: 'hard_threshold', level: 'hard' },
        });
        return;
      }
      this.recordRateLimitFailure(d, session.account, session.aisup_session_id, 'hard_threshold');
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
          this.refreshAccounts(d);
          const accounts = d.accountRegistry.getAll();
          const target = selectSwitchTarget(accounts, session.account, [], {
            reason: SwitchReason.SoftThreshold,
            currentScore: currentTelemetryScore(telemetry),
          });
          if (!target) {
            d.sessionManager.patchState(session.aisup_session_id, { status: 'ACTIVE' });
            this.appendNoTarget(d, session.aisup_session_id, {
              terminal: false,
              reason: 'soft_threshold_idle_no_target',
              from_account: session.account,
              excluded_accounts: [session.account],
              tried_accounts: [],
              source_runner_alive: true,
              earliest_cooldown_eta: null,
              requires_better_soft_target: true,
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
      this.refreshAccounts(d);
      const accounts = d.accountRegistry.getAll();
      const target = selectSwitchTarget(accounts, session.account, [], {
        reason: SwitchReason.SoftThreshold,
        currentScore: currentTelemetryScore(telemetry),
      });
      if (!target) {
        this.appendNoTarget(d, session.aisup_session_id, {
          terminal: false,
          reason: 'soft_threshold_no_target',
          from_account: session.account,
          excluded_accounts: [session.account],
          tried_accounts: [],
          source_runner_alive: true,
          earliest_cooldown_eta: null,
          requires_better_soft_target: true,
        });
        return;
      }
      d.sessionManager.patchState(session.aisup_session_id, { status: 'SWITCH_PENDING_AT_IDLE' });
    }
  }

  /**
   * Track cost telemetry for the active session and journal a periodic `cost.snapshot` only on a
   * meaningful upward delta. A downward delta is the expected reset at a segment boundary (account
   * switch / new transcript) and is re-baselined silently — the new segment is journaled as it
   * accrues upward again. Every event carries `claude_session_id`/`account` so Task 4 can segment.
   */
  private trackCost(d: LoopManagerDeps, session: SessionState, telemetry: StatuslineTelemetry): void {
    const cost = telemetry.cost?.total_cost_usd;
    if (typeof cost !== 'number') return;

    const id = session.aisup_session_id;
    const claudeSessionId = telemetry.session_id ?? session.claude_session_id ?? null;
    const modelId = telemetry.model?.id;
    const contextWindowSize = telemetry.context_window?.context_window_size;
    const prev = this.costState.get(id);

    if (prev === undefined) {
      this.costState.set(id, { observed: cost, emitted: cost, modelId, contextWindowSize, claudeSessionId, account: session.account });
      if (cost >= COST_MIN_DELTA_USD) this.appendCostSnapshot(d, id, 'periodic');
      return;
    }

    const entry: CostState = { observed: cost, emitted: prev.emitted, modelId, contextWindowSize, claudeSessionId, account: session.account };
    if (cost - prev.emitted >= COST_MIN_DELTA_USD) {
      entry.emitted = cost; // re-baseline at the journaled value so increments accumulate
      this.costState.set(id, entry);
      this.appendCostSnapshot(d, id, 'periodic');
    } else if (cost < prev.emitted) {
      entry.emitted = cost; // downward reset at a segment boundary — re-baseline silently
      this.costState.set(id, entry);
    } else {
      this.costState.set(id, entry); // sub-threshold upward — keep baseline, refresh metadata
    }
  }

  /**
   * Emit a final (unconditional) cost snapshot at a lifecycle boundary (pre-switch, pre-stop,
   * pre-manual-failover) using the last observed periodic cost. When a boundary cannot read fresh
   * telemetry (e.g. the pane is already gone) this last-periodic value is the documented fallback
   * rather than silently omitting cost. No-op when no cost has been observed for the session.
   */
  captureFinalCostSnapshot(sessionId: string, trigger: string): void {
    if (!this.deps || !this.costState.has(sessionId)) return;
    this.appendCostSnapshot(this.deps, sessionId, trigger);
  }

  /** Drop a session's cost tracking on terminal stop. */
  clearCostTracking(sessionId: string): void {
    this.costState.delete(sessionId);
  }

  private appendCostSnapshot(d: LoopManagerDeps, sessionId: string, trigger: string): void {
    const entry = this.costState.get(sessionId);
    if (!entry) return;
    void d.journal.append({
      ts: new Date().toISOString(),
      event_type: 'cost.snapshot',
      aisup_session_id: sessionId,
      claude_session_id: entry.claudeSessionId ?? undefined,
      account: entry.account,
      details: {
        total_cost_usd: entry.observed,
        model_id: entry.modelId ?? null,
        context_window_size: entry.contextWindowSize ?? null,
        trigger,
      },
    });
  }

  private healthTick(d: LoopManagerDeps): void {
    for (const account of d.accountRegistry.getAll()) {
      const result = checkAccountHealth(account, d.statuslineDir);
      if (!result.configDirExists || !result.configDirWritable || !result.claudeJsonReadable || !result.statuslineDirReadable) {
        this.onHealthResult(result);
      }
    }
  }

  private idleTick(d: LoopManagerDeps): void {
    const session = d.sessionManager.getActiveSession();
    if (!session) return;
    const sessionId = session.aisup_session_id;
    if (isSessionIdle(session.output_log_path, d.idleBoundarySeconds)) {
      // Emit once when the idle period begins; subsequent idle ticks are throttled
      // until activity resumes (lastIdleEmit semantics) to avoid journal spam.
      if (!this.idleEmitted.has(sessionId)) {
        this.idleEmitted.add(sessionId);
        this.onIdle(sessionId);
      }
      // Gate trigger: idle plus a completed (non-null) skill. Clear the skill so a given
      // completion fires once; the debounce window guards against rapid re-triggers.
      if (d.onGateTrigger && session.active_skill) {
        const now = Date.now();
        const debounceMs = d.gateDebounceMs ?? DEFAULT_GATE_DEBOUNCE_MS;
        if (now - (this.lastGateRun.get(sessionId) ?? 0) >= debounceMs) {
          this.lastGateRun.set(sessionId, now);
          const completedSkill = session.active_skill;
          d.sessionManager.patchState(sessionId, { active_skill: null });
          // Skill completion is a meaningful state change: clear idleEmitted so the next idle tick
          // re-fires onIdle for the post-completion idle period instead of staying suppressed (AF-311).
          this.idleEmitted.delete(sessionId);
          void d.onGateTrigger(sessionId, completedSkill);
        }
      }
    } else {
      this.idleEmitted.delete(sessionId);
    }
  }

  private async recoveryTick(d: LoopManagerDeps): Promise<void> {
    const session = d.sessionManager.getActiveSession();
    if (!session) return;

    // Only process ACTIVE and SWITCH_PENDING_AT_IDLE sessions — auth/network/429 output
    // detection therefore does not run for EXHAUSTED, SWITCHING, CREATING, or STOPPING.
    if (session.status !== 'ACTIVE' && session.status !== 'SWITCH_PENDING_AT_IDLE') return;

    const rotation = d.sessionManager.rotateOutputLogIfNeeded?.(session.aisup_session_id) ?? { rotated: false, path: session.output_log_path };
    if (rotation.rotated) {
      this.recoveryHandler.initCursor(session.aisup_session_id, rotation.path, 0);
      d.onOutputLogRotated?.(session.aisup_session_id, rotation.path);
      await d.journal.append({
        ts: new Date().toISOString(),
        event_type: 'output_log.rotated',
        aisup_session_id: session.aisup_session_id,
        details: { path: rotation.path, rotated_path: rotation.rotatedPath ?? null },
      });
    }

    // R11: an externally destroyed tmux session container is distinct from a dead
    // runner pane. Check container existence before reading pane liveness.
    if (!hasSession(d.tmuxSocket, session.tmux_name)) {
      const cursor = this.recoveryHandler.getCursor(session.aisup_session_id);
      const logContent = readLogTail(session.output_log_path, cursor?.offset ?? 0, RECOVERY_LOG_SCAN_BYTES);
      const has429 = detect429InOutput(logContent);
      await d.journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.destroyed_externally',
        aisup_session_id: session.aisup_session_id,
        details: { has429, source: 'recovery_handler', tmux_name: session.tmux_name },
      });
      await this.handleDeadSessionRecovery(d, session, has429);
      return;
    }

    const paneDead = isProcessDead(d.tmuxSocket, session.tmux_name);

    if (!paneDead) {
      // Pane is alive → any prior crash is resolved; clear the crash-restart counter (this is how
      // genuine recovery is confirmed — NOT merely onRestart() returning true, which a launch-then-
      // exit runner also does while flapping). networkErrors has its own lifecycle, not cleared here.
      this.restartAttempts.delete(session.aisup_session_id);
      // Pane alive — scan new output before advancing cursor.
      let cursor = this.recoveryHandler.getCursor(session.aisup_session_id);
      if (!cursor) {
        this.recoveryHandler.initCursor(session.aisup_session_id, session.output_log_path, RecoveryHandler.getFileSize(session.output_log_path));
        cursor = this.recoveryHandler.getCursor(session.aisup_session_id);
      }
      if (cursor) {
        try {
          const currentSize = RecoveryHandler.getFileSize(session.output_log_path);
          const output = readLogTail(session.output_log_path, cursor.offset, RECOVERY_LOG_SCAN_BYTES);
          if (output) {
            const detectedSkill = detectSkill(output, d.trackedSkills ?? []);
            if (detectedSkill && detectedSkill !== session.active_skill) {
              d.sessionManager.patchState(session.aisup_session_id, { active_skill: detectedSkill });
              await d.journal.append({
                ts: new Date().toISOString(),
                event_type: 'skill.detected',
                aisup_session_id: session.aisup_session_id,
                details: { skill: detectedSkill, previous_skill: session.active_skill },
              });
            }

            // Permission prompts are observed and routed to the broker, but never block a
            // higher-priority 429/auth recovery action — detect first, then fall through.
            if (d.permissionDetector) {
              for (const request of d.permissionDetector.scan(output)) {
                await d.journal.append({
                  ts: new Date().toISOString(),
                  event_type: 'permission.detected',
                  aisup_session_id: session.aisup_session_id,
                  details: { tool: request.tool, detail: request.detail },
                });
                d.onPermissionDetected?.(session.aisup_session_id, request);
              }
            }

            // Detection priority: auth failure → 429 → network error escalation.
            // An auth failure is terminal for the account, so it switches immediately.
            if (detectAuthFailure(output)) {
              cursor.advance(currentSize);
              await d.journal.append({
                ts: new Date().toISOString(),
                event_type: 'failure.auth_detected',
                aisup_session_id: session.aisup_session_id,
                details: { source: 'live_output', tmux_name: session.tmux_name },
              });
              if (this.failoverInProgress) {
                await d.journal.append({
                  ts: new Date().toISOString(),
                  event_type: 'failover.skipped_concurrent',
                  aisup_session_id: session.aisup_session_id,
                  details: { reason: 'live_auth_detected' },
                });
                return;
              }
              // Record an account-level failure so a persistently broken account cools
              // down rather than being re-selected into a switch-back loop.
              this.recordRateLimitFailure(d, session.account, session.aisup_session_id, 'live_auth');
              this.failoverInProgress = true;
              await d.onSwitch(session.aisup_session_id, SwitchReason.AuthFailure).finally(() => {
                this.failoverInProgress = false;
              });
              return;
            }

            if (detect429InOutput(output)) {
              cursor.advance(currentSize);
              await d.journal.append({
                ts: new Date().toISOString(),
                event_type: 'failure.detected',
                aisup_session_id: session.aisup_session_id,
                details: { has429: true, source: 'live_output', tmux_name: session.tmux_name },
              });
              if (this.failoverInProgress) {
                await d.journal.append({
                  ts: new Date().toISOString(),
                  event_type: 'failover.skipped_concurrent',
                  aisup_session_id: session.aisup_session_id,
                  details: { reason: 'live_429_detected' },
                });
                return;
              }
              this.recordRateLimitFailure(d, session.account, session.aisup_session_id, 'live_429');
              this.failoverInProgress = true;
              await d.onSwitch(session.aisup_session_id, SwitchReason.RateLimit429).finally(() => {
                this.failoverInProgress = false;
              });
              return;
            }

            // Network errors are transient: count them and escalate to a same-account
            // restart once they reach the threshold. A failed restart escalates to a
            // switch (NetworkError). Counters reset on switch/stop/successful restart.
            if (detectNetworkError(output)) {
              cursor.advance(currentSize);
              const count = (this.networkErrors.get(session.aisup_session_id) ?? 0) + 1;
              this.networkErrors.set(session.aisup_session_id, count);
              await d.journal.append({
                ts: new Date().toISOString(),
                event_type: 'failure.network_detected',
                aisup_session_id: session.aisup_session_id,
                details: { source: 'live_output', tmux_name: session.tmux_name, count, threshold: d.networkErrorThreshold },
              });
              if (count >= d.networkErrorThreshold) {
                this.networkErrors.delete(session.aisup_session_id);
                if (this.failoverInProgress) {
                  await d.journal.append({
                    ts: new Date().toISOString(),
                    event_type: 'failover.skipped_concurrent',
                    aisup_session_id: session.aisup_session_id,
                    details: { reason: 'live_network_threshold' },
                  });
                  return;
                }
                const restarted = await d.onRestart(session.aisup_session_id);
                if (restarted) {
                  this.restartAttempts.delete(session.aisup_session_id);
                } else {
                  this.failoverInProgress = true;
                  await d.onSwitch(session.aisup_session_id, SwitchReason.NetworkError).finally(() => {
                    this.failoverInProgress = false;
                  });
                }
              }
              return;
            }

            // Clean output (no auth/429/network signal) — the runner is producing
            // normal output, so the transient network-error window has recovered.
            this.networkErrors.delete(session.aisup_session_id);
          }
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

    await this.handleDeadSessionRecovery(d, session, has429);
  }

  /**
   * Shared recovery matrix for a non-running session — whether the runner pane died
   * or the tmux container was destroyed externally. Routes through switch-on-429,
   * switch-while-pending, restart-escalation, or same-account restart.
   */
  private async handleDeadSessionRecovery(d: LoopManagerDeps, session: SessionState, has429: boolean): Promise<void> {
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
      this.networkErrors.delete(session.aisup_session_id);
      const switchReason = has429 ? SwitchReason.RateLimit429 : SwitchReason.ProcessCrash;
      if (has429) this.recordRateLimitFailure(d, session.account, session.aisup_session_id, 'crash_429');
      await d.onSwitch(session.aisup_session_id, switchReason).finally(() => {
        this.failoverInProgress = false;
      });
      return;
    }

    // No 429 — same-account restart, bounded by a rolling window. Count EVERY crash pass, not only
    // outright restart failures: a runner that launches then immediately exits makes onRestart()
    // return true (a pane was spawned) yet re-enters here next tick, which previously cleared the
    // counter and looped forever. Genuine recovery is instead confirmed by the pane being alive on a
    // later tick (which clears the counter above).
    const now = Date.now();
    const attempts = this.restartAttempts.get(session.aisup_session_id);
    if (!attempts || (now - attempts.firstAt) >= RESTART_FAILURE_WINDOW_MS) {
      // First crash, or the previous window has rolled over — start a fresh window.
      this.restartAttempts.set(session.aisup_session_id, { count: 1, firstAt: now });
    } else {
      attempts.count += 1;
    }
    const count = this.restartAttempts.get(session.aisup_session_id)?.count ?? 0;

    // Attempt a same-account restart on each pass up to the cap.
    const restarted = await d.onRestart(session.aisup_session_id);
    if (count < MAX_RESTARTS_BEFORE_SWITCH) {
      if (restarted) this.networkErrors.delete(session.aisup_session_id);
      return; // under the cap — if the restart holds, the next alive tick clears the counter
    }

    // count >= cap within the window: a failing OR flapping (launch-then-exit) runner. Stop
    // same-account restarts, record a circuit-breaker failure (trips → COOLDOWN + Slack alert via
    // the exhausted/no-target path when no account remains), and escalate to a switch.
    this.restartAttempts.delete(session.aisup_session_id);
    this.recordRateLimitFailure(d, session.account, session.aisup_session_id, 'restart_failures');
    if (this.failoverInProgress) return;
    this.failoverInProgress = true;
    await d.onSwitch(session.aisup_session_id, SwitchReason.RestartFailures).finally(() => {
      this.failoverInProgress = false;
    });
  }

  /** Clear a session's recovery counters (restart-failure window + network-error window)
   *  — on successful recovery, session stop, or switch. */
  clearRecoveryCounters(sessionId: string): void {
    // Clear ALL per-session collections so a long-running daemon doesn't leak one entry per
    // session-id over its lifetime (AF-304).
    this.restartAttempts.delete(sessionId);
    this.networkErrors.delete(sessionId);
    this.lastNoTargetNotice.delete(sessionId);
    this.lastGateRun.delete(sessionId);
    this.costState.delete(sessionId);
    this.idleEmitted.delete(sessionId);
  }

  /** Refresh scores/state from telemetry + circuit breaker before a failover selection. */
  private refreshAccounts(d: LoopManagerDeps): void {
    refreshAccountScores({
      registry: d.accountRegistry,
      statuslineDir: d.statuslineDir,
      freshnessWindowS: d.statuslineFreshnessWindowS,
      softPct: d.softPct,
      hardPct: d.hardPct,
      circuitBreaker: d.circuitBreaker,
      ledger: d.usageLedger,
    });
  }

  private appendNoTarget(d: LoopManagerDeps, sessionId: string, details: Record<string, unknown>): void {
    const now = Date.now();
    const last = this.lastNoTargetNotice.get(sessionId) ?? 0;
    if (now - last < 60_000) return;
    this.lastNoTargetNotice.set(sessionId, now);
    void d.journal.append({
      ts: new Date().toISOString(),
      event_type: 'failover.no_target_available',
      aisup_session_id: sessionId,
      details,
    });
  }

  private recordRateLimitFailure(d: LoopManagerDeps, account: string, sessionId: string, reason: string): void {
    if (!d.circuitBreaker) return;
    const before = d.circuitBreaker.getState(account);
    d.circuitBreaker.recordFailure(account);
    const after = d.circuitBreaker.getState(account);
    if (after === 'OPEN') {
      const eta = d.circuitBreaker.getCooldownEta(account);
      d.accountRegistry.setState(account, 'COOLDOWN', eta);
      if (before !== 'OPEN') {
        void d.journal.append({
          ts: new Date().toISOString(),
          event_type: 'circuit_breaker.tripped',
          aisup_session_id: sessionId,
          details: { account, reason, cooldown_until: eta?.toISOString() ?? null },
        });
      }
    }
  }
}

function currentTelemetryScore(telemetry: { rate_limits?: { five_hour?: { used_percentage: number }; seven_day?: { used_percentage: number } } } | null): number | null {
  const five = telemetry?.rate_limits?.five_hour?.used_percentage;
  const seven = telemetry?.rate_limits?.seven_day?.used_percentage;
  if (typeof five !== 'number' || typeof seven !== 'number') return null;
  return (100 - five) * 0.7 + (100 - seven) * 0.3;
}
