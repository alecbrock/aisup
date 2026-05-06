import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

async function getDaemonUrl(): Promise<{ url: string; token: string }> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  if (!existsSync(pidPath)) {
    throw new Error('aisup daemon is not running. Start it with: aisup daemon start');
  }
  const raw = await readFile(pidPath, 'utf8');
  const { port } = JSON.parse(raw) as { port: number };
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
  return { url: `http://127.0.0.1:${port}`, token };
}

async function postWithRetry(url: string, token: string, body: unknown): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status !== 503) return res;
      if (i < 2) await new Promise((r) => setTimeout(r, 1000));
      lastErr = new Error('daemon starting');
    } catch (err) {
      lastErr = err;
      if (i < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

export async function sessionStart(opts: {
  cwd?: string;
  plan?: string;
  dryRun?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.dryRun) {
    console.log(`[dry-run] cwd: ${cwd}`);
    console.log('[dry-run] Would POST /api/sessions to daemon');
    return;
  }

  const { url, token } = await getDaemonUrl();
  const res = await postWithRetry(`${url}/api/sessions`, token, { cwd, plan: opts.plan });

  if (!res.ok) {
    const body = await res.json() as { error?: string };
    console.error(`Error: ${body.error ?? res.statusText}`);
    process.exit(1);
  }

  const body = await res.json() as { cwd: string };
  console.log(`Session started in ${body.cwd}`);
}
