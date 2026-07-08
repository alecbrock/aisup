import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readEvents } from '../../journal/reader.js';
import { aggregateCosts, reduceCostSnapshots, breakdownCosts, type CostWindows, type CostBreakdown, type CostDimension } from '../../cost/aggregator.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');

export interface CostReport {
  account: string | null;
  since: string | null;
  today?: CostBreakdown;
  last_7d?: CostBreakdown;
  last_30d?: CostBreakdown;
  /** Single window when --since is supplied. */
  window?: CostBreakdown;
}

/**
 * Compute a cost report from a journal file. With `since`, returns a single window; otherwise the
 * rolling today/last_7d/last_30d windows. Reads the same configured journal the daemon writes.
 */
export async function computeCostReport(
  journalPath: string,
  opts: { account?: string; since?: string; now?: Date } = {}
): Promise<CostReport> {
  const account = opts.account ?? null;
  if (opts.since) {
    const events = (await readEvents(journalPath, { type: 'cost.snapshot', since: opts.since }))
      .filter((e) => !account || e.account === account);
    return { account, since: opts.since, window: reduceCostSnapshots(events) };
  }
  const windows = await aggregateCosts({ journalPath, now: opts.now, account: account ?? undefined });
  return { account, since: null, today: windows.today, last_7d: windows.last_7d, last_30d: windows.last_30d };
}

function formatBreakdown(label: string, b: CostBreakdown): string {
  const accts = Object.entries(b.by_account).map(([n, v]) => `${n} $${v.toFixed(2)}`).join(', ');
  return `  ${label}: $${b.total_cost_usd.toFixed(2)}${accts ? ` (${accts})` : ''}`;
}

function printReport(report: CostReport): void {
  if (report.window) {
    console.log(`Cost since ${report.since}${report.account ? ` [${report.account}]` : ''}:`);
    console.log(formatBreakdown('total', report.window));
    return;
  }
  console.log(`Cost${report.account ? ` [${report.account}]` : ''}:`);
  if (report.today) console.log(formatBreakdown('today', report.today));
  if (report.last_7d) console.log(formatBreakdown('last 7d', report.last_7d));
  if (report.last_30d) console.log(formatBreakdown('last 30d', report.last_30d));
}

async function fetchOnline(): Promise<CostWindows | null> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  try {
    const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/cost`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json() as CostWindows;
  } catch {
    return null;
  }
}

const DIMENSIONS = ['account', 'skill', 'provider', 'task'] as const;

/** C8: fetch a cost breakdown from the daemon, or null when offline. */
async function fetchBreakdownOnline(by: CostDimension): Promise<Record<string, number> | null> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  try {
    const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/cost?by=${by}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json() as { breakdown: Record<string, number> }).breakdown;
  } catch {
    return null;
  }
}

async function costBreakdown(by: CostDimension, json: boolean): Promise<void> {
  const online = await fetchBreakdownOnline(by);
  let breakdown = online;
  if (!breakdown) {
    const config = await loadConfig();
    breakdown = existsSync(config.journal.path)
      ? breakdownCosts(await readEvents(config.journal.path, {}), by)
      : {};
  }
  if (json) return void console.log(JSON.stringify({ by, breakdown }, null, 2));
  console.log(`Cost by ${by}:`);
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) console.log('  (no cost recorded)');
  for (const [k, v] of entries) console.log(`  ${k}: $${v.toFixed(2)}`);
}

export async function sessionCost(opts: { json?: boolean; since?: string; account?: string; by?: string }): Promise<void> {
  if (opts.by) {
    if (!(DIMENSIONS as readonly string[]).includes(opts.by)) {
      console.log(`Unknown --by dimension "${opts.by}". Use: ${DIMENSIONS.join(' | ')}`);
      return;
    }
    return costBreakdown(opts.by as CostDimension, opts.json ?? false);
  }
  // Online windows view (parity with the daemon) only when no client-side filter is requested;
  // --since/--account are applied offline against the same configured journal file.
  if (!opts.since && !opts.account) {
    const online = await fetchOnline();
    if (online) {
      const report: CostReport = { account: null, since: null, today: online.today, last_7d: online.last_7d, last_30d: online.last_30d };
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      return;
    }
  }

  const config = await loadConfig();
  const report = await computeCostReport(config.journal.path, { account: opts.account, since: opts.since });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
