import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTmuxSession,
  destroyTmuxSession,
  sendText,
  sendControl,
  sendInterrupt,
  sendEnter,
  isProcessDead,
  listSessions,
  stopPipePane,
  getSessionId,
  getPaneId,
  respawnPane,
  startOutputLog,
} from './tmux.js';
import type { SessionState } from './types.js';
import { singleQuote } from '../util/shell.js';
import { getBlockingSession as getBlockingSessionFromState } from '../cli/pid.js';

export interface SessionManagerOpts {
  tmuxSocket: string;
  stateDir: string;
  outputLogMaxSizeMb: number;
  outputLogRetentionDays?: number;
}

export interface CreateSessionOpts {
  aisupSessionId: string;
  account: string;
  accountConfigDir: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  planPath?: string | null;
}

export class SessionManager {
  private socket: string;
  private stateDir: string;
  private outputLogMaxSizeMb: number;
  private outputLogRetentionDays: number;

  constructor(opts: SessionManagerOpts) {
    this.socket = opts.tmuxSocket;
    this.stateDir = opts.stateDir;
    this.outputLogMaxSizeMb = opts.outputLogMaxSizeMb;
    this.outputLogRetentionDays = opts.outputLogRetentionDays ?? 7;
  }

  private sessionDir(aisupSessionId: string): string {
    return join(this.stateDir, aisupSessionId);
  }

  private statePath(aisupSessionId: string): string {
    return join(this.sessionDir(aisupSessionId), 'state.json');
  }

  private outputLogPath(aisupSessionId: string): string {
    return join(this.sessionDir(aisupSessionId), 'output.log');
  }

