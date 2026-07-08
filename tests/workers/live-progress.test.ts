import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-live-')); // reserved marker
  process.env.AISUP_HOME = dir;
  return dir;
});

import { workerLogsFollow } from '../../src/cli/commands/worker.js';
import { WorkerStore } from '../../src/workers/store.js';
import type { WorkerTask } from '../../src/workers/types.js';

function makeTask(id: string): WorkerTask {
  const now = new Date().toISOString();
  return {
    id, task_type: 'implement', title: 't', prompt: 'p', base_ref: 'HEAD', base_sha: 'sha',
    implementer: 'codex', reviewer: null, workspace_root: '/r', created_at: now, updated_at: now,
  };
}

describe('C12: worker logs --follow', () => {
  let workersDir: string;
  let store: WorkerStore;
  beforeEach(() => {
    workersDir = join(home, 'workers');
    mkdirSync(workersDir, { recursive: true });
    store = new WorkerStore(workersDir);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(workersDir, { recursive: true, force: true }); });

  it('streams incremental output, redacts secrets, and exits when the worker is terminal', async () => {
    const id = randomUUID();
    store.create(makeTask(id));
    const logPath = join(store.dir(id), 'live.log');
    writeFileSync(logPath, 'building...\napi_key=SUPERSECRET\ncompiled ok\n');

    const written: string[] = [];
    (process.stdout.write as unknown as { mockImplementation: (f: (c: string) => boolean) => void })
      .mockImplementation((chunk: string) => { written.push(String(chunk)); return true; });

    // Flip to terminal shortly after follow starts so the poll loop exits.
    setTimeout(() => { appendFileSync(logPath, 'done\n'); store.patch(id, { status: 'MERGED' }); }, 120);

    await workerLogsFollow(id, 40);

    const out = written.join('');
    expect(out).toContain('building...');
    expect(out).toContain('compiled ok');
    expect(out).toContain('[redacted]');       // the api_key line is redacted on read
    expect(out).not.toContain('SUPERSECRET');   // the secret value never reaches stdout
    expect(out).toContain('done');              // appended-during-follow content is streamed
    expect(out).toMatch(/\[worker MERGED\]/);   // clean exit on terminal state
  });

  it('reports not found for an unknown worker id', async () => {
    const written: string[] = [];
    (process.stdout.write as unknown as { mockImplementation: (f: (c: string) => boolean) => void })
      .mockImplementation((chunk: string) => { written.push(String(chunk)); return true; });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    await workerLogsFollow(randomUUID(), 40);
    expect(logs.join('\n')).toMatch(/not found/i);
  });
});
