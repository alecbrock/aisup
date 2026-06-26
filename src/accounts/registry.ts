import type { AisupConfig } from '../config/schema.js';
import type { AccountInfo, AccountState } from './types.js';

export class AccountRegistry {
  private accounts: Map<string, AccountInfo>;

  constructor(config: AisupConfig) {
    this.accounts = new Map(
      config.accounts
        .map((a) => [
          a.name,
          {
            name: a.name,
            configDir: a.config_dir,
            priority: a.priority,
            enabled: a.enabled,
            state: 'HEALTHY' as AccountState,
            score: null,
            cooldownUntil: null,
          },
        ])
    );
  }

  getAll(): AccountInfo[] {
    return Array.from(this.accounts.values());
  }

  get(name: string): AccountInfo | undefined {
    return this.accounts.get(name);
  }

  setState(name: string, state: AccountState, cooldownUntil: Date | null = null): void {
    const acct = this.accounts.get(name);
    if (!acct) return;
    acct.state = state;
    acct.cooldownUntil = cooldownUntil;
  }

  setScore(name: string, score: number | null): void {
    const acct = this.accounts.get(name);
    if (!acct) return;
    acct.score = score;
  }

  /** Transition based on usage percentages from fresh telemetry. */
  applyTelemetry(
    name: string,
    fiveHourPct: number,
    sevenDayPct: number,
    softPct: number,
    hardPct: number,
    cooldownUntil: Date | null
  ): void {
    const acct = this.accounts.get(name);
    if (!acct) return;

    if (fiveHourPct >= hardPct || sevenDayPct >= hardPct) {
      acct.state = 'UNAVAILABLE';
      acct.cooldownUntil = cooldownUntil;
    } else if (fiveHourPct >= softPct || sevenDayPct >= softPct) {
      acct.state = 'DEGRADED';
      acct.cooldownUntil = null; // recovered to a runnable state → drop the stale cooldown (AF-314)
    } else {
      acct.state = 'HEALTHY';
      acct.cooldownUntil = null; // recovered to a runnable state → drop the stale cooldown (AF-314)
    }
  }
}
