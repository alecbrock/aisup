import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readEvents } from '../../journal/reader.js';
import { aggregateCosts, reduceCostSnapshots, type CostWindows, type CostBreakdown } from '../../cost/aggregator.js';

const TOKEN_PATH = join(homedir(), '.aisup', 'api-token');

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
  const pidPath = join(homedir(), '.aisup', 'daemon.pid');
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

export async function sessionCost(opts: { json?: boolean; since?: string; account?: string }): Promise<void> {
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
