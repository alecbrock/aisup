import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { aisupHome } from '../../config/paths.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');

/** The unified snapshot behind `aisup health`/`watch`, Slack `!health`, and the dashboard. */
interface Overview {
  session: { status?: string; aisup_session_id?: string; account?: string } | null;
  recovery_guidance?: string | null;
  accounts: Array<{
    name: string; state?: string; score?: number | null; enabled?: boolean;
    five_hour_pct?: number | null; seven_day_pct?: number | null;
    model?: string | null; cooldown_until?: string | null;
  }>;
  workers: { total: number; queued: number; running: number; awaiting_approval: number } | null;
  cost_today: { total_cost_usd: number; by_account?: Record<string, number>; by_session?: Record<string, number> };
  recent_events: Array<{ ts: string; event_type: string; account?: string | null }>;
  daemon: { ok: boolean };
}

/** Fetch the composed overview from the running daemon, or null when it is unreachable. */
async function fetchOverview(): Promise<Overview | null> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  try {
    const { pid, port } = JSON.parse(await readFile(pidPath, 'utf8')) as { pid?: number; port: number };
    if (typeof pid === 'number' && !isPidAlive(pid)) return null;
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json() as Overview;
  } catch {
    return null;
  }
}

function formatAccount(a: Overview['accounts'][number]): string {
  const parts: string[] = [];
  if (typeof a.score === 'number') parts.push(`score ${a.score.toFixed(0)}%`);
  if (typeof a.five_hour_pct === 'number') parts.push(`5h ${a.five_hour_pct.toFixed(0)}%`);
  if (typeof a.seven_day_pct === 'number') parts.push(`7d ${a.seven_day_pct.toFixed(0)}%`);
  if (a.model) parts.push(`model ${a.model}`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  const disabled = a.enabled === false ? ' (disabled)' : '';
  return `    ${a.name}: ${a.state ?? 'unknown'}${disabled}${detail}`;
}

/** Render the unified snapshot as human-readable lines. */
function renderOverview(o: Overview): void {
  console.log('aisup daemon: running');

  if (!o.session) {
    console.log('  session: none');
  } else {
    console.log(`  session: ${o.session.aisup_session_id ?? 'unknown'} ${o.session.status ?? 'unknown'} on ${o.session.account ?? 'unknown'}`);
    if (o.recovery_guidance) console.log(`    guidance: ${o.recovery_guidance}`);
  }

  console.log('  accounts:');
  if (o.accounts.length === 0) {
    console.log('    (none)');
  } else {
    for (const a of o.accounts) console.log(formatAccount(a));
  }

  if (!o.workers) {
    console.log('  workers: disabled');
  } else {
    const w = o.workers;
    console.log(`  workers: ${w.total} total (${w.queued} queued, ${w.running} running, ${w.awaiting_approval} awaiting approval)`);
  }

  console.log(`  cost today: $${o.cost_today.total_cost_usd.toFixed(2)}`);

  console.log('  recent events:');
  if (o.recent_events.length === 0) {
    console.log('    (none)');
  } else {
    for (const ev of o.recent_events) {
      let ts = ev.ts;
      try { ts = new Date(ev.ts).toLocaleTimeString(); } catch { /* keep raw ts */ }
      const acct = ev.account ? ` [${ev.account}]` : '';
      console.log(`    ${ts}${acct} ${ev.event_type}`);
    }
  }
}

/** `aisup health` — print the unified snapshot once. */
export async function showHealth(opts: { json?: boolean } = {}): Promise<void> {
  const overview = await fetchOverview();
  if (overview === null) {
    if (opts.json) return void console.log(JSON.stringify({ daemon: { running: false } }, null, 2));
    console.log('aisup daemon: not running');
    return;
  }
  if (opts.json) return void console.log(JSON.stringify(overview, null, 2));
  renderOverview(overview);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `aisup watch` — clear + redraw the unified snapshot on an interval (default 3s). */
export async function runWatch(opts: { interval?: number; once?: boolean } = {}): Promise<void> {
  const intervalMs = Math.max(1, opts.interval ?? 3) * 1000;
  // `once` exists only so tests can exercise a single render without an infinite loop.
  do {
    const overview = await fetchOverview();
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen + home cursor
    if (overview === null) {
      console.log('aisup daemon: not running');
    } else {
      console.log(`aisup watch — refreshing every ${intervalMs / 1000}s (Ctrl-C to exit)`);
      renderOverview(overview);
    }
    if (opts.once) break;
    await sleep(intervalMs);
    // eslint-disable-next-line no-constant-condition
  } while (true);
}
