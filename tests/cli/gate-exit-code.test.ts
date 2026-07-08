import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-gate-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { runGateCommand } from '../../src/cli/commands/gate.js';
import type { GateRunResult } from '../../src/gates/types.js';

const PID = join(home, 'daemon.pid');
const TOKEN = join(home, 'api-token');

function gateResult(passed: boolean): GateRunResult {
  return { passed, results: [{ name: 'typecheck', status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, stdoutTail: '', stderrTail: '', required: true }] };
}

describe('F-5 aisup gate run exit code', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(TOKEN, 'tok');
    writeFileSync(PID, JSON.stringify({ port: 7394 }));
    process.exitCode = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(PID, { force: true }); process.exitCode = 0; });

  it('exits non-zero when a gate fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(gateResult(false)), { status: 200 })));
    await runGateCommand();
    expect(process.exitCode).toBe(1);
  });

  it('exits zero when all gates pass', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(gateResult(true)), { status: 200 })));
    await runGateCommand();
    expect(process.exitCode).toBe(0);
  });
});
