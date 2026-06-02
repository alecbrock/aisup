import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateCosts, reduceCostSnapshots } from '../../src/cost/aggregator.js';
import type { JournalEvent } from '../../src/journal/types.js';

function costEvent(o: { ts: string; aisup: string; claude: string | null; account: string; cost: number }): JournalEvent {
  return {
    ts: o.ts,
    event_type: 'cost.snapshot',
    aisup_session_id: o.aisup,
    claude_session_id: o.claude ?? undefined,
    account: o.account,
    details: { total_cost_usd: o.cost, trigger: 'periodic' },
  };
}

describe('cost aggregator', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-cost-'));
    journalPath = join(tmpDir, 'journal.jsonl');
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  const writeJournal = (events: JournalEvent[]): void => {
    writeFileSync(journalPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('returns zeroed windows for an empty / missing journal', async () => {
    const result = await aggregateCosts({ journalPath });
    expect(result.today).toEqual({ total_cost_usd: 0, by_account: {}, by_session: {} });
    expect(result.last_7d.total_cost_usd).toBe(0);
    expect(result.last_30d.total_cost_usd).toBe(0);
  });

  it('reduces a single segment to its max snapshot, not the running sum', () => {
    const ts = '2026-06-01T12:00:00.000Z';
    const breakdown = reduceCostSnapshots([
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 1.0 }),
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 2.5 }),
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 4.0 }),
    ]);
    expect(breakdown.total_cost_usd).toBe(4.0);
    expect(breakdown.by_session).toEqual({ S1: 4.0 });
    expect(breakdown.by_account).toEqual({ primary: 4.0 });
  });

  it('does not let a cost reset across an account switch inflate the total', () => {
    const ts = '2026-06-01T12:00:00.000Z';
    const breakdown = reduceCostSnapshots([
      // segment c1 on primary: $2 → $5 (max 5)
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 2.0 }),
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 5.0 }),
      // switch → segment c2 on account2: $1 → $3 (max 3), cost reset to ~0 in between
      costEvent({ ts, aisup: 'S1', claude: 'c2', account: 'account2', cost: 1.0 }),
      costEvent({ ts, aisup: 'S1', claude: 'c2', account: 'account2', cost: 3.0 }),
    ]);
    // segment-aware: 5 + 3 = 8 (a raw running sum would be 2+5+1+3 = 11)
    expect(breakdown.total_cost_usd).toBe(8.0);
    expect(breakdown.by_account).toEqual({ primary: 5.0, account2: 3.0 });
    expect(breakdown.by_session).toEqual({ S1: 8.0 });
  });

  it('sums per-segment maxima for multiple Claude segments under one aisup session', () => {
    const ts = '2026-06-01T12:00:00.000Z';
    const breakdown = reduceCostSnapshots([
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 3.0 }),
      costEvent({ ts, aisup: 'S1', claude: 'c1', account: 'primary', cost: 1.0 }), // out-of-order lower
      costEvent({ ts, aisup: 'S1', claude: 'c2', account: 'primary', cost: 4.0 }),
      costEvent({ ts, aisup: 'S2', claude: 'c3', account: 'primary', cost: 2.0 }),
    ]);
    expect(breakdown.by_session).toEqual({ S1: 7.0, S2: 2.0 }); // (3 + 4), 2
    expect(breakdown.total_cost_usd).toBe(9.0);
  });

  it('filters by rolling today / last_7d / last_30d windows', async () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const iso = (msAgo: number): string => new Date(now.getTime() - msAgo).toISOString();
    const DAY = 86400_000;
    writeJournal([
      costEvent({ ts: iso(0), aisup: 'today', claude: 'ct', account: 'primary', cost: 1.0 }),
      costEvent({ ts: iso(3 * DAY), aisup: 'wk', claude: 'cw', account: 'primary', cost: 2.0 }),
      costEvent({ ts: iso(10 * DAY), aisup: 'mo', claude: 'cm', account: 'primary', cost: 4.0 }),
      costEvent({ ts: iso(40 * DAY), aisup: 'old', claude: 'co', account: 'primary', cost: 8.0 }),
    ]);

    const result = await aggregateCosts({ journalPath, now });

    expect(result.today.total_cost_usd).toBe(1.0);          // only the today event
    expect(result.last_7d.total_cost_usd).toBe(3.0);        // today + 3d
    expect(result.last_30d.total_cost_usd).toBe(7.0);       // today + 3d + 10d (not 40d)
  });
});
