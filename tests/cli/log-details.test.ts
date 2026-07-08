import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-logd-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { showLog } from '../../src/cli/commands/log.js';

const PID = join(home, 'daemon.pid');
const TOKEN = join(home, 'api-token');

describe('C2: aisup log --details renders failover rationale', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(TOKEN, 'tok');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(PID, { force: true }); });

  const switchEvent = {
    ts: '2026-06-30T12:00:00Z',
    event_type: 'account.switch',
    account: 'account2',
    details: {
      phase: 'completed',
      rationale: {
        reason_code: '429',
        chosen: 'account2',
        candidates: [
          { name: 'primary', score: 20, excluded_reason: 'is_current' },
          { name: 'account2', score: 80, excluded_reason: null },
        ],
      },
    },
  };

  it('prints reason code, chosen target, and per-candidate scores under the event with --details', async () => {
    writeFileSync(PID, JSON.stringify({ port: 7394 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events: [switchEvent] }), { status: 200 }),
    ));
    await showLog({ details: true });
    const out = logs.join('\n');
    expect(out).toMatch(/account\.switch/);
    expect(out).toMatch(/why:\s*429\s*→\s*chose account2/);
    expect(out).toMatch(/primary: 20% \(is_current\)/);
    expect(out).toMatch(/account2: 80% \(chosen\)/);
  });

  it('omits the rationale block without --details', async () => {
    writeFileSync(PID, JSON.stringify({ port: 7394 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events: [switchEvent] }), { status: 200 }),
    ));
    await showLog({});
    const out = logs.join('\n');
    expect(out).toMatch(/account\.switch/);
    expect(out).not.toMatch(/why:/);
  });
});
