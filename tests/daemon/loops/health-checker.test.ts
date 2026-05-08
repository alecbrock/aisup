import { describe, it, expect, vi } from 'vitest';
import { HealthChecker, checkAccountHealth } from '../../../src/daemon/loops/health-checker.js';
import type { AccountInfo } from '../../../src/accounts/types.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    name: 'primary',
    configDir: '/nonexistent',
    priority: 1,
    enabled: true,
    state: 'HEALTHY',
    score: null,
    cooldownUntil: null,
    ...overrides,
  };
}

describe('checkAccountHealth', () => {
  it('should report configDirExists=false for nonexistent dir', () => {
    const result = checkAccountHealth(makeAccount({ configDir: '/nonexistent/path' }));
    expect(result.configDirExists).toBe(false);
    expect(result.configDirWritable).toBe(false);
  });

  it('should report configDirExists=true for existing dir', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-health-'));
    try {
      const result = checkAccountHealth(makeAccount({ configDir: tmpDir }));
      expect(result.configDirExists).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('HealthChecker loop', () => {
  it('should start and stop cleanly', () => {
    const checker = new HealthChecker({ intervalMs: 1000, onResult: vi.fn() });
    checker.start();
    checker.stop();
  });

  it('should call onResult with health results when tick function runs checkAccountHealth', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'aisup-health-'));
    mkdirSync(tmpDir, { recursive: true });
    const onResult = vi.fn();
    const checker = new HealthChecker({ intervalMs: 50, onResult });
    const account = makeAccount({ configDir: tmpDir });
    checker.start(() => onResult(checkAccountHealth(account)));
    return new Promise<void>((resolve) => setTimeout(() => {
      checker.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
        account: 'primary',
        configDirExists: true,
      }));
      resolve();
    }, 120));
  });

  it('should not leak intervals after stop', () => {
    const onResult = vi.fn();
    const checker = new HealthChecker({ intervalMs: 50, onResult });
    checker.start(() => onResult({ account: 'x', configDirExists: false, configDirWritable: false }));
    checker.stop();
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(onResult).not.toHaveBeenCalled();
      resolve();
    }, 150));
  });
});
