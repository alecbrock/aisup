import type { UsageLedger } from '../accounts/usage-ledger.js';
import type { CodexBudgetConfig } from '../config/schema.js';
import type { ConcreteCandidate, ProviderUsage, UsageSignal } from './types.js';

export interface CodexUsageDeps {
  ledger: UsageLedger;
  /** The configured token budget for this provider; null = unmetered (always available, reactive-only). */
  budget: CodexBudgetConfig | null;
}

/**
 * Codex provider usage: a metered token budget. Consumption is recorded per run from `codex exec --json`
 * `turn.completed.usage` (Task 4/7); availability is `tokens_used < cap` over the rolling period. With no
 * configured budget, codex is always available here — only a reactive 429/quota error (Task 7) stops it.
 */
export class CodexProviderUsage implements ProviderUsage {
  constructor(private readonly deps: CodexUsageDeps) {}

  usageSignal(candidate: ConcreteCandidate, nowMs: number): UsageSignal {
    if (!this.deps.budget) {
      return { available: true, headroom_pct: null, remaining_tokens: null, basis: 'budget' };
    }
    const est = this.deps.ledger.estimateBudget(candidate.provider, nowMs, this.deps.budget);
    return {
      available: est.available,
      headroom_pct: null,
      remaining_tokens: est.remaining,
      basis: 'budget',
      reason: est.available ? undefined : 'budget_exhausted',
    };
  }
}
