import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { buildLaunchCommand, validateRunner } from '../../runner/builder.js';
import { getBlockingSession, canStartNewSession } from '../pid.js';
import { listSessions } from '../../session/tmux.js';

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
    const resolvedCwd = resolve(cwd);
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${resolvedCwd}`);
    }
    const config = await loadConfig();
    const liveSessions = listSessions('aisup').filter((s) => s.startsWith('aisup-'));
    const blocking = getBlockingSession(join(homedir(), '.aisup', 'sessions'), liveSessions);
    const admission = canStartNewSession(blocking);
    if (!admission.allowed) {
      throw new Error(admission.reason);
    }
    let planPath: string | null = null;
    if (opts.plan) {
      planPath = resolve(opts.plan);
      accessSync(planPath, constants.R_OK);
      if (!statSync(planPath).isFile()) throw new Error(`plan is not a file: ${planPath}`);
    }
    const account = config.accounts
      .filter((a) => a.enabled)
      .sort((a, b) => a.priority - b.priority)[0];
    if (!account) throw new Error('no enabled account configured');
    const runner = { ...config.runner, command: validateRunner(config.runner) };
    const command = buildLaunchCommand(runner, account.config_dir);
    console.log(`[dry-run] cwd: ${resolvedCwd}`);
    if (planPath) console.log(`[dry-run] plan: ${planPath}`);
    console.log(`[dry-run] account: ${account.name}`);
    console.log(`[dry-run] command: ${command.execString}`);
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
