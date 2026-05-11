import { existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { AccountInfo } from '../../accounts/types.js';

export interface HealthCheckResult {
  account: string;
  configDirExists: boolean;
  configDirWritable: boolean;
  claudeJsonReadable: boolean;
  statuslineDirReadable: boolean;
}

export function checkAccountHealth(account: AccountInfo, statuslineDir?: string): HealthCheckResult {
  const configDirExists = existsSync(account.configDir);
  let configDirWritable = false;
  let claudeJsonReadable = false;
  if (configDirExists) {
    try {
      accessSync(account.configDir, constants.W_OK);
      configDirWritable = true;
    } catch { /* not writable */ }
    try {
      accessSync(join(account.configDir, '.claude.json'), constants.R_OK);
      claudeJsonReadable = true;
    } catch { /* missing or unreadable */ }
  }
  let statuslineDirReadable = false;
  if (statuslineDir) {
    try {
      accessSync(statuslineDir, constants.R_OK);
      statuslineDirReadable = true;
    } catch { /* missing or unreadable */ }
  } else {
    statuslineDirReadable = true;
  }
  return { account: account.name, configDirExists, configDirWritable, claudeJsonReadable, statuslineDirReadable };
}

export class HealthChecker {
  private intervalMs: number;
  private onResult: (result: HealthCheckResult) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { intervalMs: number; onResult: (r: HealthCheckResult) => void }) {
    this.intervalMs = opts.intervalMs;
    this.onResult = opts.onResult;
  }

  start(tickFn?: () => void): void {
    if (this.handle) return;
    this.handle = setInterval(() => { if (tickFn) tickFn(); }, this.intervalMs);
  }

  stop(): void {
    if (this.handle) { clearInterval(this.handle); this.handle = null; }
  }
}
