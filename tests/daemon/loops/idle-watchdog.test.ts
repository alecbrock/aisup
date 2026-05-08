import { describe, it, expect, vi } from 'vitest';
import { IdleWatchdog, isSessionIdle } from '../../../src/daemon/loops/idle-watchdog.js';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('isSessionIdle', () => {
  it('should return false for missing log file', () => {
    expect(isSessionIdle('/nonexistent/output.log', 30)).toBe(false);
  });

  it('should return false for a freshly written log', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-idle-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'line\n');
    try {
      expect(isSessionIdle(logPath, 86400)).toBe(false); // 24h boundary — fresh file can't be idle
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return true when log mtime is older than idle boundary', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-idle-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'line\n');
    // Backdate mtime to 60s ago so a 30s boundary is exceeded
    const past = new Date(Date.now() - 60_000);
    utimesSync(logPath, past, past);
    try {
      expect(isSessionIdle(logPath, 30)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('IdleWatchdog loop', () => {
  it('should start and stop cleanly', () => {
    const watchdog = new IdleWatchdog({ intervalMs: 1000, onIdle: vi.fn() });
    watchdog.start();
    watchdog.stop();
  });

  it('should call onIdle when tick function detects idle session', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-idle-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'line\n');
    // Backdate to 60s ago so 30s boundary is exceeded
    const past = new Date(Date.now() - 60_000);
    utimesSync(logPath, past, past);
    const onIdle = vi.fn();
    const watchdog = new IdleWatchdog({ intervalMs: 50, onIdle });
    watchdog.start(() => {
      if (isSessionIdle(logPath, 30)) onIdle('session-123');
    });
    return new Promise<void>((resolve) => setTimeout(() => {
      watchdog.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      expect(onIdle).toHaveBeenCalledWith('session-123');
      resolve();
    }, 120));
  });

  it('should not call onIdle when session is not idle', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-idle-'));
    const logPath = join(tmpDir, 'output.log');
    writeFileSync(logPath, 'line\n');
    const onIdle = vi.fn();
    const watchdog = new IdleWatchdog({ intervalMs: 50, onIdle });
    watchdog.start(() => {
      if (isSessionIdle(logPath, 86400)) onIdle('session-123'); // 24h — won't trigger
    });
    return new Promise<void>((resolve) => setTimeout(() => {
      watchdog.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      expect(onIdle).not.toHaveBeenCalled();
      resolve();
    }, 120));
  });

  it('should not leak intervals after stop', () => {
    const onIdle = vi.fn();
    const watchdog = new IdleWatchdog({ intervalMs: 50, onIdle });
    watchdog.start(() => onIdle('session-x'));
    watchdog.stop();
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(onIdle).not.toHaveBeenCalled();
      resolve();
    }, 150));
  });
});
