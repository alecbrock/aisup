import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPipePaneActive,
  startOutputLog,
  isProcessDead,
  destroyTmuxSession,
} from '../session/tmux.js';
import type { SessionState, SessionInfo, SwitchTx } from '../session/types.js';
import type { JournalWriter } from '../journal/types.js';
import { SwitchReason } from '../failover/types.js';
import { readTelemetryForSession } from '../statusline/store.js';

export interface RehydrationDeps {
  stateDir: string;
  tmuxSocket: string;
  liveSessions: Set<string>;
  setSessionState: (session: SessionInfo) => void;
  journal: JournalWriter;
  /**
   * Daemon-level corrective recovery callbacks. When provided, rehydration continues
   * interrupted mid-switch phases (onSwitch) and restarts state-without-tmux sessions
   * (onRestart) instead of only logging needs_manual_failover. When absent (e.g. unit
   * tests, or recovery disabled), rehydration falls back to deterministic logging.
   */
  onSwitch?: (sessionId: string, reason: SwitchReason) => Promise<void>;
  onRestart?: (sessionId: string) => Promise<boolean | void>;
  /**
   * Telemetry-identity validation inputs. When provided, rehydration validates a live
   * known session's statusline telemetry through the same resolver the loop-manager uses
   * (R12), emitting telemetry.session_mismatch / telemetry.invalid_json on disagreement.
   */
  statuslineDir?: string;
  statuslineFreshnessWindowS?: number;
  accountConfigDir?: (account: string) => string | undefined;
}

/**
 * Validate a rehydrated live session's telemetry identity via the shared resolver.
 * Emits the canonical mismatch/invalid-json events; never reads telemetry when the
 * optional inputs or a known claude_session_id are absent.
 */
async function validateRehydratedTelemetry(state: SessionState, deps: RehydrationDeps): Promise<void> {
  const { statuslineDir, accountConfigDir, journal } = deps;
  if (!statuslineDir || !accountConfigDir || !state.claude_session_id) return;
  const configDir = accountConfigDir(state.account);
  if (!configDir) return;

  const result = readTelemetryForSession(
    state.claude_session_id,
    configDir,
    state.cwd,
    statuslineDir,
    deps.statuslineFreshnessWindowS ?? 300
  );

  if (result.mismatch) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'telemetry.session_mismatch',
      aisup_session_id: state.aisup_session_id,
      details: {
        reason: result.mismatch,
        expected_account: state.account,
        expected_session_id: state.claude_session_id,
        expected_cwd: state.cwd,
      },
    });
  } else if (result.invalidJson) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'telemetry.invalid_json',
      aisup_session_id: state.aisup_session_id,
      details: {
        account: state.account,
        error: result.invalidJson.error,
        stale: result.invalidJson.stale,
      },
    });
  }
}

