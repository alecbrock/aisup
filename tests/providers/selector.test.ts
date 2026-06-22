import { describe, it, expect } from 'vitest';
import { resolveCandidates } from '../../src/providers/selector.js';
import type { ProviderUsage, ConcreteCandidate, UsageSignal } from '../../src/providers/types.js';
import type { RoleCandidateConfig } from '../../src/config/schema.js';

function claudeUsageFake(map: Record<string, UsageSignal>): ProviderUsage {
  return {
    usageSignal: (c: ConcreteCandidate): UsageSignal =>
      map[c.account ?? ''] ?? { available: false, headroom_pct: null, remaining_tokens: null, basis: 'unknown', reason: 'missing' },
  };
}
function codexUsageFake(sig: UsageSignal): ProviderUsage {
  return { usageSignal: (): UsageSignal => sig };
}

const claudeC = (over: Partial<RoleCandidateConfig> = {}): RoleCandidateConfig => ({ provider: 'claude', model: null, effort: null, budget: null, ...over });
const codexC = (over: Partial<RoleCandidateConfig> = {}): RoleCandidateConfig => ({ provider: 'codex', model: null, effort: null, budget: null, ...over });
const avail = (headroom: number | null, basis: UsageSignal['basis'] = 'live'): UsageSignal => ({ available: true, headroom_pct: headroom, remaining_tokens: null, basis });
const unavail = (reason: string): UsageSignal => ({ available: false, headroom_pct: null, remaining_tokens: null, basis: 'unknown', reason });

const accounts = [{ name: 'a1', enabled: true }, { name: 'a2', enabled: true }];

describe('resolveCandidates', () => {
  it('expands a [claude, codex] role to claude accounts best-headroom-first then codex', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: avail(40), a2: avail(80) }), codexUsage: codexUsageFake(avail(null, 'budget')), accounts };
    const r = resolveCandidates([claudeC(), codexC()], deps, 0);
    expect(r).toEqual([
      { provider: 'claude', account: 'a2', model: null, effort: null },
      { provider: 'claude', account: 'a1', model: null, effort: null },
      { provider: 'codex', model: null, effort: null },
    ]);
  });

  it('excludes a cooldown/unavailable claude account and an over-budget codex', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: unavail('cooldown'), a2: avail(50) }), codexUsage: codexUsageFake(unavail('budget_exhausted')), accounts };
    const r = resolveCandidates([claudeC(), codexC()], deps, 0);
    expect(r).toEqual([{ provider: 'claude', account: 'a2', model: null, effort: null }]);
  });

  it('orders known-headroom accounts ahead of unknown-headroom ones', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: avail(null, 'unknown'), a2: avail(10) }), codexUsage: codexUsageFake(avail(null, 'budget')), accounts };
    const r = resolveCandidates([claudeC()], deps, 0);
    expect(r.map((c) => c.account)).toEqual(['a2', 'a1']);
  });

  it('returns [] when every candidate is unavailable', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: unavail('cooldown'), a2: unavail('reactive_unavailable') }), codexUsage: codexUsageFake(unavail('budget_exhausted')), accounts };
    expect(resolveCandidates([claudeC(), codexC()], deps, 0)).toEqual([]);
  });

  it('keeps all available claude accounts before the first cross-LLM even when codex is listed first (account-first invariant)', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: avail(30), a2: avail(60) }), codexUsage: codexUsageFake(avail(null, 'budget')), accounts };
    const r = resolveCandidates([codexC(), claudeC()], deps, 0);
    expect(r.map((c) => c.provider)).toEqual(['claude', 'claude', 'codex']);
  });

  it('carries model/effort from the role candidate onto concrete candidates', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: avail(40), a2: unavail('cooldown') }), codexUsage: codexUsageFake(avail(null, 'budget')), accounts };
    const r = resolveCandidates([claudeC({ model: 'claude-opus-4-8', effort: 'high' }), codexC({ model: 'gpt-5', effort: 'medium' })], deps, 0);
    expect(r[0]).toEqual({ provider: 'claude', account: 'a1', model: 'claude-opus-4-8', effort: 'high' });
    expect(r[1]).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'medium' });
  });

  it('skips disabled accounts during claude expansion', () => {
    const deps = { claudeUsage: claudeUsageFake({ a1: avail(40), a2: avail(90) }), codexUsage: codexUsageFake(unavail('x')), accounts: [{ name: 'a1', enabled: true }, { name: 'a2', enabled: false }] };
    const r = resolveCandidates([claudeC()], deps, 0);
    expect(r.map((c) => c.account)).toEqual(['a1']);
  });
});
