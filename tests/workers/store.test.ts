import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerStore } from '../../src/workers/store.js';
import type { WorkerTask } from '../../src/workers/types.js';

function makeTask(id: string): WorkerTask {
  const now = new Date().toISOString();
  return {
    id,
    task_type: 'implement',
    title: 'do a thing',
    prompt: 'do a thing',
    base_ref: 'HEAD',
    base_sha: 'abc1230000000000000000000000000000000000',
    implementer: 'codex',
    reviewer: 'gemini',
    workspace_root: '/repo',
    created_at: now,
    updated_at: now,
  };
}

describe('WorkerStore', () => {
  let tmpDir: string;
  let store: WorkerStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-workers-store-'));
    store = new WorkerStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create persists a QUEUED WorkerState that read round-trips', () => {
    const id = randomUUID();
    const state = store.create(makeTask(id));
    expect(state.status).toBe('QUEUED');
    expect(state.approval).toEqual({ decided: false, granted: false, by: null, at: null });
    const read = store.read(id);
    expect(read).not.toBeNull();
    expect(read!.task.id).toBe(id);
    expect(read!.status).toBe('QUEUED');
    expect(read!.output).toBeNull();
  });

  it('patch updates fields + updated_at and leaves others intact', async () => {
    const id = randomUUID();
    const created = store.create(makeTask(id));
    await new Promise((r) => setTimeout(r, 5));
    const patched = store.patch(id, { status: 'RUNNING' });
    expect(patched.status).toBe('RUNNING');
    expect(patched.task.id).toBe(id); // untouched field intact
    expect(patched.updated_at).not.toBe(created.updated_at);
    expect(patched.updated_at >= created.updated_at).toBe(true);
    expect(store.read(id)!.status).toBe('RUNNING');
  });

  it('list returns all persisted workers and skips a corrupt entry', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    store.create(makeTask(id1));
    store.create(makeTask(id2));
    const corruptDir = join(tmpDir, randomUUID());
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'state.json'), '{ not valid json');
    const ids = store.list().map((s) => s.task.id).sort();
    expect(ids).toEqual([id1, id2].sort());
  });

  it('rejects non-UUID / traversal ids in read/patch/dir', () => {
    expect(() => store.dir('../x')).toThrow();
    expect(() => store.dir('a/b')).toThrow();
    expect(() => store.read('../x')).toThrow();
    expect(() => store.patch('a/b', { status: 'RUNNING' })).toThrow();
  });

  it('writes state files 0o600 under a 0o700 dir', () => {
    const id = randomUUID();
    store.create(makeTask(id));
    const dirStat = statSync(store.dir(id));
    const fileStat = statSync(join(store.dir(id), 'state.json'));
    expect(dirStat.mode & 0o700).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('WorkerStatus and SessionStatus literal unions are disjoint', () => {
    const workerSrc = readFileSync(new URL('../../src/workers/types.ts', import.meta.url), 'utf8');
    const sessionSrc = readFileSync(new URL('../../src/session/types.ts', import.meta.url), 'utf8');
    const sliceUnion = (src: string, name: string): string => {
      const start = src.indexOf(name);
      return src.slice(start, src.indexOf(';', start));
    };
    const extract = (s: string): Set<string> => new Set(s.match(/'[A-Z_]+'/g) ?? []);
    const w = extract(sliceUnion(workerSrc, 'WorkerStatus'));
    const sess = extract(sliceUnion(sessionSrc, 'SessionStatus'));
    expect(w.size).toBeGreaterThan(0);
    expect([...w].filter((x) => sess.has(x))).toEqual([]);
  });
});
