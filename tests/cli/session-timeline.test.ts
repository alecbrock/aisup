import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-timeline-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { sessionTimeline } from '../../src/cli/commands/session.js';

const JOURNAL = join(home, 'journal.jsonl');

// Deliberately out-of-order in the file; timeline must sort by ts. Mixed sessions to test filtering.
const EVENTS = [
  { ts: '2026-06-30T10:03:00Z', event_type: 'account.switch', aisup_session_id: 's1', account: 'account2', details: { rationale: { reason_code: '429', chosen: 'account2' } } },
  { ts: '2026-06-30T10:00:00Z', event_type: 'session.start', aisup_session_id: 's1', account: 'primary', details: {} },
  { ts: '2026-06-30T10:05:00Z', event_type: 'session.stop', aisup_session_id: 's1', account: 'account2', details: {} },
  { ts: '2026-06-30T10:01:00Z', event_type: 'session.start', aisup_session_id: 's2', account: 'primary', details: {} },
];

describe('C11: aisup session timeline', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    rmSync(join(home, 'daemon.pid'), { force: true });
    writeFileSync(JOURNAL, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('prints the session lifecycle ordered by time, filtered to the session id', async () => {
    await sessionTimeline({ id: 's1' });
    const out = logs.join('\n');
    // s2's start must not appear (filtered out).
    const startIdx = out.indexOf('session.start');
    const switchIdx = out.indexOf('account.switch');
    const stopIdx = out.indexOf('session.stop');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeGreaterThan(startIdx); // ordered: start → switch → stop
    expect(stopIdx).toBeGreaterThan(switchIdx);
    expect(out).toMatch(/429 → account2/); // failover rationale rendered inline
    // Exactly one start line (s2's is excluded).
    expect(out.match(/session\.start/g)?.length).toBe(1);
  });

  it('emits the raw ordered timeline with --json', async () => {
    await sessionTimeline({ id: 's1', json: true });
    const parsed = JSON.parse(logs.join('\n')) as { session: string; timeline: Array<{ event_type: string }> };
    expect(parsed.session).toBe('s1');
    expect(parsed.timeline.map((e) => e.event_type)).toEqual(['session.start', 'account.switch', 'session.stop']);
  });
});
