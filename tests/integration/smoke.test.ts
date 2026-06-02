/**
 * @requires_tmux   End-to-end daemon smoke test — requires tmux (≥ 3.2) installed.
 * @requires_claude Only the `AISUP_TEST_PERMISSIONS=1` sub-test launches a real runner that
 *                  can produce permission prompts; the default flow uses a stub `/bin/sh` runner.
 *
 * Runtime guard: the ENTIRE suite is skipped unless `AISUP_INTEGRATION=1` is set.
 *
 * Isolation contract: every subprocess runs under a throwaway `HOME` and on a unique tmux
 * socket `aisup-test-<pid>`. The production `aisup` socket is NEVER created, enumerated,
 * attached to, or killed. Cleanup touches only the configured test socket.
 *
 * Run:
 *   AISUP_INTEGRATION=1 npx vitest run tests/integration/smoke.test.ts
 *   AISUP_INTEGRATION=1 AISUP_TEST_PERMISSIONS=1 npx vitest run tests/integration/smoke.test.ts
 *
 * Observed telemetry fields and the permission-validation procedure are recorded in
 * tests/integration/TELEMETRY_FIELDS.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const FAKE_RUNNER = resolve(__dirname, '../fixtures/fake-runner.sh');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const DAEMON_ENTRY = resolve(REPO_ROOT, 'src/daemon/index.ts');

const INTEGRATION = process.env.AISUP_INTEGRATION === '1';

// Unique per-process test socket. This guard is a hard safety boundary: the smoke test
// must never operate on the production `aisup` socket (plan Task 1 acceptance criteria).
const TEST_SOCKET = `aisup-test-${process.pid}`;
if (TEST_SOCKET === 'aisup' || !TEST_SOCKET.startsWith('aisup-test-')) {
  throw new Error(`refusing to run integration smoke test on unsafe tmux socket "${TEST_SOCKET}"`);
}

/** Probe tmux on the test socket only — creates and kills a throwaway probe session. */
function hasTmux(): boolean {
  if (spawnSync('which', ['tmux']).status !== 0) return false;
  try {
    execFileSync('tmux', ['-L', TEST_SOCKET, 'new-session', '-d', '-s', 'aisup-probe', '/bin/sh'], { timeout: 5000 });
    execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-session', '-t', 'aisup-probe'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const TMUX_OK = INTEGRATION && hasTmux();
const runSmoke = TMUX_OK ? it : it.skip;
// Live permission validation needs a real Claude runner with bypass mode disabled.
const runPerms = (TMUX_OK && process.env.AISUP_TEST_PERMISSIONS === '1') ? it : it.skip;

/** List sessions on the test socket; returns [] when no server/sessions exist. */
function tmuxSessions(): string[] {
  try {
    const out = execFileSync('tmux', ['-L', TEST_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // daemon not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** Authenticated daemon request that retries while the daemon reports 503 (still starting). */
async function api(port: number, token: string, path: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + 15000;
  let last: Response | null = null;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status !== 503 || Date.now() >= deadline) return res;
    last = res;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last as Response;
}

describe('aisup daemon end-to-end smoke (integration)', () => {
  let tempHome: string | undefined;
  let port = 0;
  let token = '';
  let daemon: ChildProcess | null = null;
  let daemonOutput = '';

  beforeAll(async () => {
    if (!TMUX_OK) return;
    // Clear any leftover test server from a previous interrupted run.
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* none */ }

    tempHome = mkdtempSync(join(tmpdir(), 'aisup-smoke-'));
    mkdirSync(join(tempHome, '.aisup'), { recursive: true, mode: 0o700 });
    mkdirSync(join(tempHome, '.claude'), { recursive: true, mode: 0o700 });
    mkdirSync(join(tempHome, '.claude-account2'), { recursive: true, mode: 0o700 });
    mkdirSync(join(tempHome, 'statusline'), { recursive: true, mode: 0o700 });

    token = `smoke-${process.pid}-token`;
    writeFileSync(join(tempHome, '.aisup', 'api-token'), token, { mode: 0o600 });

    port = await freePort();

    // Stub runner (`/bin/sh <fake-runner>`) keeps a live pane without a real Claude. The unique
    // test socket + temp HOME mean nothing here can reach the user's live supervisor state.
    const config = [
      'accounts:',
      '  - name: primary',
      `    config_dir: ${join(tempHome, '.claude')}`,
      '    priority: 1',
      '    enabled: true',
      '  - name: account2',
      `    config_dir: ${join(tempHome, '.claude-account2')}`,
      '    priority: 2',
      '    enabled: true',
      'runner:',
      '  command: /bin/sh',
      '  args:',
      `    - ${FAKE_RUNNER}`,
      'session:',
      `  tmux_socket: ${TEST_SOCKET}`,
      'daemon:',
      `  port: ${port}`,
      'statusline:',
      `  directory: ${join(tempHome, 'statusline')}`,
      'journal:',
      `  path: ${join(tempHome, '.aisup', 'journal.jsonl')}`,
      '',
    ].join('\n');
    writeFileSync(join(tempHome, '.aisup', 'config.yaml'), config, { mode: 0o600 });

    daemon = spawn(TSX, [DAEMON_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: tempHome, AISUP_INTEGRATION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout?.on('data', (d) => { daemonOutput += String(d); });
    daemon.stderr?.on('data', (d) => { daemonOutput += String(d); });

    const up = await waitForHealth(port, 45000);
    if (!up) {
      let log = '';
      try { log = readFileSync(join(tempHome, '.aisup', 'daemon.log'), 'utf8'); } catch { /* none */ }
      throw new Error(
        `daemon did not become healthy on :${port}\n--- spawn output ---\n${daemonOutput}\n--- daemon.log ---\n${log}`
      );
    }
  }, 60000);

  afterAll(async () => {
    // Terminate BOTH the spawned `tsx` launcher AND the real daemon it forks. The daemon runs in a
    // child process and persists its own pid to `.aisup/daemon.pid`; signalling only the launcher
    // leaves the daemon flushing journal/heartbeat writes into the temp home, which races `rmSync`
    // (ENOTEMPTY) and briefly orphans the process. Signal the real pid, then wait for it to exit.
    const pids: number[] = [];
    if (daemon?.pid) pids.push(daemon.pid);
    try {
      const pf = JSON.parse(readFileSync(join(tempHome!, '.aisup', 'daemon.pid'), 'utf8')) as { pid: number };
      if (pf.pid) pids.push(pf.pid);
    } catch { /* pid file already removed by a clean shutdown */ }

    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    await waitFor(() => pids.every((pid) => !alive(pid)), 10000);
    for (const pid of pids) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }

    // Cleanup ONLY the configured test socket — never the production `aisup` socket.
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* none */ }

    // Retry removal to absorb any final async flush landing between the exit check and the unlink walk.
    if (tempHome) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { rmSync(tempHome, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
    }
  }, 30000);

  runSmoke('boots isolated, starts/stops a session on the test socket, and leaves no orphans', async () => {
    // Hard safety boundary: this test must never touch the production socket.
    expect(TEST_SOCKET).not.toBe('aisup');

    // Health reports our daemon's port and a pid consistent with its own persisted pid file.
    // (The spawned `tsx` launcher forks the real daemon process, so we verify internal
    // consistency against the pid file the daemon wrote, not the launcher's pid.)
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as {
      pid: number; port: number; ready: boolean;
    };
    expect(health.port).toBe(port);
    const pidFile = JSON.parse(
      readFileSync(join(tempHome!, '.aisup', 'daemon.pid'), 'utf8')
    ) as { pid: number; port: number };
    expect(pidFile.port).toBe(port);
    expect(health.pid).toBe(pidFile.pid);

    // No sessions on the test socket before we start one.
    expect(tmuxSessions()).toEqual([]);

    // Start a session through the daemon API (the canonical admission path).
    const startRes = await api(port, token, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: tempHome }),
    });
    expect(startRes.status).toBe(201);
    const started = await startRes.json() as { aisup_session_id: string; account: string; cwd: string };
    expect(started.aisup_session_id).toBeTruthy();
    expect(['primary', 'account2']).toContain(started.account);

    const tmuxName = `aisup-${started.aisup_session_id.slice(0, 8)}`;

    // Attach/socket contract (no interactive attach in Vitest): the session container exists
    // on the TEST socket and `has-session` confirms it.
    expect(tmuxSessions()).toContain(tmuxName);
    expect(() =>
      execFileSync('tmux', ['-L', TEST_SOCKET, 'has-session', '-t', tmuxName], { timeout: 5000 })
    ).not.toThrow();

    // Daemon status reflects the active session, read from persisted state.
    const status = await (await api(port, token, '/api/status')).json() as {
      session: { aisup_session_id?: string; status?: string; tmux_name?: string } | null;
    };
    expect(status.session?.aisup_session_id).toBe(started.aisup_session_id);
    expect(status.session?.status).toBe('ACTIVE');
    expect(status.session?.tmux_name).toBe(tmuxName);

    // Stop the session (force skips the graceful keystroke wait).
    const stopRes = await api(port, token, '/api/sessions', {
      method: 'DELETE',
      body: JSON.stringify({ force: true }),
    });
    expect(stopRes.status).toBe(200);

    // The tmux session is destroyed and no orphan remains on the test socket.
    expect(await waitFor(() => !tmuxSessions().includes(tmuxName), 5000)).toBe(true);
    expect(tmuxSessions()).toEqual([]);
  }, 60000);

  // TODO(Task 10): once the permission detector + broker are wired, drive a real Claude session
  // with bypass mode disabled, trigger a permission prompt, assert detector output, then assert
  // that `config.permissions.approval_key` + Enter approves and `denial_key` + Enter denies.
  // Until then this path is host-gated behind AISUP_TEST_PERMISSIONS=1 and the manual fallback is
  // documented in TELEMETRY_FIELDS.md.
  runPerms('AISUP_TEST_PERMISSIONS: validates real Claude permission prompt approval/denial', () => {
    throw new Error(
      'Live permission validation requires a real Claude runner with bypass mode disabled and the ' +
      'permission broker (plan Tasks 8–10). See tests/integration/TELEMETRY_FIELDS.md for the manual procedure.'
    );
  });
});
