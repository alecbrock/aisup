import { describe, it, expect } from 'vitest';
import { breakdownCosts } from '../../src/cost/aggregator.js';
import type { JournalEvent } from '../../src/journal/types.js';

// A fixture with two lead-session cost streams (Claude) + two worker completions (codex + claude).
const EVENTS: JournalEvent[] = [
  { ts: '2026-06-30T10:00:00Z', event_type: 'cost.snapshot', account: 'primary', aisup_session_id: 's1', claude_session_id: 'c1', details: { total_cost_usd: 2.0, active_skill: '/spec', provider: 'claude' } },
  { ts: '2026-06-30T10:05:00Z', event_type: 'cost.snapshot', account: 'primary', aisup_session_id: 's1', claude_session_id: 'c1', details: { total_cost_usd: 3.0, active_skill: '/spec', provider: 'claude' } }, // same segment → max 3.0
  { ts: '2026-06-30T11:00:00Z', event_type: 'cost.snapshot', account: 'account2', aisup_session_id: 's2', claude_session_id: 'c2', details: { total_cost_usd: 1.0, active_skill: '/fix', provider: 'claude' } },
  { ts: '2026-06-30T12:00:00Z', event_type: 'worker.completed', aisup_session_id: 's1', details: { provider: 'codex', task_type: 'implement', cost_usd: 0.5 } },
  { ts: '2026-06-30T12:30:00Z', event_type: 'worker.completed', aisup_session_id: 's1', details: { provider: 'claude', task_type: 'bugfix', cost_usd: 0.25 } },
] as JournalEvent[];

describe('C8: cost breakdowns', () => {
  it('groups by provider (Claude lead + worker vs codex worker)', () => {
    const by = breakdownCosts(EVENTS, 'provider');
    // Claude = lead 3.0 + lead 1.0 + claude worker 0.25 = 4.25; codex = 0.5
    expect(by.claude).toBeCloseTo(4.25);
    expect(by.codex).toBeCloseTo(0.5);
  });

  it('groups lead-session cost by active skill', () => {
    const by = breakdownCosts(EVENTS, 'skill');
    expect(by['/spec']).toBeCloseTo(3.0); // segment max, not 2+3
    expect(by['/fix']).toBeCloseTo(1.0);
  });

  it('groups worker cost by task type (lead cost under a lead bucket)', () => {
    const by = breakdownCosts(EVENTS, 'task');
    expect(by.implement).toBeCloseTo(0.5);
    expect(by.bugfix).toBeCloseTo(0.25);
    expect(by['(lead)']).toBeCloseTo(4.0); // 3.0 + 1.0 lead streams
  });

  it('groups lead cost by account', () => {
    const by = breakdownCosts(EVENTS, 'account');
    expect(by.primary).toBeCloseTo(3.0);
    expect(by.account2).toBeCloseTo(1.0);
  });
});
