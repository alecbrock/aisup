import { computeScore } from '../accounts/scorer.js';
import type { UsageLedger } from '../accounts/usage-ledger.js';
import type { ConcreteCandidate, ProviderUsage, UsageBasis, UsageSignal } from './types.js';

/** Minimal read view of an account's selectability — supplied by the daemon (from AccountRegistry + Task 7 marks). */
export interface AccountStateView {
  name: string;
  enabled: boolean;
  /** Circuit-breaker cooldown is active. */
  inCooldown: boolean;
  /** A reactive 429/quota/auth failure marked this account unavailable until its window resets (Task 7). */
  reactivelyUnavailable: boolean;
}

export interface ClaudeUsageDeps {
  ledger: UsageLedger;
  getAccount(name: string): AccountStateView | null;
}

function unavailable(basis: UsageBasis, reason: string): UsageSignal {
  return { available: false, headroom_pct: null, remaining_tokens: null, basis, reason };
}

/**
 * Claude provider usage: per-account headroom from the decayed usage ledger, gated by circuit-breaker
 * cooldown and reactive-unavailable marks.
 *
 * An account with no usable ledger telemetry is treated as **optimistically available with unknown
 * headroom** (not unavailable): a never-seen account must still be an account-first candidate so cold
 * starts don't collapse straight to a cross-LLM. The selector orders known-headroom accounts ahead of
 * unknown ones. Only an explicit cooldown or reactive 429/quota/auth mark makes an account unavailable.
 */
export class ClaudeProviderUsage implements ProviderUsage {
  constructor(private readonly deps: ClaudeUsageDeps) {}

  usageSignal(candidate: ConcreteCandidate, nowMs: number): UsageSignal {
    const name = candidate.account;
    if (!name) return unavailable('unknown', 'missing_account');
    const acct = this.deps.getAccount(name);
    if (!acct || !acct.enabled) return unavailable('unknown', 'unknown_or_disabled_account');
    if (acct.inCooldown) return unavailable('unknown', 'cooldown');
    if (acct.reactivelyUnavailable) return unavailable('unknown', 'reactive_unavailable');

    const est = this.deps.ledger.estimate(name, nowMs);
    const five = est.five_hour.used_pct;
    const seven = est.seven_day.used_pct;
    if (five === null || seven === null) {
      return { available: true, headroom_pct: null, remaining_tokens: null, basis: 'unknown' };
    }
    return {
      available: true,
      headroom_pct: computeScore(five, seven),
      remaining_tokens: null,
      basis: est.five_hour.basis,
    };
  }
}
