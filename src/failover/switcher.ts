import type { AccountInfo } from '../accounts/types.js';
import type { ValidationResult, SwitchSnapshot } from './types.js';
import { SwitchReason } from './types.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionState, SwitchAttempt, SwitchTx } from '../session/types.js';
import { migrateTranscript, MigrationError } from './migrator.js';
import type { MigrationResult } from './migrator.js';
import type { JournalWriter, EventType } from '../journal/types.js';

/** Canonical journal event name per migration outcome (no parallel `migration.already_migrated`). */
const MIGRATION_EVENT: Record<MigrationResult['status'], EventType> = {
  copied: 'migration.completed',
  already_migrated: 'migration.skipped_already_migrated',
  collision_renamed: 'migration.collision_renamed',
  skipped_no_transcript: 'migration.skipped_no_transcript',
};

export type LaunchMode = 'resumed' | 'fresh';

export interface SwitchDeps {
  sessionManager: SessionManager;
  journal: JournalWriter;
  /**
   * Launch the target runner. `launchMode` is owned by the migration outcome, not by
   * `snapshot.claudeSessionId`: a failed/skipped migration yields `'fresh'` even when a
   * claude session id is set, so the target never resumes against a transcript it lacks.
   */
  createSessionForTarget: (targetAccount: AccountInfo, snapshot: SwitchSnapshot, launchMode: LaunchMode) => Promise<SessionState>;
}

export interface SwitchResult {
  status: 'completed' | 'exhausted' | 'failed';
  targetAccount?: string;
  error?: string;
  triedAccounts: string[];
}

/** Validate a manual failover target account. Returns valid=true or typed rejection reason. */
export function validateManualFailoverTarget(
  targetName: string,
  currentAccount: string,
  accounts: AccountInfo[]
): ValidationResult {
  const target = accounts.find((a) => a.name === targetName);

  if (!target) {
    return { valid: false, reason: `target_invalid: account "${targetName}" not found in config` };
  }

  if (targetName === currentAccount) {
    return { valid: false, reason: `target_is_current: "${targetName}" is already the active account` };
  }

  if (!target.enabled || target.state === 'UNAVAILABLE') {
    return {
      valid: false,
      reason: `target_unavailable: account "${targetName}" is ${!target.enabled ? 'disabled' : target.state}`,
    };
  }

  if (target.state === 'COOLDOWN') {
    return {
      valid: true,
      warning: `account "${targetName}" is in COOLDOWN — proceeding as manual override`,
    };
  }

  return { valid: true };
}

export function selectSwitchTarget(
  accounts: AccountInfo[],
  currentAccount: string,
  excludedAccounts: string[],
  opts: { reason?: SwitchReason; currentScore?: number | null } = {}
): AccountInfo | null {
  const excluded = new Set([currentAccount, ...excludedAccounts]);
  const eligible = accounts
    .filter((a) => a.enabled && !excluded.has(a.name) && (a.state === 'HEALTHY' || a.state === 'DEGRADED'))
    .sort((a, b) => {
      const aScore = a.score ?? -Infinity;
      const bScore = b.score ?? -Infinity;
      if (aScore !== bScore) return bScore - aScore;
      return a.priority - b.priority;
    });
  if (opts.reason === SwitchReason.SoftThreshold && typeof opts.currentScore === 'number') {
    return eligible.find((a) => typeof a.score === 'number' && a.score > opts.currentScore!) ?? null;
  }
  return eligible[0] ?? null;
}

export interface NoTargetDeps {
  sessionManager: { patchState(id: string, patch: Partial<SessionState>): void };
  journal: JournalWriter;
  /** Refresh online API/session visibility (server.setSessionState). */
  setSessionVisible?: (session: { status: 'EXHAUSTED'; aisup_session_id: string; hasTmux: boolean }) => void;
  /** Notify Slack when configured (best-effort). */
  notifyExhausted?: (sessionId: string) => Promise<void> | void;
}

export interface NoTargetParams {
  sessionId: string;
  fromAccount: string;
  reason: SwitchReason;
  triedAccounts?: string[];
  sourceRunnerAlive?: boolean;
  earliestCooldownEta?: string | null;
}

