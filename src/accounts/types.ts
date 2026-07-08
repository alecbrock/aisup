export type AccountState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'COOLDOWN';

export interface AccountInfo {
  name: string;
  configDir: string;
  priority: number;
  enabled: boolean;
  state: AccountState;
  score: number | null;
  cooldownUntil: Date | null;
  /** C7 runtime overrides (applied by AccountRegistry from account-overrides.json). */
  pinned?: boolean;   // force selection while runnable
  excluded?: boolean; // remove from selection (distinct from a config-disabled account)
}

/** A single account's runtime override (C7). Persisted to ~/.aisup/account-overrides.json. */
export interface AccountOverride {
  pinned?: boolean;
  excluded?: boolean;
  /** Runtime enable/disable that overrides config `enabled` (undefined = defer to config). */
  enabled?: boolean;
}
