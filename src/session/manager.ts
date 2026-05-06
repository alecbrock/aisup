import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTmuxSession,
  destroyTmuxSession,
  sendText,
  sendControl,
  isProcessDead,
  listSessions,
  stopPipePane,
  getSessionId,
  getPaneId,
} from './tmux.js';
import type { SessionState } from './types.js';

export interface SessionManagerOpts {
  tmuxSocket: string;
  stateDir: string;
  outputLogMaxSizeMb: number;
}

export interface CreateSessionOpts {
  aisupSessionId: string;
  account: string;
  accountConfigDir: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export class SessionManager {
  private socket: string;
  private stateDir: string;
  private outputLogMaxSizeMb: number;

  constructor(opts: SessionManagerOpts) {
    this.socket = opts.tmuxSocket;
    this.stateDir = opts.stateDir;
    this.outputLogMaxSizeMb = opts.outputLogMaxSizeMb;
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
    const { aisupSessionId, account, accountConfigDir, command, args, env, cwd } = opts;
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
      plan_path: null,
      active_skill: null,
      output_log_path: logPath,
      switch_tx: null,
      created_at: now,
      updated_at: now,
    };
    this.writeState(state);

    const sessionEnv: Record<string, string> = { ...env };
    if (accountConfigDir) sessionEnv['CLAUDE_CONFIG_DIR'] = accountConfigDir;

    await createTmuxSession({
      socket: this.socket,
      name: tmuxName,
      command,
      args,
      env: sessionEnv,
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
      sendControl(this.socket, tmuxName, 'C-c');
      await new Promise((r) => setTimeout(r, 2000));

      if (!isProcessDead(this.socket, tmuxName)) {
        sendText(this.socket, tmuxName, '/exit');
        sendControl(this.socket, tmuxName, 'Enter');

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

  listTmuxSessions(): string[] {
    return listSessions(this.socket).filter((s) => s.startsWith('aisup-'));
  }
}
