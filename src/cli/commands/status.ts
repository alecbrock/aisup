import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

export async function showStatus(): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  if (!existsSync(pidPath)) {
    console.log('aisup daemon: not running');
    return;
  }

  const raw = await readFile(pidPath, 'utf8');
  const { pid, port } = JSON.parse(raw) as { pid: number; port: number };

  try {
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.log(`aisup daemon: running (PID ${pid}) — daemon starting`);
      return;
    }
    const body = await res.json() as { session?: { status?: string; account?: string } };
    const session = body.session;
    if (!session) {
      console.log(`aisup daemon: running (PID ${pid}) — no active session`);
    } else {
      console.log(`aisup daemon: running (PID ${pid})`);
      console.log(`  session: ${session.status ?? 'unknown'} on ${session.account ?? 'unknown'}`);
    }
  } catch {
    console.log(`aisup daemon: running (PID ${pid}) — not responding`);
  }
}
