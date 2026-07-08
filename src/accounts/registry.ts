import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AisupConfig } from '../config/schema.js';
import { aisupHome } from '../config/paths.js';
import type { AccountInfo, AccountState, AccountOverride } from './types.js';

export class AccountRegistry {
  private accounts: Map<string, AccountInfo>;
  private overrides: Map<string, AccountOverride>;
  private readonly overridesPath: string;
  private readonly configEnabled: Map<string, boolean>;

  constructor(config: AisupConfig, overridesPath?: string) {
    this.configEnabled = new Map(config.accounts.map((a) => [a.name, a.enabled]));
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
    this.overridesPath = overridesPath ?? join(aisupHome(), 'account-overrides.json');
    this.overrides = this.loadOverrides();
    this.applyOverrides();
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

  /**
   * C13: hot-apply a reloaded config's account enabled-flags to existing accounts (runtime overrides
   * still win). New/removed accounts are NOT added/dropped live — that needs a restart — so this
   * updates the config baseline for accounts already known to the registry.
   */
  syncConfigEnabled(accounts: Array<{ name: string; enabled: boolean }>): void {
    for (const a of accounts) {
      if (this.configEnabled.has(a.name)) this.configEnabled.set(a.name, a.enabled);
    }
    this.applyOverrides();
  }

  // ── C7 runtime overrides ──────────────────────────────────────────────────

  /** Merge a runtime override for one account, persist, and re-apply. `pinned` is exclusive. */
  setOverride(name: string, override: AccountOverride): void {
    if (!this.accounts.has(name)) return;
    if (override.pinned) {
      // Only one account may be pinned; clear any existing pin.
      for (const [n, o] of this.overrides) if (o.pinned) this.overrides.set(n, { ...o, pinned: false });
    }
    const merged = { ...(this.overrides.get(name) ?? {}), ...override };
    this.overrides.set(name, merged);
    this.persistOverrides();
    this.applyOverrides();
  }

  /** Drop all runtime overrides (back to config), persist, and re-apply. */
  clearOverrides(): void {
    this.overrides.clear();
    this.persistOverrides();
    this.applyOverrides();
  }

  private applyOverrides(): void {
    for (const acct of this.accounts.values()) {
      const o = this.overrides.get(acct.name);
      acct.pinned = o?.pinned ?? false;
      acct.excluded = o?.excluded ?? false;
      acct.enabled = o?.enabled ?? this.configEnabled.get(acct.name) ?? acct.enabled;
    }
  }

  private loadOverrides(): Map<string, AccountOverride> {
    if (!existsSync(this.overridesPath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.overridesPath, 'utf8')) as Record<string, AccountOverride>;
      return new Map(Object.entries(raw));
    } catch {
      return new Map(); // corrupt overrides never block startup
    }
  }

  private persistOverrides(): void {
    const obj: Record<string, AccountOverride> = {};
    for (const [name, o] of this.overrides) obj[name] = o;
    mkdirSync(dirname(this.overridesPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.overridesPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }
}
