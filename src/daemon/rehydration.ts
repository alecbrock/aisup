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

export interface RehydrationDeps {
  stateDir: string;
  tmuxSocket: string;
  liveSessions: Set<string>;
  setSessionState: (session: SessionInfo) => void;
  journal: JournalWriter;
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
      await journal.append({ ts, event_type: 'recovery.failed', aisup_session_id: sessionId,
        details: { phase: 'source_destroyed', action: 'needs_manual_failover', tried: tx.tried_accounts } });
      break;
    }

    case 'migrating':
    case 'creating':
    case 'resuming': {
      // Complex phases — log for manual intervention (target may or may not exist)
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

export async function rehydrateSessions(deps: RehydrationDeps): Promise<{ rehydrated: number; orphans: number }> {
  const { stateDir, tmuxSocket, liveSessions, setSessionState, journal } = deps;

  if (!existsSync(stateDir)) {
    await journal.append({ ts: new Date().toISOString(), event_type: 'daemon.rehydrated',
      details: { rehydrated: 0, live_tmux_count: liveSessions.size, orphan_count: 0 } });
    return { rehydrated: 0, orphans: 0 };
  }

  let rehydrated = 0;
  const orphans: string[] = [];
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

    // Handle interrupted switch transactions first
    if (state.status === 'SWITCHING' && state.switch_tx?.switch_phase) {
      await recoverSwitchTx(state, state.switch_tx, deps);
      continue;
    }

    if (state.status === 'ACTIVE' || state.status === 'SWITCH_PENDING_AT_IDLE') {
      if (!hasTmux) {
        await journal.append({
          ts: new Date().toISOString(),
          event_type: 'session.destroyed_externally',
          aisup_session_id: sessionId,
          details: { persisted_status: state.status, tmux_name: state.tmux_name },
        });
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
        setSessionState({ status: state.status, aisup_session_id: sessionId });
        rehydrated++;
      }
    } else if (state.status === 'STOPPED' && hasTmux) {
      orphans.push(state.tmux_name);
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
    const sessionId = tmuxName.replace(/^aisup-/, '');
    if (!existsSync(join(stateDir, sessionId, 'state.json'))) {
      orphans.push(tmuxName);
    }
  }

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'daemon.rehydrated',
    details: { rehydrated, live_tmux_count: liveSessions.size, orphan_count: orphans.length },
  });

  return { rehydrated, orphans: orphans.length };
}
