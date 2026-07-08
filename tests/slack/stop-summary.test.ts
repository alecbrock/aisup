import { describe, it, expect } from 'vitest';
import { buildStopSummary, isOversizedForModal, MODAL_TEXT_LIMIT } from '../../src/slack/summary.js';
import type { JournalEvent } from '../../src/journal/types.js';

const EVENTS = [
  { ts: '2026-06-30T10:00:00Z', event_type: 'session.start', aisup_session_id: 's1', account: 'primary', details: {} },
  { ts: '2026-06-30T10:02:00Z', event_type: 'cost.snapshot', aisup_session_id: 's1', claude_session_id: 'c1', account: 'primary', details: { total_cost_usd: 1.5 } },
  { ts: '2026-06-30T10:05:00Z', event_type: 'account.switch', aisup_session_id: 's1', account: 'account2', details: { phase: 'snapshot' } },
  { ts: '2026-06-30T10:05:01Z', event_type: 'account.switch', aisup_session_id: 's1', account: 'account2', details: { phase: 'completed' } },
  { ts: '2026-06-30T10:20:00Z', event_type: 'session.stop', aisup_session_id: 's1', account: 'account2', details: {} },
  // A different session — must not leak into s1's summary.
  { ts: '2026-06-30T10:03:00Z', event_type: 'session.start', aisup_session_id: 's2', account: 'primary', details: {} },
] as JournalEvent[];

describe('D4: session-stop summary', () => {
  it('composes duration, account switches, cost, and key events for the session', () => {
    const s = buildStopSummary(EVENTS, 's1');
    expect(s).toMatch(/duration: 20m/);            // 10:00 → 10:20
    expect(s).toMatch(/account switches: 1/);      // counts the 'completed' phase only (not double)
    expect(s).toMatch(/cost: \$1\.50/);
    expect(s).toMatch(/key events:/);
    expect(s).toMatch(/session\.start/);
    expect(s).toMatch(/account\.switch/);
    expect(s).not.toMatch(/s2/);                   // other session excluded
  });

  it('falls back gracefully when the session has no events', () => {
    const s = buildStopSummary(EVENTS, 'unknown');
    expect(s).toMatch(/duration: unknown/);
    expect(s).toMatch(/account switches: 0/);
    expect(s).toMatch(/cost: \$0\.00/);
  });

  it('flags content over the modal limit as oversized (→ file upload)', () => {
    expect(isOversizedForModal('short diff')).toBe(false);
    expect(isOversizedForModal('x'.repeat(MODAL_TEXT_LIMIT + 1))).toBe(true);
  });
});
