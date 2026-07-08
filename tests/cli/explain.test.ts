import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { describeEvent, runExplain } from '../../src/cli/commands/explain.js';

describe('C4: aisup explain <event_type>', () => {
  it('describes a known event type in operator-facing terms', () => {
    expect(describeEvent('account.switch')).toMatch(/failover|switch|account/i);
    expect(describeEvent('cost.snapshot')).toMatch(/cost/i);
    expect(describeEvent('worker.all_candidates_exhausted')).toMatch(/candidate|exhaust|worker/i);
    expect(describeEvent('permission.granted')).toMatch(/permission|approv|grant/i);
  });

  it('falls back to a category description for a recognized-prefix but unmapped type', () => {
    // Any real EventType should get at least a category-level description, never empty.
    expect(describeEvent('migration.collision_renamed')).not.toBe('');
    expect(describeEvent('migration.collision_renamed')).toMatch(/migrat/i);
  });

  it('reports clearly when the event type is not recognized', () => {
    expect(describeEvent('totally.made_up')).toMatch(/not a recognized|unknown|no description/i);
  });

  describe('runExplain output', () => {
    let logs: string[];
    beforeEach(() => {
      logs = [];
      vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('prints the event type and its description', () => {
      runExplain('account.switch');
      const out = logs.join('\n');
      expect(out).toMatch(/account\.switch/);
      expect(out).toMatch(/failover|switch/i);
    });
  });
});
