export type AccountState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'COOLDOWN';

export interface AccountInfo {
  name: string;
  configDir: string;
  priority: number;
  enabled: boolean;
  state: AccountState;
  score: number | null;
  cooldownUntil: Date | null;
}
