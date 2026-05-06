import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
