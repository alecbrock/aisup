import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readTelemetryForAccount } from '../../statusline/store.js';

export async function showAccounts(): Promise<void> {
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
  const tokenPath = join(homedir(), '.aisup', 'api-token');

  if (!existsSync(pidPath) || !existsSync(tokenPath)) {
    await showAccountsOffline();
    return;
  }

  try {
    const raw = await readFile(pidPath, 'utf8');
    const { port } = JSON.parse(raw) as { port: number };
    const token = (await readFile(tokenPath, 'utf8')).trim();

    const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error('Failed to fetch accounts from daemon');
      return;
    }

    const body = await res.json() as {
      accounts: Array<{
        name: string; state: string; score: number | null; enabled?: boolean;
        five_hour_pct?: number | null; seven_day_pct?: number | null; model?: string | null; cooldown_until?: string | null;
        five_hour_basis?: string | null; seven_day_basis?: string | null;
      }>;
    };
    for (const acct of body.accounts) {
      const score = acct.score !== null ? `${acct.score.toFixed(0)}%` : 'no data';
      const fb = acct.five_hour_basis ? ` (${acct.five_hour_basis})` : '';
      const sb = acct.seven_day_basis ? ` (${acct.seven_day_basis})` : '';
      const usage = typeof acct.five_hour_pct === 'number' && typeof acct.seven_day_pct === 'number'
        ? `5h ${acct.five_hour_pct.toFixed(0)}%${fb}, 7d ${acct.seven_day_pct.toFixed(0)}%${sb}`
        : 'no data';
      const model = acct.model ?? '—';
      const cooldown = acct.cooldown_until ?? '—';
      const enabled = acct.enabled === false ? ' (disabled)' : '';
      console.log(`  ${acct.name}: ${acct.state}${enabled} (score: ${score}, ${usage}, model: ${model}, cooldown: ${cooldown})`);
    }
  } catch {
    await showAccountsOffline();
  }
}

async function showAccountsOffline(): Promise<void> {
  console.log('aisup daemon not running — reading config directly');
  try {
    const config = await loadConfig();
    for (const acct of config.accounts) {
      const telemetry = readTelemetryForAccount(acct.config_dir, config.statusline.directory, config.statusline.freshness_window_s);
      const model = telemetry?.model?.id ?? '—';
      const cooldown = telemetry?.rate_limits
        ? new Date(Math.max(
          telemetry.rate_limits.five_hour?.resets_at ?? 0,
          telemetry.rate_limits.seven_day?.resets_at ?? 0
        ) * 1000).toISOString()
        : '—';
      // Apply the same decay as the ledger: a window past its reset reads 0% (provably reset).
      const nowSec = Date.now() / 1000;
      const decay = (w?: { used_percentage?: number; resets_at?: number }): string | null => {
        if (typeof w?.used_percentage !== 'number') return null;
        if (typeof w.resets_at === 'number' && nowSec >= w.resets_at) return '0% (reset)';
        return `${w.used_percentage.toFixed(0)}% (stale)`;
      };
      const five = decay(telemetry?.rate_limits?.five_hour);
      const seven = decay(telemetry?.rate_limits?.seven_day);
      const usage = five !== null && seven !== null ? `5h ${five}, 7d ${seven}` : 'no data';
      console.log(`  ${acct.name}: ${acct.enabled ? 'enabled' : 'disabled'} (${usage}, model: ${model}, cooldown: ${cooldown})`);
    }
  } catch (err) {
    console.error(`Could not read config: ${String(err)}`);
  }
}
