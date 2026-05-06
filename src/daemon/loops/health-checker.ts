import { existsSync, accessSync, constants } from 'node:fs';
import type { AccountInfo } from '../../accounts/types.js';

export interface HealthCheckResult {
  account: string;
  configDirExists: boolean;
  configDirWritable: boolean;
}

export function checkAccountHealth(account: AccountInfo): HealthCheckResult {
  const configDirExists = existsSync(account.configDir);
  let configDirWritable = false;
  if (configDirExists) {
    try {
      accessSync(account.configDir, constants.W_OK);
      configDirWritable = true;
    } catch { /* not writable */ }
  }
  return { account: account.name, configDirExists, configDirWritable };
}

export class HealthChecker {
  private intervalMs: number;
  private onResult: (result: HealthCheckResult) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { intervalMs: number; onResult: (r: HealthCheckResult) => void }) {
    this.intervalMs = opts.intervalMs;
    this.onResult = opts.onResult;
  }

  start(): void {
    if (this.handle) return;
    this.handle = setInterval(() => { /* tick wired by daemon */ }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) { clearInterval(this.handle); this.handle = null; }
  }
}