/**
 * Resolve a pre-switch "no eligible target" outcome.
 *
 * A soft-threshold no-better-target is NON-terminal: the session keeps running and
 * is re-evaluated on the next tick. Every other reason (hard threshold, live 429,
 * source-dead crash, restart failures, circuit breaker) is terminal: the session is
 * persisted `EXHAUSTED` so it survives daemon restarts, stops being treated as ACTIVE,
 * and surfaces a distinct terminal event — never the same event shape as the soft case.
 */
export async function handleNoTarget(params: NoTargetParams, deps: NoTargetDeps): Promise<{ terminal: boolean }> {
  const { sessionId, fromAccount, reason } = params;
  const triedAccounts = params.triedAccounts ?? [];
  const earliestCooldownEta = params.earliestCooldownEta ?? null;
  const terminal = reason !== SwitchReason.SoftThreshold;

  if (!terminal) {
    await deps.journal.append({
      ts: new Date().toISOString(),
      event_type: 'failover.no_target_available',
      aisup_session_id: sessionId,
      details: {
        terminal: false,
        reason,
        from_account: fromAccount,
        excluded_accounts: [fromAccount],
        tried_accounts: triedAccounts,
        source_runner_alive: params.sourceRunnerAlive ?? true,
        earliest_cooldown_eta: earliestCooldownEta,
        requires_better_soft_target: true,
      },
    });
    return { terminal: false };
  }

  // Terminal: persist EXHAUSTED, clear any in-flight switch transaction.
  deps.sessionManager.patchState(sessionId, { status: 'EXHAUSTED', switch_tx: null });

  await deps.journal.append({
    ts: new Date().toISOString(),
    event_type: 'failover.no_target_available',
    aisup_session_id: sessionId,
    details: {
      terminal: true,
      reason,
      from_account: fromAccount,
      excluded_accounts: [fromAccount],
      tried_accounts: triedAccounts,
      source_runner_alive: params.sourceRunnerAlive ?? false,
      earliest_cooldown_eta: earliestCooldownEta,
      requires_better_soft_target: false,
    },
  });

  await deps.journal.append({
    ts: new Date().toISOString(),
    event_type: 'session.exhausted',
    aisup_session_id: sessionId,
    details: {
      reason,
      from_account: fromAccount,
      tried_accounts: triedAccounts,
      earliest_cooldown_eta: earliestCooldownEta,
      last_switch_failure: null,
    },
  });

  // Refresh online visibility so /api/status and manual failover see the EXHAUSTED state.
  deps.setSessionVisible?.({ status: 'EXHAUSTED', aisup_session_id: sessionId, hasTmux: false });
  await deps.notifyExhausted?.(sessionId);

  return { terminal: true };
}

function cloneTx(tx: SwitchTx): SwitchTx {
  return JSON.parse(JSON.stringify(tx)) as SwitchTx;
}

function summarizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

