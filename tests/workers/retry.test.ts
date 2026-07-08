import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkerOrchestrator } from '../../src/workers/orchestrator.js';
import type { OrchestratorDeps, WorktreeOps } from '../../src/workers/orchestrator.js';
import { WorkerStore } from '../../src/workers/store.js';
import { CONFIG_DEFAULTS } from '../../src/config/defaults.js';
import type { WorkersConfig } from '../../src/config/schema.js';
import type { WorkerTask } from '../../src/workers/types.js';

function workersConfig(): WorkersConfig {
  const base = JSON.parse(JSON.stringify(CONFIG_DEFAULTS.workers)) as WorkersConfig;
  base.enabled = true;
  base.adapters.codex.enabled = true;
  base.adapters.gemini.enabled = true;
  return base;
}

function makeTask(id: string): WorkerTask {
  const now = new Date().toISOString();
  return {
    id, task_type: 'implement', title: 'original title', prompt: 'do the original thing',
    base_ref: 'HEAD', base_sha: 'abc1230000000000000000000000000000000000',
    implementer: 'codex', reviewer: 'gemini', pinned_implementer: 'codex', pinned_reviewer: null,
    workspace_root: '/repo', created_at: now, updated_at: now,
  };
}

async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('C6: worker retry', () => {
  let dir: string;
  let store: WorkerStore;
  let orch: WorkerOrchestrator;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aisup-retry-'));
    store = new WorkerStore(dir);
    let wt = 0;
    const worktreeOps: WorktreeOps = {
      resolveBaseSha: async () => 'basesha000000000000000000000000000000000',
      createWorktree: async ({ taskId }) => {
        const p = join(dir, 'wt', `${taskId}-${wt++}`);
        mkdirSync(join(p, '.home'), { recursive: true });
        return p;
      },
      captureDiff: async () => ({ patch: 'diff --git a/x b/x\n+x\n', changedFiles: ['x.ts'] }),
      snapshotMainTree: async () => ({ status: '', forbidden: {} }),
      auditBoundary: async () => true,
      sanitizePatch: () => ({ ok: true, violations: [] }),
      patchSha256: () => 'hash',
      removeWorktree: async () => undefined,
      isGitRepo: async () => true,
      applyCheck: async () => true,
      applyReverseCheck: async () => false,
    };
    const deps: OrchestratorDeps = {
      store, config: workersConfig(),
      journal: { append: async () => undefined },
      worktreeOps,
      runImplementer: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }),
      validateOutput: async () => ({ passed: true, failed_gates: [] }),
      reviewOutput: async () => ({ reviewer: 'gemini', verdict: 'approve', degraded: false, findings: [], raw_output_tail: '' }),
      mergeOutput: async () => ({ merged: true, reason: null, resetApproval: false }),
      resolveActiveSessionCwd: () => '/repo',
    };
    orch = new WorkerOrchestrator(deps);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('re-dispatches a new worker from a FAILED worker, linked via retry_of, preserving the task', async () => {
    const id = randomUUID();
    store.create(makeTask(id));
    store.patch(id, { status: 'FAILED', error_summary: 'all_candidates_exhausted' });

    const res = await orch.retry(id);
    expect(res.ok).toBe(true);
    expect(res.id).toBeDefined();
    expect(res.id).not.toBe(id);

    const fresh = store.read(res.id!);
    expect(fresh!.retry_of).toBe(id);
    expect(fresh!.task.prompt).toBe('do the original thing');
    expect(fresh!.task.task_type).toBe('implement');

    // Let the new pipeline settle so no async work outlives the test.
    await waitFor(() => ['AWAITING_APPROVAL', 'MERGED', 'FAILED', 'REJECTED'].includes(store.read(res.id!)?.status ?? ''));
  });

  it('rejects retry of an in-flight worker', async () => {
    const id = randomUUID();
    store.create(makeTask(id));
    store.patch(id, { status: 'RUNNING' });

    const res = await orch.retry(id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/RUNNING|not_retryable|in_flight/i);
  });

  it('reports not_found for an unknown worker', async () => {
    const res = await orch.retry(randomUUID());
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not_found/i);
  });
});
