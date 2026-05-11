import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionInfo, StartAllowedResult } from '../session/types.js';

export interface PidData {
  pid: number;
  port: number;
  startedAt: string;
}

export async function writePidFile(pidPath: string, opts: { pid: number; port: number }): Promise<void> {
  const data: PidData = { pid: opts.pid, port: opts.port, startedAt: new Date().toISOString() };
  const tmpPath = pidPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, pidPath);
}

export async function readPidFile(pidPath: string): Promise<PidData | null> {
  if (!existsSync(pidPath)) return null;
  try {
    const raw = await readFile(pidPath, 'utf8');
    return JSON.parse(raw) as PidData;
  } catch {
    return null;
  }
}

export async function removePidFile(pidPath: string): Promise<void> {
  try {
    await unlink(pidPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function canStartNewSession(session: SessionInfo | null): StartAllowedResult {
  if (session === null) return { allowed: true };

  const { status, hasTmux } = session;

  switch (status) {
    case 'STOPPED':
      if (hasTmux) {
        return {
          allowed: false,
          reason:
            'Session is STOPPED but a live tmux session still exists (inconsistent/orphaned). ' +
            'Run `aisup stop --force` or `aisup doctor` to recover before starting.',
        };
      }
      return { allowed: true };

    case 'EXHAUSTED':
      return {
        allowed: false,
        reason:
          'Session exhausted (all accounts rate-limited). Recovery options: ' +
          '`aisup failover --to <account>` to resume with a specific account, ' +
          'or `aisup stop` then `aisup start` to start fresh.',
      };

    case 'CREATING':
    case 'ACTIVE':
    case 'SWITCH_PENDING_AT_IDLE':
    case 'SWITCHING':
    case 'STOPPING':
      return {
        allowed: false,
        reason:
          'Session operation in progress or already active. ' +
          'Use `aisup stop` first or `aisup failover` to switch accounts.',
      };

    default:
      return { allowed: false, reason: `Unknown session status: ${status as string}` };
  }
}

export function getBlockingSession(stateDir: string, liveTmuxSessions: string[]): SessionInfo | null {
  const live = new Set(liveTmuxSessions);
  if (!existsSync(stateDir)) {
    if (live.size > 0) {
      return { status: 'STOPPED', hasTmux: true };
    }
    return null;
  }

  let stoppedWithLive: SessionInfo | null = null;
  try {
    for (const entry of readdirSync(stateDir)) {
      const path = join(stateDir, entry, 'state.json');
      if (!existsSync(path)) continue;
      let parsed: { aisup_session_id?: string; status?: string; tmux_name?: string } | null = null;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as { aisup_session_id?: string; status?: string; tmux_name?: string };
      } catch {
        continue;
      }
      if (!parsed?.status) continue;
      const hasTmux = parsed.tmux_name ? live.has(parsed.tmux_name) : false;
      const info: SessionInfo = {
        status: parsed.status as SessionInfo['status'],
        aisup_session_id: parsed.aisup_session_id ?? entry,
        hasTmux,
      };
      if (info.status === 'STOPPED') {
        if (hasTmux) stoppedWithLive = info;
        continue;
      }
      return info;
    }
  } catch {
    return null;
  }

  if (stoppedWithLive) return stoppedWithLive;
  for (const name of live) {
    if (name.startsWith('aisup-')) return { status: 'STOPPED', hasTmux: true };
  }
  return null;
}
