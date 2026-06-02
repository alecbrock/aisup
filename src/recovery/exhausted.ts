import { SwitchReason } from '../failover/types.js';
import type { CircuitBreaker, CBState } from '../accounts/circuit-breaker.js';
import type { AccountRegistry } from '../accounts/registry.js';
import type { JournalWriter } from '../journal/types.js';
import type { RecoveryConfig } from '../config/schema.js';
import type { AccountInfo } from '../accounts/types.js';
import type { SwitchSnapshot } from '../failover/types.js';
import type { SwitchResult, SwitchDeps } from '../failover/switcher.js';
import type { SessionManager } from '../session/manager.js';

export interface ExhaustedRecoveryDeps {
  circuitBreaker: CircuitBreaker;
  accountRegistry: AccountRegistry;
  config: RecoveryConfig;
  journal: JournalWriter;
  /** Perform the real relaunch for `sessionId` onto a now-runnable `account`. */
  onAccountAvailable: (sessionId: string, account: string) => Promise<void>;
  /** Refresh account scores/registry state from telemetry before a resume target is selected. */
  refreshAccounts?: () => void;
}

interface PollEntry {
  attempts: number;
  inFlight: boolean;
  handle: ReturnType<typeof setInterval>;
}

/**
 * Polls for a runnable account so a persisted `EXHAUSTED` session can be auto-resumed.
 * The poller never flips state itself — it delegates the relaunch to `onAccountAvailable`
 * and bounds attempts by `config.max_exhausted_retries`. A successful resume is signalled
 * by the resume action calling `stop(sessionId)`; if the entry is still armed after an
 * attempt, that attempt is counted as a failure.
 */
export class ExhaustedRecovery {
  private deps: ExhaustedRecoveryDeps;
  private polls = new Map<string, PollEntry>();

  constructor(deps: ExhaustedRecoveryDeps) {
    this.deps = deps;
  }

  /** Begin polling for a runnable account to resume an EXHAUSTED session. */
  start(sessionId: string): void {
    if (!this.deps.config.auto_resume_exhausted) return;
    if (this.polls.has(sessionId)) return;
    const intervalMs = this.deps.config.exhausted_poll_interval_s * 1000;
    const handle = setInterval(() => { void this.pollOnce(sessionId).catch(() => {}); }, intervalMs);
    handle.unref?.();
    this.polls.set(sessionId, { attempts: 0, inFlight: false, handle });
    void this.deps.journal.append({
      ts: new Date().toISOString(),
      event_type: 'recovery.exhausted_polling_started',
      aisup_session_id: sessionId,
      details: { poll_interval_s: this.deps.config.exhausted_poll_interval_s },
    });
  }

  /** Stop polling for a session — on resume, manual stop, manual failover, or max retries. */
  stop(sessionId: string): void {
    const entry = this.polls.get(sessionId);
    if (!entry) return;
    clearInterval(entry.handle);
    this.polls.delete(sessionId);
    void this.deps.journal.append({
      ts: new Date().toISOString(),
      event_type: 'recovery.exhausted_polling_stopped',
      aisup_session_id: sessionId,
      details: {},
    });
  }

  /** Stop all polling (daemon shutdown). */
  stopAll(): void {
    for (const sessionId of [...this.polls.keys()]) this.stop(sessionId);
  }

  isPolling(sessionId: string): boolean {
    return this.polls.has(sessionId);
  }

  /**
   * First account that is both registry-eligible (enabled + HEALTHY/DEGRADED, the canonical
   * failover filter) and whose circuit breaker is runnable (CLOSED or HALF_OPEN). Registry
   * state is consulted so a telemetry-driven UNAVAILABLE/COOLDOWN account is never chosen as a
   * resume target — relaunching into one would immediately re-fail.
   */
  private findRunnableAccount(): string | null {
    for (const acct of this.deps.accountRegistry.getAll()) {
      if (!acct.enabled) continue;
      if (acct.state !== 'HEALTHY' && acct.state !== 'DEGRADED') continue;
      const cb: CBState = this.deps.circuitBreaker.getState(acct.name);
      if (cb === 'CLOSED' || cb === 'HALF_OPEN') return acct.name;
    }
    return null;
  }

  private async pollOnce(sessionId: string): Promise<void> {
    const entry = this.polls.get(sessionId);
    if (!entry || entry.inFlight) return;
    // Refresh scores/state from telemetry first so selection reflects current eligibility,
    // not a stale snapshot from a prior tick.
    this.deps.refreshAccounts?.();
    const account = this.findRunnableAccount();
    if (!account) return; // still cooling down — keep polling

    entry.inFlight = true;
    entry.attempts += 1;
    const attempt = entry.attempts;
    try {
      await this.deps.onAccountAvailable(sessionId, account);
    } catch (err) {
      await this.deps.journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.failed',
        aisup_session_id: sessionId,
        details: { error: String(err), action: 'exhausted_resume_failed' },
      });
    } finally {
      entry.inFlight = false;
    }

    // A successful resume removes the entry (the resume action calls stop()). If it is
    // still armed, the attempt failed — escalate to max-retries once the budget is spent.
    if (!this.polls.has(sessionId)) return;
    if (attempt >= this.deps.config.max_exhausted_retries) {
      await this.deps.journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.exhausted_max_retries',
        aisup_session_id: sessionId,
        details: { attempts: attempt, max_retries: this.deps.config.max_exhausted_retries },
      });
      this.stop(sessionId);
    }
  }
}

export interface ResumeExhaustedDeps {
  sessionManager: Pick<SessionManager, 'readState'>;
  accounts: AccountInfo[];
  journal: JournalWriter;
  performSwitch: (snapshot: SwitchSnapshot, accounts: AccountInfo[], deps: SwitchDeps) => Promise<SwitchResult>;
  switchDeps: SwitchDeps;
  /** Record breaker/registry success for the resumed target. */
  onResumed?: (targetAccount: string) => void;
}

/**
 * Resume a persisted `EXHAUSTED` session onto `targetAccount` via the canonical
 * `performSwitch` path (migration owns resume vs fresh). Emits `recovery.exhausted_resumed`
 * only after a completed launch; returns whether the relaunch produced a live runner.
 * Never a bare state flip — the source account is read from persisted state.
 */
export async function resumeExhaustedSession(
  sessionId: string,
  targetAccount: string,
  deps: ResumeExhaustedDeps
): Promise<boolean> {
  const state = deps.sessionManager.readState(sessionId);
  if (!state || state.status !== 'EXHAUSTED') return false;

  const result = await deps.performSwitch(
    {
      aisupSessionId: sessionId,
      claudeSessionId: state.claude_session_id,
      transcriptPath: state.transcript_path,
      activeSkill: state.active_skill,
      planFilePath: state.plan_path,
      sourceAccount: state.account,
      targetAccount,
      reason: SwitchReason.CircuitBreaker,
      selectionMode: 'automatic',
    },
    deps.accounts,
    deps.switchDeps
  );

  if (result.status === 'completed' && result.targetAccount) {
    deps.onResumed?.(result.targetAccount);
    await deps.journal.append({
      ts: new Date().toISOString(),
      event_type: 'recovery.exhausted_resumed',
      aisup_session_id: sessionId,
      details: { from_account: state.account, to_account: result.targetAccount },
    });
    return true;
  }

  return false;
}