  private writeState(state: SessionState): void {
    const dir = this.sessionDir(state.aisup_session_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = this.statePath(state.aisup_session_id);
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  readState(aisupSessionId: string): SessionState | null {
    const path = this.statePath(aisupSessionId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SessionState;
    } catch {
      return null;
    }
  }

  async createSession(opts: CreateSessionOpts): Promise<SessionState> {
    const { aisupSessionId, account, command, args, env, cwd } = opts;
    const tmuxName = `aisup-${aisupSessionId.slice(0, 8)}`;
    const logPath = this.outputLogPath(aisupSessionId);
    const now = new Date().toISOString();

    const state: SessionState = {
      aisup_session_id: aisupSessionId,
      status: 'CREATING',
      account,
      tmux_name: tmuxName,
      tmux_session_id: null,
      pane_id: null,
      cwd,
      launch_started_at: now,
      claude_session_id: null,
      transcript_path: null,
      plan_path: opts.planPath ?? null,
      active_skill: null,
      output_log_path: logPath,
      switch_tx: null,
      created_at: now,
      updated_at: now,
    };
    this.writeState(state);

    await createTmuxSession({
      socket: this.socket,
      name: tmuxName,
      command,
      args,
      env: { ...env },
      cwd,
      logPath,
    });

    // Capture tmux session/pane IDs for switch transaction safety
    let tmuxSessionId: string | null = null;
    let paneId: string | null = null;
    try {
      tmuxSessionId = getSessionId(this.socket, tmuxName);
      paneId = getPaneId(this.socket, tmuxName);
    } catch { /* non-fatal */ }

    const activeState: SessionState = {
      ...state,
      status: 'ACTIVE',
      tmux_session_id: tmuxSessionId,
      pane_id: paneId,
      updated_at: new Date().toISOString(),
    };
    this.writeState(activeState);

    return activeState;
  }

  async stopSession(
    tmuxName: string,
    aisupSessionId: string,
    opts: { force?: boolean }
  ): Promise<void> {
    const state = this.readState(aisupSessionId);

    if (!opts.force) {
      // Graceful: Ctrl+C → wait 2s → /exit → poll 5s → force
      sendInterrupt(this.socket, tmuxName);
      await new Promise((r) => setTimeout(r, 2000));

      if (!isProcessDead(this.socket, tmuxName)) {
        sendText(this.socket, tmuxName, '/exit');
        sendEnter(this.socket, tmuxName);

        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (isProcessDead(this.socket, tmuxName)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    stopPipePane(this.socket, tmuxName);
    destroyTmuxSession(this.socket, tmuxName);

    if (state) {
      this.writeState({
        ...state,
        status: 'STOPPED',
        updated_at: new Date().toISOString(),
      });
    }
  }

  async restartInPlace(
    aisupSessionId: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ): Promise<SessionState> {
    const state = this.readState(aisupSessionId);
    if (!state) {
      throw new Error(`restartInPlace: no persisted state for ${aisupSessionId}`);
    }

    const liveSessions = listSessions(this.socket);
    if (!liveSessions.includes(state.tmux_name)) {
      return this.createSession({
        aisupSessionId,
        account: state.account,
        accountConfigDir: '',
        command,
        args,
        env,
        cwd: state.cwd,
        planPath: state.plan_path,
      });
    }

    respawnPane(this.socket, state.tmux_name, state.cwd, env);
    startOutputLog(this.socket, state.tmux_name, state.output_log_path);

    const execCmd = 'exec ' + [command, ...args].map(singleQuote).join(' ');
    sendText(this.socket, state.tmux_name, execCmd);
    sendEnter(this.socket, state.tmux_name);

    let tmuxSessionId = state.tmux_session_id;
    let paneId = state.pane_id;
    try {
      tmuxSessionId = getSessionId(this.socket, state.tmux_name);
      paneId = getPaneId(this.socket, state.tmux_name);
    } catch { /* non-fatal */ }

    const activeState: SessionState = {
      ...state,
      status: 'ACTIVE',
      tmux_session_id: tmuxSessionId,
      pane_id: paneId,
      updated_at: new Date().toISOString(),
    };
    this.writeState(activeState);
    return activeState;
  }

  async terminateRunnerForSwitch(
    tmuxName: string,
    aisupSessionId: string,
    opts: { force?: boolean }
  ): Promise<void> {
    if (!opts.force) {
      // The source pane may already be gone (race, or terminating a stale runner). C-c to a
      // missing tmux target throws; treat that as "nothing to interrupt" and fall through to
      // best-effort cleanup rather than aborting the switch.
      let interrupted = false;
      try {
        sendInterrupt(this.socket, tmuxName);
        interrupted = true;
      } catch {
        /* pane already gone — nothing to interrupt */
      }
      if (interrupted) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (interrupted && !isProcessDead(this.socket, tmuxName)) {
        sendText(this.socket, tmuxName, '/exit');
        sendEnter(this.socket, tmuxName);

        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (isProcessDead(this.socket, tmuxName)) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    stopPipePane(this.socket, tmuxName);
    destroyTmuxSession(this.socket, tmuxName);

    const state = this.readState(aisupSessionId);
    if (state) {
      this.writeState({
        ...state,
        status: 'SWITCHING',
        updated_at: new Date().toISOString(),
      });
    }
  }

  /** Atomically patch fields on a session's persisted state. */
  patchState(aisupSessionId: string, patch: Partial<import('./types.js').SessionState>): void {
    const existing = this.readState(aisupSessionId);
    if (!existing) return;
    this.writeState({ ...existing, ...patch, updated_at: new Date().toISOString() });
  }

  /** Return the first session in ACTIVE or SWITCH_PENDING_AT_IDLE state, or null. */
  getActiveSession(): import('./types.js').SessionState | null {
    if (!existsSync(this.stateDir)) return null;
    try {
      for (const sessionId of readdirSync(this.stateDir)) {
        const state = this.readState(sessionId);
        if (state && (state.status === 'ACTIVE' || state.status === 'SWITCH_PENDING_AT_IDLE')) {
          return state;
        }
      }
    } catch { /* ignore read errors */ }
    return null;
  }

  /** Expose the stateDir for consumers that need to read session dirs directly. */
  getStateDir(): string { return this.stateDir; }

  /** Expose the tmux socket for consumers that need direct tmux access. */
  getSocket(): string { return this.socket; }

  listTmuxSessions(): string[] {
    return listSessions(this.socket).filter((s) => s.startsWith('aisup-'));
  }

  destroyTmuxSessionByName(tmuxName: string): void {
    stopPipePane(this.socket, tmuxName);
    destroyTmuxSession(this.socket, tmuxName);
  }

  getBlockingSession(): import('./types.js').SessionInfo | null {
    const live = this.listTmuxSessions();
    return getBlockingSessionFromState(this.stateDir, live);
  }

  rotateOutputLogIfNeeded(aisupSessionId: string): { rotated: boolean; path: string; rotatedPath?: string } {
    const state = this.readState(aisupSessionId);
    if (!state) return { rotated: false, path: '' };
    const maxBytes = this.outputLogMaxSizeMb * 1024 * 1024;
    if (maxBytes <= 0) return { rotated: false, path: state.output_log_path };
    let size = 0;
    try {
      size = statSync(state.output_log_path).size;
    } catch {
      return { rotated: false, path: state.output_log_path };
    }
    if (size < maxBytes) return { rotated: false, path: state.output_log_path };

    const rotatedPath = `${state.output_log_path}.1`;
    stopPipePane(this.socket, state.tmux_name);
    try { rmSync(rotatedPath, { force: true }); } catch { /* ok */ }
    renameSync(state.output_log_path, rotatedPath);
    startOutputLog(this.socket, state.tmux_name, state.output_log_path);
    writeFileSync(state.output_log_path, '', { flag: 'a', mode: 0o600 });
    this.cleanupRotatedOutputLogs(state.aisup_session_id);
    return { rotated: true, path: state.output_log_path, rotatedPath };
  }

  private cleanupRotatedOutputLogs(aisupSessionId: string): void {
    const cutoff = Date.now() - this.outputLogRetentionDays * 24 * 60 * 60 * 1000;
    const dir = this.sessionDir(aisupSessionId);
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith('output.log.')) continue;
        const path = join(dir, entry);
        try {
          if (statSync(path).mtime.getTime() < cutoff) rmSync(path, { force: true });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}
