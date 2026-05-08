/**
 * @requires_tmux Integration tests for SessionManager.
 * Uses dedicated socket -L aisup-test.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { SessionManager } from '../../src/session/manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_RUNNER = resolve(__dirname, '../fixtures/fake-runner.sh');
const TEST_SOCKET = 'aisup-test-mgr';

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

const runIf = hasTmux() ? it : it.skip;

describe('SessionManager (integration)', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeAll(() => {
    if (!hasTmux()) return;
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* ok */ }
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-mgr-'));
    manager = new SessionManager({
      tmuxSocket: TEST_SOCKET,
      stateDir: join(tmpDir, 'sessions'),
      outputLogMaxSizeMb: 50,
    });
  });

  afterEach(() => {
    try { execFileSync('tmux', ['-L', TEST_SOCKET, 'kill-server']); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  runIf('should create a session with ACTIVE state', async () => {
    const session = await manager.createSession({
      aisupSessionId: 'test-session-123',
      account: 'primary',
      accountConfigDir: tmpDir,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
    });

    expect(session.status).toBe('ACTIVE');
    expect(session.aisup_session_id).toBe('test-session-123');
    expect(session.account).toBe('primary');
    expect(session.tmux_name).toMatch(/^aisup-/);
  });

  runIf('should write state file atomically on creation', async () => {
    const session = await manager.createSession({
      aisupSessionId: 'state-test-456',
      account: 'primary',
      accountConfigDir: tmpDir,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
    });

    const statePath = join(tmpDir, 'sessions', 'state-test-456', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    // No .tmp file left behind
    expect(existsSync(statePath + '.tmp')).toBe(false);

    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { status: string };
    expect(parsed.status).toBe('ACTIVE');
  });

  runIf('should stop a session gracefully and set STOPPED state', async () => {
    const session = await manager.createSession({
      aisupSessionId: 'stop-test-789',
      account: 'primary',
      accountConfigDir: tmpDir,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
    });

    await manager.stopSession(session.tmux_name, session.aisup_session_id, { force: false });

    const statePath = join(tmpDir, 'sessions', 'stop-test-789', 'state.json');
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { status: string };
    expect(parsed.status).toBe('STOPPED');
  });

  runIf('should list active aisup sessions', async () => {
    await manager.createSession({
      aisupSessionId: 'list-test-aaa',
      account: 'primary',
      accountConfigDir: tmpDir,
      command: '/bin/sh',
      args: [FAKE_RUNNER],
      env: {},
      cwd: tmpDir,
    });

    const sessions = manager.listTmuxSessions();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((s) => s.includes('aisup-'))).toBe(true);
  });
});
