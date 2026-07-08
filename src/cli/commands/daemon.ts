import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { loadConfig } from '../../config/loader.js';
import { readPidFile, removePidFile } from '../pid.js';

const AISUP_DIR = aisupHome();
const PID_PATH = join(AISUP_DIR, 'daemon.pid');

/** C5 port preflight: can we bind 127.0.0.1:<port>? A busy port means a silent detached start
 *  would fail invisibly, so daemonStart checks this and errors loudly first. */
export function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code !== 'EADDRINUSE'); // only EADDRINUSE is a real conflict; other errors don't block
    });
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Best-effort PID of the process holding a port (for the error hint); empty when unknown. */
function occupyingPid(port: number): string {
  try {
    return execFileSync('lsof', ['-i', `:${port}`, '-t'], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

async function isDaemonAlive(pid: number, port: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Verify it's our daemon via health check
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json() as { pid?: number };
    return body.pid === pid;
  } catch {
    return false;
  }
}

export async function daemonStart(): Promise<void> {
  // F-3: validate config in the FOREGROUND before the detached spawn, so a config error (e.g. an
  // absolute workers.worktree_dir) is printed to stderr instead of being swallowed by the daemon's
  // `stdio:'ignore'` and leaving a blank daemon.out.
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    process.stderr.write(`aisup daemon start failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const existing = await readPidFile(PID_PATH);
  if (existing) {
    const alive = await isDaemonAlive(existing.pid, existing.port);
    if (alive) {
      console.error(`aisup daemon already running (PID ${existing.pid})`);
      process.exit(1);
    }
    console.error(`Stale PID file detected (PID ${existing.pid} not responding), replacing.`);
    await removePidFile(PID_PATH);
  }

  // C5 port preflight: the daemon spawns detached with stdio:'ignore', so a port conflict would
  // otherwise fail invisibly. Check it in the foreground and error loudly with the occupying PID.
  if (!(await checkPortFree(config.daemon.port))) {
    const pidHint = occupyingPid(config.daemon.port);
    process.stderr.write(
      `aisup daemon start failed: port ${config.daemon.port} is already in use` +
      `${pidHint ? ` (PID ${pidHint})` : ''}. Stop the other process or change daemon.port.\n`,
    );
    process.exit(1);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const daemonEntry = join(__dirname, '../../daemon/index.js');

  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  console.log(`aisup daemon started (PID ${child.pid ?? 'unknown'})`);
}

/** C13: signal the running daemon to hot-reload config (SIGHUP). */
export async function daemonReload(): Promise<void> {
  const existing = await readPidFile(PID_PATH);
  if (!existing) {
    console.error('aisup daemon is not running (no PID file)');
    process.exit(1);
  }
  try {
    process.kill(existing.pid, 'SIGHUP');
    console.log(`aisup daemon reload requested (PID ${existing.pid}). See daemon.log / \`aisup log --type daemon.reloaded\` for applied vs restart-required keys.`);
  } catch (err) {
    console.error(`Failed to signal daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export async function daemonStop(): Promise<void> {
  const existing = await readPidFile(PID_PATH);
  if (!existing) {
    console.error('aisup daemon is not running (no PID file)');
    process.exit(1);
  }

  const alive = await isDaemonAlive(existing.pid, existing.port);
  if (!alive) {
    console.error(`Stale PID file (PID ${existing.pid} not responding), cleaning up.`);
    await removePidFile(PID_PATH);
    process.exit(1);
  }

  process.kill(existing.pid, 'SIGTERM');

  // Wait up to 5s for exit, then SIGKILL
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(existing.pid, 0);
    } catch {
      await removePidFile(PID_PATH);
      console.log(`aisup daemon stopped (PID ${existing.pid})`);
      return;
    }
  }

  process.kill(existing.pid, 'SIGKILL');
  await removePidFile(PID_PATH);
  console.log(`aisup daemon force-killed (PID ${existing.pid})`);
}
