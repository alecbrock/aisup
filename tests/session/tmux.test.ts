/**
 * @requires_tmux Integration tests — require tmux ≥ 3.2 installed.
 * Tests use a dedicated socket (-L aisup-test) to avoid interfering with user tmux.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  createTmuxSession,
  destroyTmuxSession,
  sendText,
  sendControl,
  captureOutput,
  isProcessDead,
  isPipePaneActive,
  startOutputLog,
  stopPipePane,
  listSessions,
} from '../../src/session/tmux.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_RUNNER = resolve(__dirname, '../fixtures/fake-runner.sh');
const TEST_SOCKET = 'aisup-test';

function tmuxTest(...args: string[]): string {
  return execFileSync('tmux', ['-L', TEST_SOCKET, ...args], { encoding: 'utf8' }).trim();
}

function hasTmux(): boolean {
  const r = spawnSync('which', ['tmux']);
  if (r.status !== 0) return false;
  try {
    execFileSync('tmux', ['-L', TEST_SOCKET, 'new-session', '-d', '-s', 'aisup-probe', '/bin/sh'], { timeout: 5000 });
    execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-session', '-t', 'aisup-probe'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const runIf = hasTmux() ? it : it.skip;

describe('tmux wrapper (integration)', () => {
  let sessionName: string;
  let tmpDir: string;

  beforeAll(() => {
    if (!hasTmux()) return;
    // Clean any leftover test server
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* ok */ }
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-tmux-'));
    sessionName = `aisup-test-${Date.now()}`;
  });

  afterEach(() => {
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  runIf('should create a tmux session using four-step launch', async () => {
    const logPath = join(tmpDir, 'output.log');
    mkdirSync(dirname(logPath), { recursive: true });

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    // Session exists
    const sessions = listSessions(TEST_SOCKET);
    expect(sessions.some((s) => s.includes(sessionName))).toBe(true);
  });

  runIf('should detect pane_dead=1 after process exits via exec', async () => {
    const logPath = join(tmpDir, 'output.log');

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    expect(isProcessDead(TEST_SOCKET, sessionName)).toBe(false);

    // Send quit to exit the fake runner
    sendText(TEST_SOCKET, sessionName, 'quit');
    sendControl(TEST_SOCKET, sessionName, 'Enter');

    // Wait up to 3s for pane to die
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (isProcessDead(TEST_SOCKET, sessionName)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(isProcessDead(TEST_SOCKET, sessionName)).toBe(true);
  });

  runIf('should capture output from pane', async () => {
    const logPath = join(tmpDir, 'output.log');

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    await new Promise((r) => setTimeout(r, 200));
    sendText(TEST_SOCKET, sessionName, 'hello');
    sendControl(TEST_SOCKET, sessionName, 'Enter');
    await new Promise((r) => setTimeout(r, 300));

    const output = captureOutput(TEST_SOCKET, sessionName);
    expect(output).toContain('echo: hello');
  });

  runIf('should write output to pipe-pane log file', async () => {
    const logPath = join(tmpDir, 'output.log');

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    await new Promise((r) => setTimeout(r, 200));
    sendText(TEST_SOCKET, sessionName, 'pipe-test');
    sendControl(TEST_SOCKET, sessionName, 'Enter');
    await new Promise((r) => setTimeout(r, 500));

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('pipe-test');
  });

  runIf('should report pipe-pane as active', async () => {
    const logPath = join(tmpDir, 'output.log');

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(isPipePaneActive(TEST_SOCKET, sessionName)).toBe(true);
  });

  runIf('should handle paths with spaces and special chars', async () => {
    const specialDir = join(tmpDir, 'my dir $special');
    mkdirSync(specialDir, { recursive: true });
    const logPath = join(specialDir, 'out put.log');

    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: specialDir,
      logPath,
    });

    const sessions = listSessions(TEST_SOCKET);
    expect(sessions.some((s) => s.includes(sessionName))).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(logPath)).toBe(true);
  });

  runIf('should destroy a session', async () => {
    const logPath = join(tmpDir, 'output.log');
    await createTmuxSession({
      socket: TEST_SOCKET,
      name: sessionName,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
      logPath,
    });

    destroyTmuxSession(TEST_SOCKET, sessionName);

    const sessions = listSessions(TEST_SOCKET);
    expect(sessions.some((s) => s.includes(sessionName))).toBe(false);
  });
});
