import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerStore } from '../../src/workers/store.js';
import { formatWorkerStatus } from '../../src/cli/commands/worker.js';
import type { WorkerTask, WorkerState } from '../../src/workers/types.js';

function makeTask(id: string): WorkerTask {
  const now = new Date().toISOString();
  return {
    id, task_type: 'implement', title: 'do a thing', prompt: 'do a thing',
    base_ref: 'HEAD', base_sha: 'abc1230000000000000000000000000000000000',
    implementer: 'claude', reviewer: 'codex', workspace_root: '/repo',
    created_at: now, updated_at: now,
  };
}

describe('C3: worker tried_candidates transparency', () => {
  let tmpDir: string;
  let store: WorkerStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisup-tried-'));
    store = new WorkerStore(tmpDir);
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('appendTriedCandidate accumulates each failed candidate with its reason', () => {
    const id = randomUUID();
    store.create(makeTask(id));

    store.appendTriedCandidate(id, { provider: 'claude', account: 'a1', reason: 'rate_limited', role: 'implementer' });
    store.appendTriedCandidate(id, { provider: 'codex', reason: 'auth_failed', role: 'implementer' });

    const read = store.read(id);
    expect(read!.tried_candidates).toEqual([
      { provider: 'claude', account: 'a1', reason: 'rate_limited', role: 'implementer' },
      { provider: 'codex', reason: 'auth_failed', role: 'implementer' },
    ]);
  });

  it('formatWorkerStatus lists each tried candidate + reason for a FAILED worker', () => {
    const id = randomUUID();
    const state: WorkerState = {
      task: makeTask(id),
      status: 'FAILED',
      worktree_path: null,
      output: null,
      review: null,
      validation: null,
      approval: { decided: false, granted: false, by: null, at: null },
      error_summary: 'all_candidates_exhausted',
      tried_candidates: [
        { provider: 'claude', account: 'a1', reason: 'rate_limited', role: 'implementer' },
        { provider: 'codex', reason: 'auth_failed', role: 'implementer' },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const out = formatWorkerStatus(state);
    expect(out).toMatch(/tried/i);
    expect(out).toMatch(/claude:a1.*rate_limited/);
    expect(out).toMatch(/codex.*auth_failed/);
  });
});
