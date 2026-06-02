import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeCostReport } from '../../src/cli/commands/cost.js';
import type { JournalEvent } from '../../src/journal/types.js';

function costEvent(o: { ts: string; aisup: string; claude: string; account: string; cost: number }): JournalEvent {
  return {
    ts: o.ts,
    event_type: 'cost.snapshot',
    aisup_session_id: o.aisup,
    claude_session_id: o.claude,
    account: o.account,
    details: { total_cost_usd: o.cost, trigger: 'periodic' },
  };
}

describe('aisup cost (computeCostReport)', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-cost-cli-'));
    journalPath = join(tmpDir, 'journal.jsonl');
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const writeJournal = (events: JournalEvent[]): void => {
    writeFileSync(journalPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('aggregates rolling windows from a non-default configured journal path', async () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const ts = now.toISOString();
    writeJournal([
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 3.0 }),
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 5.0 }),
    ]);

    const report = await computeCostReport(journalPath, { now });

    expect(report.since).toBeNull();
    expect(report.today?.total_cost_usd).toBe(5.0);
    expect(report.last_7d?.total_cost_usd).toBe(5.0);
    expect(report.last_30d?.total_cost_usd).toBe(5.0);
  });

  it('filters by account', async () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const ts = now.toISOString();
    writeJournal([
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 5.0 }),
      costEvent({ ts, aisup: 'S2', claude: 'c2', account: 'account2', cost: 3.0 }),
    ]);

    const report = await computeCostReport(journalPath, { now, account: 'primary' });

    expect(report.account).toBe('primary');
    expect(report.today?.total_cost_usd).toBe(5.0);
    expect(report.today?.by_account).toEqual({ primary: 5.0 });
  });

  it('aggregates a single window since a given date', async () => {
    const base = new Date('2026-06-15T12:00:00.000Z');
    const DAY = 86400_000;
    writeJournal([
      costEvent({ ts: new Date(base.getTime() - 5 * DAY).toISOString(), aisup: 'S1', claude: 'c1', account: 'primary', cost: 9.0 }),
      costEvent({ ts: new Date(base.getTime() - 1 * DAY).toISOString(), aisup: 'S2', claude: 'c2', account: 'primary', cost: 4.0 }),
    ]);
    const since = new Date(base.getTime() - 2 * DAY).toISOString();

    const report = await computeCostReport(journalPath, { since });

    expect(report.since).toBe(since);
    expect(report.window?.total_cost_usd).toBe(4.0); // the 5-day-old event is excluded
  });

  it('returns a JSON-serializable report', async () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    writeJournal([costEvent({ ts: now.toISOString(), aisup: 'S1', claude: 'c1', account: 'primary', cost: 1.5 })]);

    const report = await computeCostReport(journalPath, { now });
    const roundTripped = JSON.parse(JSON.stringify(report)) as { last_30d: { total_cost_usd: number } };

    expect(roundTripped.last_30d.total_cost_usd).toBe(1.5);
  });
});
