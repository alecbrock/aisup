import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { SessionState } from '../../session/types.js';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

export function readOfflineSessionStates(stateDir = join(homedir(), '.aisup', 'sessions')): Partial<SessionState>[] {
  if (!existsSync(stateDir)) return [];
  const sessions: Partial<SessionState>[] = [];
  try {
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry, 'state.json');
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionState>;
        sessions.push(parsed);
      } catch { /* skip corrupt state */ }
    }
  } catch {
    return [];
  }
  return sessions.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
}

function printOfflineStatus(stateDir = join(homedir(), '.aisup', 'sessions'), json = false): void {
  const sessions = readOfflineSessionStates(stateDir);
  if (json) {
    console.log(JSON.stringify({ daemon: { running: false }, sessions }, null, 2));
    return;
  }
  console.log('aisup daemon: not running');
  if (sessions.length === 0) return;
  console.log('persisted sessions:');
  for (const s of sessions) {
    console.log(`  ${s.aisup_session_id ?? 'unknown'}: ${s.status ?? 'unknown'} on ${s.account ?? 'unknown'}`);
    console.log(`    tmux: ${s.tmux_name ?? 'unknown'}  cwd: ${s.cwd ?? 'unknown'}  updated: ${s.updated_at ?? 'unknown'}`);
  }
}

export async function showStatus(opts: { json?: boolean } = {}): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  if (!existsSync(pidPath)) {
    printOfflineStatus(undefined, opts.json ?? false);
    return;
  }

  const raw = await readFile(pidPath, 'utf8');
  const { pid, port } = JSON.parse(raw) as { pid: number; port: number };
  if (!isPidAlive(pid)) {
    printOfflineStatus(undefined, opts.json ?? false);
    return;
  }

  try {
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.log(`aisup daemon: running (PID ${pid}) — daemon starting`);
      return;
    }
    const body = await res.json() as { session?: Partial<SessionState> };
    const session = body.session;
    if (opts.json) {
      console.log(JSON.stringify({ daemon: { running: true, pid }, session: session ?? null }, null, 2));
      return;
    }
    if (!session) {
      console.log(`aisup daemon: running (PID ${pid}) — no active session`);
    } else {
      console.log(`aisup daemon: running (PID ${pid})`);
      console.log(`  session: ${session.aisup_session_id ?? 'unknown'} ${session.status ?? 'unknown'} on ${session.account ?? 'unknown'}`);
      console.log(`  tmux: ${session.tmux_name ?? 'unknown'}  cwd: ${session.cwd ?? 'unknown'}`);
    }
  } catch {
    if (opts.json) {
      console.log(JSON.stringify({ daemon: { running: true, pid, responding: false }, sessions: readOfflineSessionStates() }, null, 2));
      return;
    }
    console.log(`aisup daemon: running (PID ${pid}) — not responding`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
