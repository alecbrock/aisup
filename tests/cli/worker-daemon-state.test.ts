import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Set AISUP_HOME before importing worker.js (PID/token paths are resolved at import time).
const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-wds-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { workerProviders } from '../../src/cli/commands/worker.js';

const PID = join(home, 'daemon.pid');
const TOKEN = join(home, 'api-token');

describe('F-1: worker CLI distinguishes daemon-down from workers-disabled', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(TOKEN, 'tok');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(PID, { force: true });
  });

  it('prints "Daemon not running" when the daemon is unreachable (no pid file)', async () => {
    rmSync(PID, { force: true });
    await workerProviders();
    expect(logs.join('\n')).toMatch(/Daemon not running/);
  });

  it('prints the server reason ("workers not enabled") when the daemon is up but workers are disabled', async () => {
    writeFileSync(PID, JSON.stringify({ port: 7394 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'workers not enabled' }), { status: 503 }),
    ));
    await workerProviders();
    const out = logs.join('\n');
    expect(out).toMatch(/workers not enabled/);
    expect(out).not.toMatch(/Daemon not running/);
    vi.unstubAllGlobals();
  });
});