function readSessionState(stateDir: string, sessionId: string): SessionState | null {
  const path = join(stateDir, sessionId, 'state.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

function writeSessionState(stateDir: string, state: SessionState): void {
  const dir = join(stateDir, state.aisup_session_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'state.json');
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

async function recoverSwitchTx(
  state: SessionState,
  tx: SwitchTx,
  deps: RehydrationDeps
): Promise<void> {
  const { tmuxSocket, journal, setSessionState, stateDir } = deps;
  const sessionId = state.aisup_session_id;
  const ts = new Date().toISOString();

  switch (tx.switch_phase) {
    case 'snapshot': {
      // Switch never actually started — source pane still present. Clear switch_tx, return ACTIVE.
      const recovered: SessionState = { ...state, status: 'ACTIVE', switch_tx: null, updated_at: ts };
      writeSessionState(stateDir, recovered);
      setSessionState({ status: 'ACTIVE', aisup_session_id: sessionId });
      await journal.append({ ts, event_type: 'recovery.success', aisup_session_id: sessionId,
        details: { phase: 'snapshot', action: 'cleared_switch_tx' } });
      break;
    }

    case 'stopping': {
      // Check if source pane is still alive
      const sourceDead = isProcessDead(tmuxSocket, tx.source_tmux_name);
      if (!sourceDead) {
        // Source still running — termination was incomplete. Clear switch_tx, return ACTIVE.
        const recovered: SessionState = { ...state, status: 'ACTIVE', switch_tx: null, updated_at: ts };
        writeSessionState(stateDir, recovered);
        setSessionState({ status: 'ACTIVE', aisup_session_id: sessionId });
        await journal.append({ ts, event_type: 'recovery.success', aisup_session_id: sessionId,
          details: { phase: 'stopping', action: 'source_alive_cleared_switch_tx' } });
      } else {
        // Source dead — kill tmux session to clean up, advance to source_destroyed
        try { destroyTmuxSession(tmuxSocket, tx.source_tmux_name); } catch { /* ok */ }
        const advanced: SwitchTx = { ...tx, switch_phase: 'source_destroyed', source_destroyed: true };
        writeSessionState(stateDir, { ...state, switch_tx: advanced, updated_at: ts });
        await journal.append({ ts, event_type: 'recovery.failed', aisup_session_id: sessionId,
          details: { phase: 'stopping', action: 'source_dead_advanced_to_source_destroyed', needs_manual_failover: true } });
      }
      break;
    }

    case 'source_destroyed': {
      // Kill stale source tmux if still somehow present
      try { destroyTmuxSession(tmuxSocket, tx.source_tmux_name); } catch { /* ok */ }
      // Continue the switch when a recovery callback exists; the source is gone, so a new
      // target must be created. Falls back to deterministic needs_manual_failover otherwise.
      if (deps.onSwitch) {
        await journal.append({ ts, event_type: 'recovery.attempted', aisup_session_id: sessionId,
          details: { phase: 'source_destroyed', action: 'continue_switch', tried: tx.tried_accounts } });
        await deps.onSwitch(sessionId, SwitchReason.SourceDead);
      } else {
        await journal.append({ ts, event_type: 'recovery.failed', aisup_session_id: sessionId,
          details: { phase: 'source_destroyed', action: 'needs_manual_failover', tried: tx.tried_accounts } });
      }
      break;
    }

    case 'migrating':
    case 'creating':
    case 'resuming': {
      const targetAlive = tx.target_tmux_name
        ? !isProcessDead(tmuxSocket, tx.target_tmux_name)
        : false;

      if (tx.switch_phase === 'resuming' && targetAlive && tx.target_tmux_name) {
        // Target is alive — set session ACTIVE on target
        const recovered: SessionState = {
          ...state,
          status: 'ACTIVE',
          account: tx.target_account ?? state.account,
          tmux_name: tx.target_tmux_name,
          tmux_session_id: tx.target_tmux_session_id,
          pane_id: tx.target_pane_id,
          switch_tx: null,
          updated_at: ts,
        };
        writeSessionState(stateDir, recovered);
        setSessionState({ status: 'ACTIVE', aisup_session_id: sessionId });
        await journal.append({ ts, event_type: 'recovery.success', aisup_session_id: sessionId,
          details: { phase: 'resuming', action: 'target_alive_set_active', target: tx.target_account } });
      } else if (deps.onSwitch) {
        // Target absent or dead mid-migrate/create/resume — continue the switch to a fresh target.
        await journal.append({ ts, event_type: 'recovery.attempted', aisup_session_id: sessionId,
          details: { phase: tx.switch_phase, action: 'continue_switch', target_alive: targetAlive } });
        await deps.onSwitch(sessionId, SwitchReason.SourceDead);
      } else {
        await journal.append({ ts, event_type: 'recovery.failed', aisup_session_id: sessionId,
          details: { phase: tx.switch_phase, action: 'needs_manual_failover', target_alive: targetAlive } });
      }
      break;
    }

    default:
      await journal.append({ ts, event_type: 'recovery.failed', aisup_session_id: sessionId,
        details: { phase: tx.switch_phase ?? 'unknown', action: 'unrecognised_phase' } });
  }
}

export async function rehydrateSessions(deps: RehydrationDeps): Promise<{ rehydrated: number; orphans: number; exhaustedSessionIds: string[] }> {
  const { stateDir, tmuxSocket, liveSessions, setSessionState, journal } = deps;

  if (!existsSync(stateDir)) {
    await journal.append({ ts: new Date().toISOString(), event_type: 'daemon.rehydrated',
      details: { rehydrated: 0, live_tmux_count: liveSessions.size, orphan_count: 0 } });
    return { rehydrated: 0, orphans: 0, exhaustedSessionIds: [] };
  }

  let rehydrated = 0;
  const orphans: string[] = [];
  const exhaustedSessionIds: string[] = [];
  const matchedTmuxNames = new Set<string>();
  let sessionIds: string[];
  try {
    sessionIds = readdirSync(stateDir);
  } catch {
    sessionIds = [];
  }

  for (const sessionId of sessionIds) {
    const state = readSessionState(stateDir, sessionId);
    if (!state) continue;

    const hasTmux = liveSessions.has(state.tmux_name);
    if (hasTmux) matchedTmuxNames.add(state.tmux_name);

    // Handle interrupted switch transactions first
    if (state.status === 'SWITCHING' && state.switch_tx?.switch_phase) {
      await recoverSwitchTx(state, state.switch_tx, deps);
      continue;
    }

    if (state.status === 'SWITCHING' && !state.switch_tx?.switch_phase) {
      setSessionState({ status: 'SWITCHING', aisup_session_id: sessionId, hasTmux });
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.failed',
        aisup_session_id: sessionId,
        details: { reason: 'malformed_or_missing_switch_tx', status: state.status, has_tmux: hasTmux },
      });
    } else if (state.status === 'CREATING' || state.status === 'STOPPING') {
      setSessionState({ status: state.status, aisup_session_id: sessionId, hasTmux });
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'recovery.failed',
        aisup_session_id: sessionId,
        details: { reason: 'operation_interrupted', status: state.status, has_tmux: hasTmux },
      });
    } else if (state.status === 'ACTIVE' || state.status === 'SWITCH_PENDING_AT_IDLE') {
      if (!hasTmux) {
        await journal.append({
          ts: new Date().toISOString(),
          event_type: 'session.destroyed_externally',
          aisup_session_id: sessionId,
          details: { persisted_status: state.status, tmux_name: state.tmux_name },
        });
        setSessionState({ status: state.status, aisup_session_id: sessionId, hasTmux: false });
        // Corrective recovery: the runner died while the session was persisted ACTIVE/pending.
        // Restart it in place (same account) when a recovery callback is available.
        if (deps.onRestart) {
          await deps.onRestart(sessionId);
        }
      } else {
        // Restore pipe-pane if it's no longer active
        if (!isPipePaneActive(tmuxSocket, state.tmux_name)) {
          try {
            startOutputLog(tmuxSocket, state.tmux_name, state.output_log_path);
            await journal.append({
              ts: new Date().toISOString(),
              event_type: 'output_log.cursor_reset',
              aisup_session_id: sessionId,
              details: { reason: 'pipe_pane_restored', tmux_name: state.tmux_name },
            });
          } catch { /* non-fatal — pipe-pane restore is best-effort */ }
        }
        setSessionState({ status: state.status, aisup_session_id: sessionId, hasTmux: true });
        await validateRehydratedTelemetry(state, deps);
        rehydrated++;
      }
    } else if (state.status === 'EXHAUSTED') {
      // Restore EXHAUSTED visibility so /api/status, manual failover, and stop work after a
      // daemon restart — without putting the session into normal active loops. The persisted
      // id is surfaced so startup can re-arm the exhausted poller (R8/Task 7 handoff).
      setSessionState({ status: 'EXHAUSTED', aisup_session_id: sessionId, hasTmux: false });
      exhaustedSessionIds.push(sessionId);
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.exhausted',
        aisup_session_id: sessionId,
        details: { rehydrated: true, account: state.account, tmux_name: state.tmux_name },
      });
    } else if (state.status === 'STOPPED' && hasTmux) {
      orphans.push(state.tmux_name);
      setSessionState({ status: 'STOPPED', aisup_session_id: sessionId, hasTmux: true });
      await journal.append({
        ts: new Date().toISOString(),
        event_type: 'session.destroyed_externally',
        aisup_session_id: sessionId,
        details: { reason: 'stopped_but_tmux_alive', tmux_name: state.tmux_name },
      });
    }
  }

  // Report orphan tmux sessions with no persisted state
  for (const tmuxName of liveSessions) {
    if (!matchedTmuxNames.has(tmuxName)) {
      orphans.push(tmuxName);
    }
  }

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.rehydrated',
    details: { rehydrated, live_tmux_count: liveSessions.size, orphan_count: orphans.length },
  });

  return { rehydrated, orphans: orphans.length, exhaustedSessionIds };
}
