import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  canStartNewSession,
} from '../../src/cli/pid.js';
import type { SessionStatus } from '../../src/session/types.js';

describe('PID file management', () => {
  let tmpDir: string;
  let pidPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-pid-'));
    pidPath = join(tmpDir, 'daemon.pid');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should write PID file as JSON with pid, port, startedAt', async () => {
    await writePidFile(pidPath, { pid: 12345, port: 7394 });

    const raw = readFileSync(pidPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.pid).toBe(12345);
    expect(data.port).toBe(7394);
    expect(typeof data.startedAt).toBe('string');
    // valid ISO 8601
    expect(new Date(data.startedAt).toISOString()).toBe(data.startedAt);
  });

  it('should write PID file atomically (temp + rename)', async () => {
    // After write, only the final file should exist (temp cleaned up)
    await writePidFile(pidPath, { pid: process.pid, port: 7394 });
    expect(existsSync(pidPath)).toBe(true);
    // No .tmp file left behind
    expect(existsSync(pidPath + '.tmp')).toBe(false);
  });

  it('should read PID file back', async () => {
    await writePidFile(pidPath, { pid: 99999, port: 7394 });
    const data = await readPidFile(pidPath);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(99999);
    expect(data!.port).toBe(7394);
  });

  it('should return null for missing PID file', async () => {
    const data = await readPidFile(join(tmpDir, 'missing.pid'));
    expect(data).toBeNull();
  });

  it('should remove PID file', async () => {
    await writePidFile(pidPath, { pid: process.pid, port: 7394 });
    await removePidFile(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('should not throw when removing non-existent PID file', async () => {
    await expect(removePidFile(join(tmpDir, 'missing.pid'))).resolves.not.toThrow();
  });
});

describe('canStartNewSession', () => {
  it('should allow start when no session exists', () => {
    expect(canStartNewSession(null)).toEqual({ allowed: true });
  });

  it('should allow start when session is STOPPED with no live tmux', () => {
    expect(canStartNewSession({ status: 'STOPPED', hasTmux: false })).toEqual({ allowed: true });
  });

  it('should block start when session is ACTIVE', () => {
    const result = canStartNewSession({ status: 'ACTIVE', hasTmux: true });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/active|progress/i);
  });

  it('should block start for CREATING state', () => {
    expect(canStartNewSession({ status: 'CREATING', hasTmux: false }).allowed).toBe(false);
  });

  it('should block start for SWITCHING state', () => {
    expect(canStartNewSession({ status: 'SWITCHING', hasTmux: true }).allowed).toBe(false);
  });

  it('should block start for STOPPING state', () => {
    expect(canStartNewSession({ status: 'STOPPING', hasTmux: true }).allowed).toBe(false);
  });

  it('should block start for SWITCH_PENDING_AT_IDLE state', () => {
    expect(canStartNewSession({ status: 'SWITCH_PENDING_AT_IDLE', hasTmux: true }).allowed).toBe(false);
  });

  it('should block EXHAUSTED with specific recovery message', () => {
    const result = canStartNewSession({ status: 'EXHAUSTED', hasTmux: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/exhausted|failover/i);
  });

  it('should block STOPPED with live tmux as inconsistent', () => {
    const result = canStartNewSession({ status: 'STOPPED', hasTmux: true });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/inconsistent|orphan|force/i);
  });
});
