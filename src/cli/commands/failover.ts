import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function triggerFailover(targetAccount: string): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  const tokenPath = join(homedir(), '.aisup', 'api-token');

  if (!existsSync(pidPath)) {
    console.error('aisup daemon is not running');
    process.exit(1);
  }

  const raw = await readFile(pidPath, 'utf8');
  const { port } = JSON.parse(raw) as { port: number };
  const token = (await readFile(tokenPath, 'utf8')).trim();

  const res = await fetch(`http://127.0.0.1:${port}/api/failover`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ target_account: targetAccount }),
  });

  const body = await res.json() as { error?: string; launch_mode?: string; target_account?: string };

  if (!res.ok) {
    console.error(`Failover failed: ${body.error ?? res.statusText}`);
    process.exit(1);
  }

  console.log(`Failover initiated → ${body.target_account} (${body.launch_mode ?? 'unknown mode'})`);
}
