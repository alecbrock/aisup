import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function showLog(opts: { limit?: number }): Promise<void> {
  const limit = opts.limit ?? 20;
  const journalPath = join(homedir(), '.aisup', 'journal.jsonl');

  if (!existsSync(journalPath)) {
    console.log('No journal file found. Has the daemon run yet?');
    return;
  }

  const content = await readFile(journalPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const recent = lines.slice(-limit);

  for (const line of recent) {
    try {
      const ev = JSON.parse(line) as { ts: string; event_type: string; account?: string; details?: unknown };
      const ts = new Date(ev.ts).toLocaleTimeString();
      const acct = ev.account ? ` [${ev.account}]` : '';
      console.log(`${ts}${acct} ${ev.event_type}`);
    } catch {
      // skip malformed lines
    }
  }
}
