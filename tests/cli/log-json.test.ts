import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-logj-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { showLog } from '../../src/cli/commands/log.js';

const PID = join(home, 'daemon.pid');
const TOKEN = join(home, 'api-token');

describe('F-2: aisup log --json', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(TOKEN, 'tok');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(PID, { force: true }); });

  it('emits valid JSON of the event list from the running daemon', async () => {
    writeFileSync(PID, JSON.stringify({ port: 7394 }));
    const events = [{ ts: '2026-06-30T00:00:00Z', event_type: 'account.switch', account: 'primary', details: {} }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events }), { status: 200 }),
    ));
    await showLog({ json: true });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].event_type).toBe('account.switch');
  });
});
