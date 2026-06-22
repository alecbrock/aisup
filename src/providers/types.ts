/**
 * Provider-agnostic usage signals for worker multi-provider failover (Part B).
 *
 * A `ProviderUsage` answers, for one concrete run target, whether it currently has headroom and how
 * that estimate was derived. Claude is per-account (statusline-ledger headroom %); codex is a metered
 * token budget. The selector consumes these to order candidates account-first then cross-LLM.
 */

export type UsageBasis = 'live' | 'aged' | 'reset' | 'budget' | 'unknown';

export interface UsageSignal {
  available: boolean;
  /** Claude account headroom 0-100 (higher = more capacity); null when not headroom-based or unknown. */
  headroom_pct: number | null;
  /** Codex remaining tokens against its budget; null when not budget-based. */
  remaining_tokens: number | null;
  basis: UsageBasis;
  /** Set when `available` is false, naming why (cooldown, reactive_unavailable, budget_exhausted, …). */
  reason?: string;
}

/** A concrete run target resolved from a role candidate: a provider plus (for Claude) a chosen account. */
export interface ConcreteCandidate {
  provider: string;
  account?: string;
  model?: string | null;
  effort?: string | null;
}

export interface ProviderUsage {
  /** Availability + headroom for a concrete candidate at `nowMs` (ms epoch). Pure read of current state. */
  usageSignal(candidate: ConcreteCandidate, nowMs: number): UsageSignal;
}
