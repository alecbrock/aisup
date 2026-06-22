import type { RoleCandidateConfig } from '../config/schema.js';
import type { ConcreteCandidate, ProviderUsage } from './types.js';

/** Minimal account view the selector iterates for Claude expansion. */
export interface SelectorAccountView {
  name: string;
  enabled: boolean;
}

export interface SelectorDeps {
  /** Per-account Claude usage (headroom/cooldown/reactive marks). */
  claudeUsage: ProviderUsage;
  /** Metered cross-LLM (codex) usage — used for any non-'claude' candidate. */
  codexUsage: ProviderUsage;
  /** Enabled-or-not accounts available for Claude expansion, in config/priority order. */
  accounts: readonly SelectorAccountView[];
}

/**
 * Pure: turn a role's ordered candidate list into a concrete ordered list of available run targets.
 *
 * A `claude` candidate expands to its enabled accounts, drops unavailable ones (cooldown / reactive
 * 429 / disabled), and orders them best-headroom-first (known headroom ahead of unknown). Cross-LLM
 * candidates (codex) keep config order and are dropped when over budget / reactively unavailable.
 * The account-first-then-LLM invariant is enforced structurally: **all** available Claude accounts
 * precede the first cross-LLM target regardless of where `claude` sits in the role list. Returns `[]`
 * when every candidate is unavailable — the caller (failover loop) treats that as all-exhausted.
 */
export function resolveCandidates(
  roleCandidates: readonly RoleCandidateConfig[],
  deps: SelectorDeps,
  nowMs: number
): ConcreteCandidate[] {
  const claudeCands: { cand: ConcreteCandidate; headroom: number }[] = [];
  const crossCands: ConcreteCandidate[] = [];

  for (const rc of roleCandidates) {
    if (rc.provider === 'claude') {
      for (const acct of deps.accounts) {
        if (!acct.enabled) continue;
        const cand: ConcreteCandidate = { provider: 'claude', account: acct.name, model: rc.model, effort: rc.effort };
        const sig = deps.claudeUsage.usageSignal(cand, nowMs);
        if (!sig.available) continue;
        // Unknown headroom (never-seen account) sinks below any known headroom, but still selectable.
        claudeCands.push({ cand, headroom: sig.headroom_pct ?? -1 });
      }
    } else {
      const cand: ConcreteCandidate = { provider: rc.provider, model: rc.model, effort: rc.effort };
      if (deps.codexUsage.usageSignal(cand, nowMs).available) crossCands.push(cand);
    }
  }

  claudeCands.sort((a, b) => b.headroom - a.headroom); // best-headroom-first (stable for ties → config order)
  return [...claudeCands.map((c) => c.cand), ...crossCands];
}