export async function performSwitch(
  snapshot: SwitchSnapshot,
  accounts: AccountInfo[],
  deps: SwitchDeps
): Promise<SwitchResult> {
  const { sessionManager, journal } = deps;
  const state = sessionManager.readState(snapshot.aisupSessionId);
  if (!state) {
    return { status: 'failed', error: 'no session state found', triedAccounts: [] };
  }

  const switchTx: SwitchTx = {
    switch_phase: 'snapshot',
    source_account: snapshot.sourceAccount,
    target_account: snapshot.targetAccount,
    source_tmux_name: state.tmux_name,
    source_tmux_session_id: state.tmux_session_id,
    source_pane_id: state.pane_id,
    target_tmux_name: null,
    target_tmux_session_id: null,
    target_pane_id: null,
    source_transcript_path: snapshot.transcriptPath,
    source_transcript_sha256: null,
    source_destroyed: false,
    tried_accounts: [],
    attempts: [],
    last_launch_error: null,
    phase_timestamps: { snapshot: new Date().toISOString() },
    error_summary: null,
  };

  const persistTx = (patch: Partial<SessionState> = {}): void => {
    sessionManager.patchState(snapshot.aisupSessionId, {
      status: 'SWITCHING',
      ...patch,
      switch_tx: cloneTx(switchTx),
    });
  };

  persistTx();

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'account.switch',
    aisup_session_id: snapshot.aisupSessionId,
    details: {
      phase: 'snapshot',
      reason: snapshot.reason,
      from_account: snapshot.sourceAccount,
      to_account: snapshot.targetAccount,
      selection_mode: snapshot.selectionMode,
    },
  });

  // Phase: terminate source runner
  switchTx.switch_phase = 'stopping';
  switchTx.phase_timestamps['stopping'] = new Date().toISOString();
  persistTx();

  await sessionManager.terminateRunnerForSwitch(
    state.tmux_name,
    snapshot.aisupSessionId,
    { force: false }
  );
  switchTx.source_destroyed = true;
  switchTx.switch_phase = 'source_destroyed';
  switchTx.phase_timestamps['source_destroyed'] = new Date().toISOString();
  persistTx();

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'runner.terminated_for_switch',
    aisup_session_id: snapshot.aisupSessionId,
    details: { reason: snapshot.reason, source_account: snapshot.sourceAccount, target_account: snapshot.targetAccount, tmux_name: state.tmux_name },
  });

  // Phase: migrate transcript — the migration outcome owns the launch decision.
  // `resumed` only when a valid transcript exists in the (primary) target account;
  // `fresh` for null/missing/invalid/failed migration, even if a claude session id is set.
  let primaryLaunchMode: LaunchMode = 'fresh';
  if (!snapshot.transcriptPath) {
    // No transcript to migrate — force fresh and record why (the migrator's own
    // skipped_no_transcript status is unreachable, so the switcher owns this skip).
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'migration.skipped_no_transcript',
      aisup_session_id: snapshot.aisupSessionId,
      details: {
        source_account: snapshot.sourceAccount,
        target_account: snapshot.targetAccount,
      },
    });
  } else {
    switchTx.switch_phase = 'migrating';
    switchTx.phase_timestamps['migrating'] = new Date().toISOString();
    persistTx();
    const sourceAccount = accounts.find((a) => a.name === snapshot.sourceAccount);
    const targetAccount = accounts.find((a) => a.name === snapshot.targetAccount);

    if (sourceAccount && targetAccount) {
      try {
        const migrationResult = await migrateTranscript({
          transcriptPath: snapshot.transcriptPath,
          sourceConfigDir: sourceAccount.configDir,
          targetConfigDir: targetAccount.configDir,
          claudeSessionId: snapshot.claudeSessionId,
        });
        switchTx.source_transcript_sha256 = migrationResult.sourceSha256 ?? null;

        await journal.append({
          ts: new Date().toISOString(),
          event_type: MIGRATION_EVENT[migrationResult.status],
          aisup_session_id: snapshot.aisupSessionId,
          details: {
            status: migrationResult.status,
            source_account: snapshot.sourceAccount,
            target_account: snapshot.targetAccount,
            source_path: snapshot.transcriptPath,
            source_size: migrationResult.sourceSize ?? null,
            source_sha256: migrationResult.sourceSha256 ?? null,
            target_path: migrationResult.targetPath ?? null,
            target_sha256: migrationResult.targetSha256 ?? null,
          },
        });
        // A valid transcript now exists in the target account → safe to resume.
        primaryLaunchMode = 'resumed';
      } catch (err) {
        await journal.append({
          ts: new Date().toISOString(),
          event_type: 'migration.invalid_path',
          aisup_session_id: snapshot.aisupSessionId,
          // Safe reason enum from MigrationError — never raw exception text or transcript content.
          details: {
            reason: err instanceof MigrationError ? err.reason : 'unknown',
            source_account: snapshot.sourceAccount,
            target_account: snapshot.targetAccount,
            source_path: snapshot.transcriptPath,
          },
        });
        // Migration failed → do NOT resume against a transcript the target lacks.
        primaryLaunchMode = 'fresh';
      }
    }
  }

  // Phase: create target session (with retry across eligible accounts)
  const targetOrder: AccountInfo[] = [];
  const primaryTarget = accounts.find((a) => a.name === snapshot.targetAccount);
  if (primaryTarget) targetOrder.push(primaryTarget);

  if (snapshot.selectionMode === 'automatic') {
    // Automatic retry: only HEALTHY/DEGRADED (excludes COOLDOWN + UNAVAILABLE), ordered by the
    // canonical score-then-priority rule rather than a second priority-only sort.
    const others = accounts
      .filter((a) =>
        a.name !== snapshot.sourceAccount &&
        a.name !== snapshot.targetAccount &&
        a.enabled &&
        (a.state === 'HEALTHY' || a.state === 'DEGRADED')
      )
      .sort((a, b) => {
        const aScore = a.score ?? -Infinity;
        const bScore = b.score ?? -Infinity;
        if (aScore !== bScore) return bScore - aScore;
        return a.priority - b.priority;
      });
    targetOrder.push(...others);
  }

  for (const target of targetOrder) {
    if (switchTx.tried_accounts.includes(target.name)) continue;
    // The transcript was migrated only to the primary target; retry ("other") accounts
    // have no copy, so they must launch fresh.
    const targetLaunchMode: LaunchMode = target.name === snapshot.targetAccount ? primaryLaunchMode : 'fresh';
    switchTx.target_account = target.name;
    switchTx.target_tmux_name = null;
    switchTx.target_tmux_session_id = null;
    switchTx.target_pane_id = null;
    switchTx.tried_accounts.push(target.name);
    switchTx.switch_phase = 'creating';
    switchTx.phase_timestamps['creating'] = new Date().toISOString();
    const attempt: SwitchAttempt = {
      target_account: target.name,
      phase: targetLaunchMode === 'resumed' ? 'resuming' : 'creating',
      target_tmux_name: null,
      target_tmux_session_id: null,
      target_pane_id: null,
      error_summary: null,
      ts: new Date().toISOString(),
      cleaned_up: false,
    };
    switchTx.attempts!.push(attempt);
    persistTx();

    try {
      const newState = await deps.createSessionForTarget(target, snapshot, targetLaunchMode);
      switchTx.target_tmux_name = newState.tmux_name;
      switchTx.target_tmux_session_id = newState.tmux_session_id;
      switchTx.target_pane_id = newState.pane_id;
      attempt.target_tmux_name = newState.tmux_name;
      attempt.target_tmux_session_id = newState.tmux_session_id;
      attempt.target_pane_id = newState.pane_id;
      attempt.phase = 'completed';
      switchTx.switch_phase = null;

      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'account.switch',
        aisup_session_id: snapshot.aisupSessionId,
        details: {
          phase: 'completed',
          reason: snapshot.reason,
          from_account: snapshot.sourceAccount,
          to_account: target.name,
          selection_mode: snapshot.selectionMode,
          launch_mode: targetLaunchMode,
        },
      });

      sessionManager.patchState(snapshot.aisupSessionId, {
        status: 'ACTIVE',
        account: target.name,
        tmux_name: newState.tmux_name,
        tmux_session_id: newState.tmux_session_id,
        pane_id: newState.pane_id,
        switch_tx: null,
      });

      return { status: 'completed', targetAccount: target.name, triedAccounts: switchTx.tried_accounts };
    } catch (err) {
      const error = summarizeError(err);
      switchTx.error_summary = error;
      switchTx.last_launch_error = error;
      attempt.phase = 'failed';
      attempt.error_summary = error;
      const failedTmuxName = switchTx.target_tmux_name ?? state.tmux_name;
      if ('destroyTmuxSessionByName' in sessionManager && typeof sessionManager.destroyTmuxSessionByName === 'function') {
        try {
          sessionManager.destroyTmuxSessionByName(failedTmuxName);
          attempt.cleaned_up = true;
        } catch { /* best effort */ }
      }
      persistTx();
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'runner.launch_failed',
        aisup_session_id: snapshot.aisupSessionId,
        details: { target_account: target.name, error, phase: attempt.phase },
      });
    }
  }

  // All targets exhausted
  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'failover.no_target_available',
    aisup_session_id: snapshot.aisupSessionId,
    details: {
      terminal: true,
      reason: snapshot.reason,
      from_account: snapshot.sourceAccount,
      excluded_accounts: [snapshot.sourceAccount],
      tried_accounts: switchTx.tried_accounts,
      source_runner_alive: false,
      earliest_cooldown_eta: null,
      requires_better_soft_target: false,
    },
  });

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'session.exhausted',
    aisup_session_id: snapshot.aisupSessionId,
    details: {
      reason: snapshot.reason,
      from_account: snapshot.sourceAccount,
      tried_accounts: switchTx.tried_accounts,
      earliest_cooldown_eta: null,
      last_switch_failure: switchTx.error_summary,
    },
  });

  sessionManager.patchState(snapshot.aisupSessionId, {
    status: 'EXHAUSTED',
    switch_tx: null,
  });

  return { status: 'exhausted', triedAccounts: switchTx.tried_accounts, error: switchTx.error_summary ?? 'all targets failed' };
}
