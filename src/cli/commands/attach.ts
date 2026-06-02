import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

export async function sessionAttach(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('aisup attach requires an interactive TTY. Use `aisup status` or `aisup log` instead.');
    process.exit(1);
  }

  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  if (!existsSync(pidPath)) {
    console.error('aisup daemon is not running');
    process.exit(1);
  }
  const raw = await readFile(pidPath, 'utf8');
  const { port } = JSON.parse(raw) as { port: number };
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim();

  const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error('Could not get session status from daemon');
    process.exit(1);
  }
  const body = await res.json() as { session?: { tmux_name?: string } };
  const tmuxName = body.session?.tmux_name;
  if (!tmuxName) {
    console.error('No active session to attach to');
    process.exit(1);
  }

  const config = await loadConfig();
  execFileSync('tmux', ['-L', config.session.tmux_socket, 'attach-session', '-t', tmuxName], { stdio: 'inherit' });
}
