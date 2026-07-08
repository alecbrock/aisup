import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Set AISUP_HOME before importing the command (PID/token paths resolve at import time).
const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-health-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { showHealth } from '../../src/cli/commands/watch.js';

const PID = join(home, 'daemon.pid');
const TOKEN = join(home, 'api-token');

const OVERVIEW = {
  session: { status: 'ACTIVE', aisup_session_id: 'sess-1', account: 'primary' },
  recovery_guidance: null,
  accounts: [
    { name: 'primary', state: 'HEALTHY', score: 80, five_hour_pct: 20, seven_day_pct: 10, model: 'opus', enabled: true, cooldown_until: null },
    { name: 'account2', state: 'COOLDOWN', score: 10, five_hour_pct: 95, seven_day_pct: 40, model: 'sonnet', enabled: true, cooldown_until: null },
  ],
  workers: { total: 3, queued: 1, running: 1, awaiting_approval: 1 },
  cost_today: { total_cost_usd: 1.25, by_account: {}, by_session: {} },
  recent_events: [
    { ts: '2026-06-30T12:00:00Z', event_type: 'account.switch', account: 'account2' },
  ],
  daemon: { ok: true },
};

describe('C1: aisup health unified snapshot', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(TOKEN, 'tok');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(PID, { force: true });
  });

  it('renders session, per-account headroom, worker queue, cost-today, and recent events in one snapshot', async () => {
    writeFileSync(PID, JSON.stringify({ pid: process.pid, port: 7394 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(OVERVIEW), { status: 200 }),
    ));

    await showHealth({});

    const out = logs.join('\n');
    expect(out).toMatch(/sess-1/);
    expect(out).toMatch(/ACTIVE/);
    expect(out).toMatch(/primary/);
    expect(out).toMatch(/account2/);
    expect(out).toMatch(/3 total|3 workers/);
    expect(out).toMatch(/\$1\.25/);
    expect(out).toMatch(/account\.switch/);
  });

  it('reports daemon not running when there is no pid file', async () => {
    rmSync(PID, { force: true });
    await showHealth({});
    expect(logs.join('\n')).toMatch(/not running/i);
  });

  it('emits the raw overview payload with --json', async () => {
    writeFileSync(PID, JSON.stringify({ pid: process.pid, port: 7394 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(OVERVIEW), { status: 200 }),
    ));

    await showHealth({ json: true });

    const parsed = JSON.parse(logs.join('\n')) as typeof OVERVIEW;
    expect(parsed.workers.total).toBe(3);
    expect(parsed.cost_today.total_cost_usd).toBe(1.25);
  });
});
