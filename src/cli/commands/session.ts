import { join } from 'node:path';
import { aisupHome } from '../../config/paths.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { readEvents } from '../../journal/reader.js';
import type { JournalEvent } from '../../journal/types.js';
import { readOfflineSessionStates } from './status.js';

const TOKEN_PATH = join(aisupHome(), 'api-token');

/** Read one session's events — online from the daemon (same journal) or offline from the config path. */
async function readSessionEvents(id: string): Promise<JournalEvent[]> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (existsSync(pidPath)) {
    try {
      const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
      const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
      const url = new URL(`http://127.0.0.1:${port}/api/events`);
      url.searchParams.set('session', id);
      url.searchParams.set('limit', '1000');
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return (await res.json() as { events: JournalEvent[] }).events;
    } catch { /* fall through to offline */ }
  }
  const config = await loadConfig();
  if (!existsSync(config.journal.path)) return [];
  return readEvents(config.journal.path, { session: id, limit: 1000 });
}

function resolveSessionId(explicit?: string): string | null {
  if (explicit) return explicit;
  const sessions = readOfflineSessionStates();
  return sessions[0]?.aisup_session_id ?? null;
}

function oneLine(ev: JournalEvent): string {
  let ts = ev.ts;
  try { ts = new Date(ev.ts).toLocaleTimeString(); } catch { /* keep raw */ }
  const acct = ev.account ? ` [${ev.account}]` : '';
  const rationale = ev.details?.rationale as { reason_code?: string; chosen?: string } | undefined;
  const why = rationale ? ` — ${rationale.reason_code ?? '?'} → ${rationale.chosen ?? 'none'}` : '';
  return `  ${ts} ${ev.event_type}${acct}${why}`;
}

/** C11: `aisup session timeline [id]` — the ordered lifecycle of one session. */
export async function sessionTimeline(opts: { id?: string; json?: boolean }): Promise<void> {
  const id = resolveSessionId(opts.id);
  if (!id) { console.log('No session id given and no session found.'); return; }
  const events = (await readSessionEvents(id)).slice().sort((a, b) => a.ts.localeCompare(b.ts));
  if (opts.json) return void console.log(JSON.stringify({ session: id, timeline: events }, null, 2));
  console.log(`Timeline for session ${id}:`);
  if (events.length === 0) { console.log('  (no events)'); return; }
  for (const ev of events) console.log(oneLine(ev));
}

/** C11: `aisup session rename <id> <name>` — set the session's operator-facing label. */
export async function sessionRename(id: string, name: string): Promise<void> {
  const pidPath = join(aisupHome(), 'daemon.pid');
  if (!existsSync(pidPath)) { console.log('aisup daemon is not running.'); return; }
  try {
    const { port } = JSON.parse(await readFile(pidPath, 'utf8')) as { port: number };
    const token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/rename`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    console.log(res.ok ? `Session ${id} renamed to "${name}".` : `Rename failed: ${json.error ?? res.status}`);
  } catch (err) {
    console.log(`Rename failed: ${String(err)}`);
  }
}
