import type { RolesConfig } from '../config/schema.js';
import type { ProviderUsage } from './types.js';

/**
 * Per-provider availability readout for the operator (`aisup worker providers`). Unlike the selector,
 * this keeps UNAVAILABLE candidates (with their reason) so the operator can see WHY selection chose what
 * it did — claude account headroom + basis, codex remaining tokens vs budget.
 */

export interface ProviderUsageRow {
  label: string; // "claude:<account>" | adapter name
  provider: string;
  account: string | null;
  available: boolean;
  headroom_pct: number | null;
  remaining_tokens: number | null;
  basis: string;
  reason?: string;
}

export interface ProviderRoleUsage {
  role: string;
  candidates: ProviderUsageRow[];
}

export interface ProviderUsageReport {
  roles: ProviderRoleUsage[];
}

export interface ProviderUsageInputs {
  claudeUsage: ProviderUsage;
  codexUsage: ProviderUsage;
  accounts: readonly { name: string; enabled: boolean }[];
}

/** Enumerate every role candidate (claude expands to enabled accounts) with its current usage signal. */
export function buildProviderUsageReport(roles: RolesConfig, inputs: ProviderUsageInputs, nowMs: number): ProviderUsageReport {
  const roleLists: [string, RolesConfig['implementer']][] = [
    ['implementer', roles.implementer],
    ['reviewer', roles.reviewer],
  ];
  const out: ProviderRoleUsage[] = [];
  for (const [role, list] of roleLists) {
    const candidates: ProviderUsageRow[] = [];
    for (const rc of list) {
      if (rc.provider === 'claude') {
        for (const acct of inputs.accounts) {
          if (!acct.enabled) continue;
          const sig = inputs.claudeUsage.usageSignal({ provider: 'claude', account: acct.name, model: rc.model, effort: rc.effort }, nowMs);
          candidates.push({ label: `claude:${acct.name}`, provider: 'claude', account: acct.name, available: sig.available, headroom_pct: sig.headroom_pct, remaining_tokens: sig.remaining_tokens, basis: sig.basis, reason: sig.reason });
        }
      } else {
        const sig = inputs.codexUsage.usageSignal({ provider: rc.provider, model: rc.model, effort: rc.effort }, nowMs);
        candidates.push({ label: rc.provider, provider: rc.provider, account: null, available: sig.available, headroom_pct: sig.headroom_pct, remaining_tokens: sig.remaining_tokens, basis: sig.basis, reason: sig.reason });
      }
    }
    out.push({ role, candidates });
  }
  return { roles: out };
}
