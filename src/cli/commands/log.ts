import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readEvents } from '../../journal/reader.js';
import type { JournalEvent } from '../../journal/types.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');

interface SwitchRationale {
  reason_code?: string | null;
  chosen?: string | null;
  candidates?: Array<{ name: string; score: number | null; excluded_reason: string | null }>;
}

/** Render the failover rationale (C2) of an account.switch event as indented lines. */
function printRationale(details: Record<string, unknown> | undefined): void {
  const rationale = details?.rationale as SwitchRationale | null | undefined;
  if (!rationale || !Array.isArray(rationale.candidates)) return;
  console.log(`    why: ${rationale.reason_code ?? 'unknown'} → chose ${rationale.chosen ?? 'none'}`);
  for (const c of rationale.candidates) {
    const score = typeof c.score === 'number' ? `${c.score.toFixed(0)}%` : 'no data';
    const status = c.name === rationale.chosen ? 'chosen' : (c.excluded_reason ?? 'eligible');
    console.log(`      - ${c.name}: ${score} (${status})`);
  }
}

function printEvents(events: Array<Pick<JournalEvent, 'ts' | 'event_type' | 'account' | 'details'>>, details = false): void {
  for (const ev of events) {
    try {
      const ts = new Date(ev.ts).toLocaleTimeString();
      const acct = ev.account ? ` [${ev.account}]` : '';
      console.log(`${ts}${acct} ${ev.event_type}`);
      if (details) {
        const d = ev.details as Record<string, unknown> | undefined;
        if (d && d.rationale) printRationale(d);
        else if (d && Object.keys(d).length > 0) console.log(`    ${JSON.stringify(d)}`);
      }
    } catch {
      // skip malformed entries
    }
  }
}

interface LogFilters { type?: string; since?: string; account?: string; session?: string }

async function fetchOnline(limit: number, filters: LogFilters): Promise<JournalEvent[] | null> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  try {
    const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const url = new URL(`http://127.0.0.1:${port}/api/events`);
    url.searchParams.set('limit', String(limit));
    if (filters.type) url.searchParams.set('type', filters.type);
    if (filters.since) url.searchParams.set('since', filters.since);
    if (filters.account) url.searchParams.set('account', filters.account);
    if (filters.session) url.searchParams.set('session', filters.session);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json() as { events: JournalEvent[] };
    return body.events;
  } catch {
    return null;
  }
}

export async function showLog(opts: {
  limit?: number; type?: string; since?: string; account?: string; session?: string;
  details?: boolean; json?: boolean;
}): Promise<void> {
  const limit = opts.limit ?? 20;
  const filters: LogFilters = { type: opts.type, since: opts.since, account: opts.account, session: opts.session };

  // Online: read events from the running daemon so the same source is used as the API.
  const online = await fetchOnline(limit, filters);
  if (online !== null) {
    if (opts.json) return void console.log(JSON.stringify({ events: online }, null, 2));
    printEvents(online, opts.details);
    return;
  }

  // Offline: read the configured journal path (not a hardcoded ~/.aisup/journal.jsonl).
  const config = await loadConfig();
  if (!existsSync(config.journal.path)) {
    if (opts.json) return void console.log(JSON.stringify({ events: [] }, null, 2));
    console.log('No journal file found. Has the daemon run yet?');
    return;
  }
  const events = await readEvents(config.journal.path, {
    limit, type: opts.type, since: opts.since, account: opts.account, session: opts.session,
  });
  if (opts.json) return void console.log(JSON.stringify({ events }, null, 2));
  printEvents(events, opts.details);
}
