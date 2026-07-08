import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { JournalEvent, ReadEventsOptions } from './types.js';

export async function readEvents(
  journalPath: string,
  opts: ReadEventsOptions
): Promise<JournalEvent[]> {
  if (!existsSync(journalPath)) return [];

  const content = await readFile(journalPath, 'utf8');
  const rawLines = content.split('\n');

  const events: JournalEvent[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JournalEvent;
      events.push(parsed);
    } catch {
      // skip malformed or partial lines
    }
  }

  let filtered = events;

  if (opts.since) {
    const since = opts.since;
    filtered = filtered.filter((e) => e.ts >= since);
  }

  if (opts.type) {
    const type = opts.type;
    filtered = filtered.filter((e) => e.event_type === type);
  }

  if (opts.account) {
    const account = opts.account;
    filtered = filtered.filter((e) => e.account === account);
  }

  if (opts.session) {
    const session = opts.session;
    filtered = filtered.filter((e) => e.aisup_session_id === session);
  }

  if (opts.limit !== undefined && opts.limit > 0) {
    filtered = filtered.slice(-opts.limit);
  }

  return filtered;
}
