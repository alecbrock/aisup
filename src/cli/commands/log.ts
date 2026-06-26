import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readEvents } from '../../journal/reader.js';
import type { JournalEvent } from '../../journal/types.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');

function printEvents(events: Array<Pick<JournalEvent, 'ts' | 'event_type' | 'account'>>): void {
  for (const ev of events) {
    try {
      const ts = new Date(ev.ts).toLocaleTimeString();
      const acct = ev.account ? ` [${ev.account}]` : '';
      console.log(`${ts}${acct} ${ev.event_type}`);
    } catch {
      // skip malformed entries
    }
  }
}

async function fetchOnline(limit: number, type?: string): Promise<JournalEvent[] | null> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  try {
    const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const url = new URL(`http://127.0.0.1:${port}/api/events`);
    url.searchParams.set('limit', String(limit));
    if (type) url.searchParams.set('type', type);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json() as { events: JournalEvent[] };
    return body.events;
  } catch {
    return null;
  }
}

export async function showLog(opts: { limit?: number; type?: string }): Promise<void> {
  const limit = opts.limit ?? 20;

  // Online: read events from the running daemon so the same source is used as the API.
  const online = await fetchOnline(limit, opts.type);
  if (online !== null) {
    printEvents(online);
    return;
  }

  // Offline: read the configured journal path (not a hardcoded ~/.aisup/journal.jsonl).
  const config = await loadConfig();
  if (!existsSync(config.journal.path)) {
    console.log('No journal file found. Has the daemon run yet?');
    return;
  }
  const events = await readEvents(config.journal.path, { limit, type: opts.type });
  printEvents(events);
}
