import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

export async function sessionStop(opts: { force?: boolean }): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  if (!existsSync(pidPath)) {
    console.error('aisup daemon is not running');
    process.exit(1);
  }
  const raw = await readFile(pidPath, 'utf8');
  const { port } = JSON.parse(raw) as { port: number };
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim();

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ force: opts.force ?? false }),
  });

  if (!res.ok) {
    const body = await res.json() as { error?: string };
    console.error(`Error: ${body.error ?? res.statusText}`);
    process.exit(1);
  }

  console.log(opts.force ? 'Session force-stopped.' : 'Session stopped.');
}
