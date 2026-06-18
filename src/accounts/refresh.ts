import { scoreAccount, computeScore } from './scorer.js';
import { readTelemetryForAccount, readTelemetryWithMtimeForAccount } from '../statusline/store.js';
import type { AccountRegistry } from './registry.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { UsageLedger } from './usage-ledger.js';

export interface RefreshAccountsDeps {
  registry: AccountRegistry;
  statuslineDir: string;
  freshnessWindowS: number;
  softPct: number;
  hardPct: number;
  circuitBreaker?: CircuitBreaker;
  /** When provided, usage is read through the ledger: live telemetry is captured and idle windows
   *  decay to 0% once their reset passes — fixing stale-telemetry reads. Omit for legacy behavior. */
  ledger?: UsageLedger;
  /** Injectable clock (ms) for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Refresh every account's score and state from its freshest statusline telemetry (or the usage
 * ledger's decayed estimate) and from circuit-breaker state, before an automatic selection decision.
 *
 * Without this, scores stay permanently `null` and states stay `HEALTHY`, so the canonical selector
 * falls back to priority order and never honours scoring, telemetry-derived health, or cooldowns.
 */
export function refreshAccountScores(deps: RefreshAccountsDeps): void {
  const { registry, statuslineDir, freshnessWindowS, softPct, hardPct, circuitBreaker, ledger } = deps;
  const now = deps.nowMs ?? Date.now();

  for (const account of registry.getAll()) {
    let fivePct: number | null = null;
    let sevenPct: number | null = null;
    let resetEpoch = 0; // epoch seconds, for cooldown when at hard limit
    let score: number | null = null;

    if (ledger) {
      // Capture the freshest live telemetry (with its true timestamp) into the ledger…
      const meta = readTelemetryWithMtimeForAccount(account.configDir, statuslineDir, freshnessWindowS);
      const rl = meta?.telemetry.rate_limits;
      if (rl) {
        const cap: { five_hour?: { used_pct: number; reset_at: number }; seven_day?: { used_pct: number; reset_at: number } } = {};
        if (typeof rl.five_hour?.used_percentage === 'number' && typeof rl.five_hour?.resets_at === 'number') {
          cap.five_hour = { used_pct: rl.five_hour.used_percentage, reset_at: rl.five_hour.resets_at };
        }
        if (typeof rl.seven_day?.used_percentage === 'number' && typeof rl.seven_day?.resets_at === 'number') {
          cap.seven_day = { used_pct: rl.seven_day.used_percentage, reset_at: rl.seven_day.resets_at };
        }
        if (cap.five_hour || cap.seven_day) ledger.capture(account.name, cap, meta!.mtimeMs);
        resetEpoch = Math.max(rl.five_hour?.resets_at ?? 0, rl.seven_day?.resets_at ?? 0);
      }
      // …then use the decayed estimate (idle windows past their reset read 0%).
      const est = ledger.estimate(account.name, now);
      fivePct = est.five_hour.used_pct;
      sevenPct = est.seven_day.used_pct;
      score = typeof fivePct === 'number' && typeof sevenPct === 'number' ? computeScore(fivePct, sevenPct) : null;
    } else {
      // Legacy path (no ledger): score and read usage directly from freshest telemetry.
      score = scoreAccount(account.configDir, statuslineDir, freshnessWindowS);
      const telemetry = readTelemetryForAccount(account.configDir, statuslineDir, freshnessWindowS);
      const rl = telemetry?.rate_limits;
      const f = rl?.five_hour?.used_percentage;
      const s = rl?.seven_day?.used_percentage;
      if (typeof f === 'number' && typeof s === 'number') {
        fivePct = f;
        sevenPct = s;
        resetEpoch = Math.max(rl!.five_hour?.resets_at ?? 0, rl!.seven_day?.resets_at ?? 0);
      }
    }

    // Shared tail: apply score, telemetry-derived state, and circuit-breaker override.
    registry.setScore(account.name, score);
    if (typeof fivePct === 'number' && typeof sevenPct === 'number') {
      const cooldownUntil =
        (fivePct >= hardPct || sevenPct >= hardPct) && resetEpoch > 0 ? new Date(resetEpoch * 1000) : null;
      registry.applyTelemetry(account.name, fivePct, sevenPct, softPct, hardPct, cooldownUntil);
    }
    if (circuitBreaker && circuitBreaker.getState(account.name) === 'OPEN') {
      registry.setState(account.name, 'COOLDOWN', circuitBreaker.getCooldownEta(account.name));
    }
  }
}
