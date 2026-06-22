import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../../src/accounts/usage-ledger.js';
import { CodexProviderUsage } from '../../src/providers/codex-usage.js';
import { DEFAULT_CODEX_BUDGET, resolveCodexBudget } from '../../src/config/defaults.js';

describe('resolveCodexBudget', () => {
  const claude = { provider: 'claude', model: null, effort: null, budget: null };
  const codexNoBudget = { provider: 'codex', model: null, effort: null, budget: null };
  it('falls back to the default codex budget when no candidate has an explicit one', () => {
    expect(resolveCodexBudget({ implementer: [claude, codexNoBudget], reviewer: [codexNoBudget], orchestrator: [] }))
      .toEqual(DEFAULT_CODEX_BUDGET);
  });
  it('prefers an explicit per-candidate budget over the default', () => {
    const explicit = { tokens: 50, period_hours: 1 };
    expect(resolveCodexBudget({ implementer: [{ ...codexNoBudget, budget: explicit }], reviewer: [codexNoBudget], orchestrator: [] }))
      .toEqual(explicit);
  });
  it('the default budget is the plan starter value (3M tokens / 5h)', () => {
    expect(DEFAULT_CODEX_BUDGET).toEqual({ tokens: 3_000_000, period_hours: 5 });
  });
});

describe('CodexProviderUsage + ledger budget meter', () => {
  let dir: string;
  let ledger: UsageLedger;
  const NOW = 1_700_000_000_000;
  const budget = { tokens: 1000, period_hours: 5 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-codex-usage-'));
    ledger = new UsageLedger(join(dir, 'ledger.json'), 5 * 60 * 1000);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sig = (nowMs: number, b = budget): ReturnType<CodexProviderUsage['usageSignal']> =>
    new CodexProviderUsage({ ledger, budget: b }).usageSignal({ provider: 'codex' }, nowMs);

  it('is available with full remaining before any consumption', () => {
    const s = sig(NOW);
    expect(s.available).toBe(true);
    expect(s.remaining_tokens).toBe(1000);
    expect(s.basis).toBe('budget');
  });

  it('accumulates consumption and reports remaining', () => {
    ledger.recordConsumption('codex', 300, NOW, budget);
    ledger.recordConsumption('codex', 200, NOW, budget);
    const s = sig(NOW);
    expect(s.remaining_tokens).toBe(500);
    expect(s.available).toBe(true);
  });

  it('is unavailable once consumption crosses the cap', () => {
    ledger.recordConsumption('codex', 1000, NOW, budget);
    const s = sig(NOW);
    expect(s.available).toBe(false);
    expect(s.remaining_tokens).toBe(0);
    expect(s.reason).toMatch(/budget/i);
  });

  it('resets after the rolling period elapses', () => {
    ledger.recordConsumption('codex', 1000, NOW, budget); // exhausted
    const later = NOW + 6 * 3600 * 1000; // > 5h
    const s = sig(later);
    expect(s.available).toBe(true);
    expect(s.remaining_tokens).toBe(1000);
  });

  it('reflects a lowered live budget cap immediately (no stored-cap staleness)', () => {
    ledger.recordConsumption('codex', 600, NOW, budget); // used 600 of 1000
    const s = sig(NOW, { tokens: 500, period_hours: 5 }); // operator lowered cap below used
    expect(s.available).toBe(false);
    expect(s.remaining_tokens).toBe(0);
  });

  it('is always available when no budget is configured', () => {
    const s = new CodexProviderUsage({ ledger, budget: null }).usageSignal({ provider: 'codex' }, NOW);
    expect(s.available).toBe(true);
  });
});
