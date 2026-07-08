import { readTelemetryForAccount } from '../statusline/store.js';
import type { AccountRegistry } from './registry.js';
import type { UsageLedger } from './usage-ledger.js';

/** A single account's read-only view — the shared shape behind `GET /api/accounts`, `aisup accounts`,
 *  and the Slack `!accounts` card, so all three report identical numbers. */
export interface AccountView {
  name: string;
  state: string;
  priority: number;
  enabled: boolean;
  score: number | null;
  cooldown_until: string | null;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_basis: string | null;
  seven_day_basis: string | null;
  model: string | null;
}

export interface BuildAccountsViewDeps {
  accountRegistry: AccountRegistry;
  usageLedger?: UsageLedger;
  statuslineDir?: string;
  freshnessWindowS?: number;
  nowMs: number;
}

/**
 * Build the per-account read-only view. Model comes from statusline telemetry; usage % comes from
 * the usage ledger's decayed estimate when available, falling back to telemetry. Extracted from the
 * `/api/accounts` handler so the HTTP API and the Slack `!accounts` card are a single source of truth.
 */
export function buildAccountsView(deps: BuildAccountsViewDeps): AccountView[] {
  const freshness = deps.freshnessWindowS ?? 300;
  return deps.accountRegistry.getAll().map((a) => {
    const telemetry = deps.statuslineDir ? readTelemetryForAccount(a.configDir, deps.statuslineDir, freshness) : null;
    const est = deps.usageLedger?.estimate(a.name, deps.nowMs);
    const five = est ? est.five_hour.used_pct : (telemetry?.rate_limits?.five_hour?.used_percentage ?? null);
    const seven = est ? est.seven_day.used_pct : (telemetry?.rate_limits?.seven_day?.used_percentage ?? null);
    return {
      name: a.name,
      state: a.state,
      priority: a.priority,
      enabled: a.enabled,
      score: a.score,
      cooldown_until: a.cooldownUntil ? a.cooldownUntil.toISOString() : null,
      five_hour_pct: typeof five === 'number' ? five : null,
      seven_day_pct: typeof seven === 'number' ? seven : null,
      five_hour_basis: est?.five_hour.basis ?? null,
      seven_day_basis: est?.seven_day.basis ?? null,
      model: telemetry?.model?.id ?? null,
    };
  });
}
