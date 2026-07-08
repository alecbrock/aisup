import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-logf-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { showLog } from '../../src/cli/commands/log.js';

const JOURNAL = join(home, 'journal.jsonl');

// Distinct event types so filtered output is assertable by type presence/absence.
const EVENTS = [
  { ts: '2026-06-30T10:00:00Z', event_type: 'session.start', account: 'primary', aisup_session_id: 's1', details: {} },
  { ts: '2026-06-30T11:00:00Z', event_type: 'account.switch', account: 'account2', aisup_session_id: 's2', details: {} },
  { ts: '2026-06-30T12:00:00Z', event_type: 'cost.snapshot', account: 'primary', aisup_session_id: 's2', details: {} },
];

describe('C4: aisup log filters (offline path)', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    // No daemon.pid → showLog uses the offline journal at AISUP_HOME/journal.jsonl.
    rmSync(join(home, 'daemon.pid'), { force: true });
    writeFileSync(JOURNAL, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('--account keeps only that account\'s events', async () => {
    await showLog({ account: 'primary' });
    const out = logs.join('\n');
    expect(out).toMatch(/session\.start/);
    expect(out).toMatch(/cost\.snapshot/);
    expect(out).not.toMatch(/account\.switch/);
  });

  it('--session keeps only that session\'s events', async () => {
    await showLog({ session: 's2' });
    const out = logs.join('\n');
    expect(out).toMatch(/account\.switch/);
    expect(out).toMatch(/cost\.snapshot/);
    expect(out).not.toMatch(/session\.start/);
  });

  it('--since keeps only events at or after the timestamp', async () => {
    await showLog({ since: '2026-06-30T11:30:00Z' });
    const out = logs.join('\n');
    expect(out).toMatch(/cost\.snapshot/);
    expect(out).not.toMatch(/session\.start/);
    expect(out).not.toMatch(/account\.switch/);
  });

  it('combines --account and --session (AND semantics)', async () => {
    await showLog({ account: 'primary', session: 's2' });
    const out = logs.join('\n');
    expect(out).toMatch(/cost\.snapshot/);
    expect(out).not.toMatch(/session\.start/); // primary but s1
    expect(out).not.toMatch(/account\.switch/); // s2 but account2
  });
});
