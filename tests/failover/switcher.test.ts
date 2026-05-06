import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SwitchReason } from '../../src/failover/types.js';
import { validateManualFailoverTarget } from '../../src/failover/switcher.js';
import type { AccountInfo } from '../../src/accounts/types.js';

describe('validateManualFailoverTarget', () => {
  const makeAccounts = (overrides: Partial<AccountInfo>[] = []): AccountInfo[] => [
    {
      name: 'primary',
      configDir: '/home/.claude',
      priority: 1,
      enabled: true,
      state: 'ACTIVE' as AccountInfo['state'],
      score: 50,
      cooldownUntil: null,
      ...overrides[0],
    },
    {
      name: 'account2',
      configDir: '/home/.claude-account2',
      priority: 2,
      enabled: true,
      state: 'HEALTHY',
      score: 60,
      cooldownUntil: null,
      ...overrides[1],
    },
  ];

  it('should accept a valid HEALTHY target that is not current', () => {
    const result = validateManualFailoverTarget('account2', 'primary', makeAccounts());
    expect(result.valid).toBe(true);
  });

  it('should reject target not in config', () => {
    const result = validateManualFailoverTarget('unknown', 'primary', makeAccounts());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_invalid|not found/i);
  });

  it('should reject when target is current account', () => {
    const result = validateManualFailoverTarget('primary', 'primary', makeAccounts());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_is_current|already/i);
  });

  it('should reject disabled target', () => {
    const accounts = makeAccounts([{}, { enabled: false, state: 'HEALTHY' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_unavailable|disabled/i);
  });

  it('should reject UNAVAILABLE target', () => {
    const accounts = makeAccounts([{}, { state: 'UNAVAILABLE' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/target_unavailable/i);
  });

  it('should accept COOLDOWN target with a warning (manual override)', () => {
    const accounts = makeAccounts([{}, { state: 'COOLDOWN' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/cooldown/i);
  });

  it('should accept DEGRADED target', () => {
    const accounts = makeAccounts([{}, { state: 'DEGRADED' }]);
    const result = validateManualFailoverTarget('account2', 'primary', accounts);
    expect(result.valid).toBe(true);
  });
});

describe('SwitchReason enum values', () => {
  it('should define expected switch reasons', () => {
    expect(SwitchReason.SoftThreshold).toBeDefined();
    expect(SwitchReason.HardThreshold).toBeDefined();
    expect(SwitchReason.RateLimit429).toBeDefined();
    expect(SwitchReason.ProcessCrash).toBeDefined();
    expect(SwitchReason.Manual).toBeDefined();
    expect(SwitchReason.CircuitBreaker).toBeDefined();
    expect(SwitchReason.RestartFailures).toBeDefined();
  });
});
