import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function showAccounts(): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  const tokenPath = join(homedir(), '.aisup', 'api-token');

  if (!existsSync(pidPath) || !existsSync(tokenPath)) {
    console.log('aisup daemon not running — reading config directly');
    return;
  }

  try {
    const raw = await readFile(pidPath, 'utf8');
    const { port } = JSON.parse(raw) as { port: number };
    const token = (await readFile(tokenPath, 'utf8')).trim();

    const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error('Failed to fetch accounts from daemon');
      return;
    }

    const body = await res.json() as { accounts: Array<{ name: string; state: string; score: number | null }> };
    for (const acct of body.accounts) {
      const score = acct.score !== null ? `${acct.score.toFixed(0)}%` : 'no data';
      console.log(`  ${acct.name}: ${acct.state} (score: ${score})`);
    }
  } catch {
    console.error('Could not reach daemon');
  }
}
