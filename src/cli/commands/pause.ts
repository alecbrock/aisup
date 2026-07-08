import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TOKEN_PATH = join(aisupHome(), 'api-token');

/** C9: pause (SIGSTOP) or resume (SIGCONT) the active session via the daemon. */
async function sessionSignal(verb: 'pause' | 'resume'): Promise<void> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) {
    console.error('aisup daemon is not running');
    process.exit(1);
  }
  const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim();

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${verb}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  if (!res.ok) {
    console.error(`Error: ${body.error ?? res.statusText}`);
    process.exit(1);
  }
  console.log(verb === 'pause' ? 'Session paused (runner SIGSTOPped).' : 'Session resumed (runner SIGCONTed).');
}

export const sessionPause = (): Promise<void> => sessionSignal('pause');
export const sessionResume = (): Promise<void> => sessionSignal('resume');
