import type { AccountInfo } from '../accounts/types.js';
import type { ValidationResult, SwitchSnapshot } from './types.js';
import { SwitchReason } from './types.js';
import type { SessionManager } from '../session/manager.js';
import type { SessionState, SwitchAttempt, SwitchTx } from '../session/types.js';
import { migrateTranscript } from './migrator.js';
import type { JournalWriter } from '../journal/types.js';

export interface SwitchDeps {
  sessionManager: SessionManager;
  journal: JournalWriter;
  createSessionForTarget: (targetAccount: AccountInfo, snapshot: SwitchSnapshot) => Promise<SessionState>;
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

  // Phase: migrate transcript
  if (snapshot.transcriptPath) {
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
          event_type: `migration.${migrationResult.status === 'copied' ? 'completed' : migrationResult.status}` as 'migration.completed',
          aisup_session_id: snapshot.aisupSessionId,
          details: {
            status: migrationResult.status,
            source_account: snapshot.sourceAccount,
            target_account: snapshot.targetAccount,
            source_path: snapshot.transcriptPath,
            source_sha256: migrationResult.sourceSha256 ?? null,
          },
        });
      } catch (err) {
        await journal.append({
          ts: new Date().toISOString(),
          event_type: 'migration.invalid_path',
          aisup_session_id: snapshot.aisupSessionId,
          details: { error: String(err) },
        });
      }
    }
  }

  // Phase: create target session (with retry across eligible accounts)
  const targetOrder: AccountInfo[] = [];
  const primaryTarget = accounts.find((a) => a.name === snapshot.targetAccount);
  if (primaryTarget) targetOrder.push(primaryTarget);

  if (snapshot.selectionMode === 'automatic') {
    const others = accounts.filter(
      (a) => a.name !== snapshot.sourceAccount && a.name !== snapshot.targetAccount && a.enabled && a.state !== 'UNAVAILABLE'
    ).sort((a, b) => a.priority - b.priority);
    targetOrder.push(...others);
  }

  for (const target of targetOrder) {
    if (switchTx.tried_accounts.includes(target.name)) continue;
    switchTx.target_account = target.name;
    switchTx.target_tmux_name = null;
    switchTx.target_tmux_session_id = null;
    switchTx.target_pane_id = null;
    switchTx.tried_accounts.push(target.name);
    switchTx.switch_phase = 'creating';
    switchTx.phase_timestamps['creating'] = new Date().toISOString();
    const attempt: SwitchAttempt = {
      target_account: target.name,
      phase: snapshot.claudeSessionId ? 'resuming' : 'creating',
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
      const newState = await deps.createSessionForTarget(target, snapshot);
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
          launch_mode: snapshot.claudeSessionId ? 'resumed' : 'fresh',
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
