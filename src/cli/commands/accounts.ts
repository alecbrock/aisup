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
      }>;
    };
    for (const acct of body.accounts) {
      const score = acct.score !== null ? `${acct.score.toFixed(0)}%` : 'no data';
      const usage = typeof acct.five_hour_pct === 'number' && typeof acct.seven_day_pct === 'number'
        ? `5h ${acct.five_hour_pct.toFixed(0)}%, 7d ${acct.seven_day_pct.toFixed(0)}%`
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
      const five = telemetry?.rate_limits?.five_hour?.used_percentage;
      const seven = telemetry?.rate_limits?.seven_day?.used_percentage;
      const model = telemetry?.model?.id ?? '—';
      const cooldown = telemetry?.rate_limits
        ? new Date(Math.max(
          telemetry.rate_limits.five_hour?.resets_at ?? 0,
          telemetry.rate_limits.seven_day?.resets_at ?? 0
        ) * 1000).toISOString()
        : '—';
      const usage = typeof five === 'number' && typeof seven === 'number'
        ? `5h ${five.toFixed(0)}%, 7d ${seven.toFixed(0)}%`
        : 'no data';
      console.log(`  ${acct.name}: ${acct.enabled ? 'enabled' : 'disabled'} (${usage}, model: ${model}, cooldown: ${cooldown})`);
    }
  } catch (err) {
    console.error(`Could not read config: ${String(err)}`);
  }
}
