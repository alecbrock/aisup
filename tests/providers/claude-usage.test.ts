import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';
import { ClaudeProviderUsage, type AccountStateView } from '../../src/providers/claude-usage.js';

describe('ClaudeProviderUsage', () => {
  let dir: string;
  let ledger: UsageLedger;
  const NOW = 1_700_000_000_000; // fixed ms
  const sec = (deltaS: number): number => NOW / 1000 + deltaS;
  const accounts = new Map<string, AccountStateView>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-claude-usage-'));
    ledger = new UsageLedger(join(dir, 'ledger.json'), 5 * 60 * 1000);
    accounts.clear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function withAccount(extra?: Partial<AccountStateView>): ClaudeProviderUsage {
    accounts.set('primary', { name: 'primary', enabled: true, inCooldown: false, reactivelyUnavailable: false, ...extra });
    return new ClaudeProviderUsage({ ledger, getAccount: (n) => accounts.get(n) ?? null });
  }

  it('returns available with a headroom % for a live ledger window', () => {
    ledger.capture('primary', { five_hour: { used_pct: 40, reset_at: sec(3600) }, seven_day: { used_pct: 20, reset_at: sec(7200) } }, NOW);
    const sig = withAccount().usageSignal({ provider: 'claude', account: 'primary' }, NOW);
    expect(sig.available).toBe(true);
    expect(sig.basis).toBe('live');
    expect(sig.headroom_pct).toBeCloseTo((100 - 40) * 0.7 + (100 - 20) * 0.3); // 66
  });

  it('returns full headroom when the rolling window has reset', () => {
    ledger.capture('primary', { five_hour: { used_pct: 90, reset_at: sec(-10) }, seven_day: { used_pct: 90, reset_at: sec(-10) } }, NOW - 10 * 60 * 1000);
    const sig = withAccount().usageSignal({ provider: 'claude', account: 'primary' }, NOW);
    expect(sig.available).toBe(true);
    expect(sig.basis).toBe('reset');
    expect(sig.headroom_pct).toBe(100);
  });

  it('is unavailable while in circuit-breaker cooldown', () => {
    ledger.capture('primary', { five_hour: { used_pct: 10, reset_at: sec(3600) }, seven_day: { used_pct: 10, reset_at: sec(7200) } }, NOW);
    const sig = withAccount({ inCooldown: true }).usageSignal({ provider: 'claude', account: 'primary' }, NOW);
    expect(sig.available).toBe(false);
    expect(sig.reason).toMatch(/cooldown/i);
  });

  it('is unavailable when reactively marked (429/quota/auth)', () => {
    const sig = withAccount({ reactivelyUnavailable: true }).usageSignal({ provider: 'claude', account: 'primary' }, NOW);
    expect(sig.available).toBe(false);
    expect(sig.reason).toMatch(/reactive/i);
  });

  it('is optimistically available with unknown headroom when no telemetry exists', () => {
    const sig = withAccount().usageSignal({ provider: 'claude', account: 'primary' }, NOW);
    expect(sig.available).toBe(true);
    expect(sig.headroom_pct).toBeNull();
    expect(sig.basis).toBe('unknown');
  });

  it('is unavailable for an unknown or disabled account', () => {
    const usage = new ClaudeProviderUsage({ ledger, getAccount: () => null });
    const sig = usage.usageSignal({ provider: 'claude', account: 'ghost' }, NOW);
    expect(sig.available).toBe(false);
  });
});
