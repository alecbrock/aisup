import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { singleQuote } from '../util/shell.js';

export interface TmuxTimeoutEvent {
  operation: string;
  target: string;
  timeoutMs: number;
}

let onTmuxTimeout: (event: TmuxTimeoutEvent) => void = () => { /* no-op */ };

/** Register a callback invoked when a real tmux timeout (killed+SIGTERM) occurs. */
export function setTmuxTimeoutHandler(handler: (event: TmuxTimeoutEvent) => void): void {
  onTmuxTimeout = handler;
}

function extractTarget(args: string[]): string {
  const idx = args.indexOf('-t');
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return args.find((a) => a.startsWith('aisup-')) ?? 'unknown';
}

export interface CreateSessionOpts {
  socket: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  logPath: string;
}

function tmux(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
}

function tmuxWithTimeout(socket: string, args: string[], timeoutMs = 5000): string {
  try {
    return execFileSync('tmux', ['-L', socket, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
    }).trim();
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { signal?: string; killed?: boolean };
    // Only emit tmux.command_timeout for real timeouts (killed by SIGTERM from execFileSync timeout)
    if (e.killed === true && e.signal === 'SIGTERM') {
      onTmuxTimeout({
        operation: args[0] ?? 'unknown',
        target: extractTarget(args),
        timeoutMs,
      });
    }
    throw new Error(
      `tmux command timed out after ${timeoutMs}ms: tmux ${args.slice(0, 3).join(' ')}: ${e.message}`
    );
  }
}

/** Four-step launch: idle shell → remain-on-exit → pipe-pane → exec runner. */
export async function createTmuxSession(opts: CreateSessionOpts): Promise<void> {
  const { socket, name, command, args, env, cwd, logPath } = opts;

  mkdirSync(dirname(logPath), { recursive: true });

  // Step 1: new-session with /bin/sh and any env vars
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  tmuxWithTimeout(socket, ['new-session', '-d', '-s', name, '-c', cwd, ...envArgs, '/bin/sh']);

  // Step 2: remain-on-exit so #{pane_dead} is readable after process exits
  tmuxWithTimeout(socket, ['set-window-option', '-t', name, 'remain-on-exit', 'on']);

  // Step 3: pipe-pane before any runner output
  tmuxWithTimeout(socket, ['pipe-pane', '-o', '-t', name, `cat >> ${singleQuote(logPath)}`]);

  // Step 4a: send exec command as literal text
  const tokens = [command, ...args];
  const execCmd = 'exec ' + tokens.map(singleQuote).join(' ');
  tmuxWithTimeout(socket, ['send-keys', '-l', '-t', name, '--', execCmd]);

  // Step 4b: send Enter keypress to execute
  tmuxWithTimeout(socket, ['send-keys', '-t', name, 'Enter']);
}

export function destroyTmuxSession(socket: string, name: string): void {
  try {
    tmuxWithTimeout(socket, ['kill-session', '-t', name]);
  } catch {
    // session may already be gone
  }
}

export function sendText(socket: string, name: string, text: string): void {
  tmuxWithTimeout(socket, ['send-keys', '-l', '-t', name, '--', text]);
}

const ALLOWED_CONTROL_KEYS = new Set(['C-c', 'Enter']);

export function sendControl(socket: string, name: string, key: string): void {
  if (!ALLOWED_CONTROL_KEYS.has(key)) {
    throw new Error(`sendControl: rejected reserved control key "${key}" — only ${[...ALLOWED_CONTROL_KEYS].join(', ')} allowed`);
  }
  tmuxWithTimeout(socket, ['send-keys', '-t', name, key]);
}

export function sendInterrupt(socket: string, name: string): void {
  tmuxWithTimeout(socket, ['send-keys', '-t', name, 'C-c']);
}

export function sendEnter(socket: string, name: string): void {
  tmuxWithTimeout(socket, ['send-keys', '-t', name, 'Enter']);
}

export function captureOutput(socket: string, name: string, lines = 100): string {
  try {
    return tmuxWithTimeout(socket, ['capture-pane', '-p', '-t', name, '-S', String(-lines)]);
  } catch {
    return '';
  }
}

export function isProcessDead(socket: string, name: string): boolean {
  try {
    const val = tmuxWithTimeout(socket, ['display-message', '-p', '-t', name, '#{pane_dead}']);
    return val === '1';
  } catch {
    return true;
  }
}

export function isPipePaneActive(socket: string, name: string): boolean {
  try {
    const val = tmuxWithTimeout(socket, ['display-message', '-p', '-t', name, '#{pane_pipe}']);
    return val === '1';
  } catch {
    return false;
  }
}

export function startOutputLog(socket: string, name: string, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  tmuxWithTimeout(socket, ['pipe-pane', '-o', '-t', name, `cat >> ${singleQuote(logPath)}`]);
}

export function stopPipePane(socket: string, name: string): void {
  try {
    tmuxWithTimeout(socket, ['pipe-pane', '-t', name]);
  } catch {
    // ignore — session may be gone
  }
}

export function getPaneDeadStatus(socket: string, name: string): string {
  try {
    return tmuxWithTimeout(socket, ['display-message', '-p', '-t', name, '#{pane_dead_status}']);
  } catch {
    return '';
  }
}

export function respawnPane(
  socket: string,
  name: string,
  cwd: string,
  env: Record<string, string>
): void {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push('-e', `${k}=${v}`);
  }
  tmuxWithTimeout(socket, ['respawn-pane', '-k', '-t', name, '-c', cwd, ...envArgs, '/bin/sh']);
  tmuxWithTimeout(socket, ['set-window-option', '-t', name, 'remain-on-exit', 'on']);
}

export function listSessions(socket: string): string[] {
  try {
    const out = tmuxWithTimeout(socket, ['list-sessions', '-F', '#{session_name}']);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function getSessionId(socket: string, name: string): string {
  return tmuxWithTimeout(socket, ['display-message', '-p', '-t', name, '#{session_id}']);
}

export function getPaneId(socket: string, name: string): string {
  return tmuxWithTimeout(socket, ['display-message', '-p', '-t', name, '#{pane_id}']);
}
