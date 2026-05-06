import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readPidFile, removePidFile } from '../pid.js';

const AISUP_DIR = join(homedir(), '.aisup');
const PID_PATH = join(AISUP_DIR, 'daemon.pid');

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
