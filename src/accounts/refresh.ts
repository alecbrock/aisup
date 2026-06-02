import { scoreAccount } from './scorer.js';
import { readTelemetryForAccount } from '../statusline/store.js';
import type { AccountRegistry } from './registry.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export interface RefreshAccountsDeps {
  registry: AccountRegistry;
  statuslineDir: string;
  freshnessWindowS: number;
  softPct: number;
  hardPct: number;
  circuitBreaker?: CircuitBreaker;
}

/**
 * Refresh every account's score and state from its freshest statusline telemetry
 * and from circuit-breaker state, before an automatic selection decision is made.
 *
 * Without this, scores stay permanently `null` and states stay `HEALTHY`, so the
 * canonical selector falls back to priority order and never honours scoring,
 * telemetry-derived health, or circuit-breaker cooldowns.
 */
export function refreshAccountScores(deps: RefreshAccountsDeps): void {
  const { registry, statuslineDir, freshnessWindowS, softPct, hardPct, circuitBreaker } = deps;

  for (const account of registry.getAll()) {
    // (a) Score from freshest telemetry (null when no valid fresh telemetry exists).
    const score = scoreAccount(account.configDir, statuslineDir, freshnessWindowS);
    registry.setScore(account.name, score);

    // (b) Refresh HEALTHY/DEGRADED/UNAVAILABLE from telemetry usage percentages.
    const telemetry = readTelemetryForAccount(account.configDir, statuslineDir, freshnessWindowS);
    const rl = telemetry?.rate_limits;
    const fivePct = rl?.five_hour?.used_percentage;
    const sevenPct = rl?.seven_day?.used_percentage;
    if (typeof fivePct === 'number' && typeof sevenPct === 'number') {
      let cooldownUntil: Date | null = null;
      if (fivePct >= hardPct || sevenPct >= hardPct) {
        const resetEpoch = Math.max(rl!.five_hour?.resets_at ?? 0, rl!.seven_day?.resets_at ?? 0);
        cooldownUntil = resetEpoch > 0 ? new Date(resetEpoch * 1000) : null;
      }
      registry.applyTelemetry(account.name, fivePct, sevenPct, softPct, hardPct, cooldownUntil);
    }

    // (c) Circuit-breaker override: an OPEN breaker means the account is cooling down.
    if (circuitBreaker && circuitBreaker.getState(account.name) === 'OPEN') {
      registry.setState(account.name, 'COOLDOWN', circuitBreaker.getCooldownEta(account.name));
    }
  }
}
