import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDispatchBody,
  buildRequestInit,
  formatWorkerStatus,
  formatWorkerList,
  formatWorkerReview,
  formatWorkerLogs,
  formatProviderUsage,
} from '../../src/cli/commands/worker.js';
import type { WorkerState } from '../../src/workers/types.js';
import type { ProviderUsageReport } from '../../src/providers/report.js';

function workerState(over: Partial<WorkerState> = {}): WorkerState {
  return {
    task: {
      id: 'w-1', task_type: 'implement', title: 'do the thing', prompt: 'do the thing',
      base_ref: 'HEAD', base_sha: 'sha', implementer: 'codex', reviewer: 'gemini',
      workspace_root: '/repo', created_at: 'now', updated_at: 'now',
    },
    status: 'AWAITING_APPROVAL',
    worktree_path: '/repo/.aisup-workers/w-1',
    output: {
      exit_code: 0, timed_out: false, stdout_tail: 'impl-stdout', stderr_tail: '',
      patch: 'p', patch_path: '/state/w-1/patch.diff', patch_sha256: 'h', patch_bytes: 1,
      changed_files: ['src/a.ts', 'src/b.ts'], boundary_ok: true,
    },
    review: { reviewer: 'gemini', verdict: 'approve', degraded: false, findings: [{ severity: 'low', summary: 'nit' }], raw_output_tail: 'VERDICT: APPROVE' },
    validation: { passed: true, failed_gates: [] },
    approval: { decided: false, granted: false, by: null, at: null },
    error_summary: null,
    created_at: 'now', updated_at: 'now',
    ...over,
  };
}

describe('worker CLI pure helpers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aisup-cli-worker-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('buildDispatchBody loads an @file prompt and defaults the title to the truncated prompt (LO-004)', async () => {
    const promptFile = join(dir, 'task.md');
    const longPrompt = 'X'.repeat(200);
    writeFileSync(promptFile, longPrompt);
    const body = await buildDispatchBody({ taskType: 'implement', prompt: `@${promptFile}` });
    expect(body.prompt).toBe(longPrompt); // loaded from file
    expect(body.title).toBe(longPrompt.slice(0, 80)); // defaulted + truncated
    expect(body.title.length).toBe(80);
    expect(body.task_type).toBe('implement');
  });

  it('buildDispatchBody honours an explicit title and passes through overrides', async () => {
    const body = await buildDispatchBody({ prompt: 'inline', title: 'My title', implementer: 'codex', reviewer: 'gemini', base: 'main', workspace: '/w' });
    expect(body.title).toBe('My title');
    expect(body.implementer).toBe('codex');
    expect(body.reviewer).toBe('gemini');
    expect(body.base_ref).toBe('main');
    expect(body.workspace).toBe('/w');
  });

  it('buildRequestInit attaches a JSON body with content-type for POST (LO-003)', () => {
    const init = buildRequestInit('POST', 'tok', { task_type: 'implement', prompt: 'p' });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ task_type: 'implement', prompt: 'p' }));
  });

  it('buildRequestInit omits the body/content-type for GET', () => {
    const init = buildRequestInit('GET', 'tok');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('formatWorkerStatus renders status, changed files, gates, review and approval', () => {
    const out = formatWorkerStatus(workerState());
    expect(out).toContain('AWAITING_APPROVAL');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('passed');
    expect(out).toContain('approve');
    expect(out).toContain('pending');
  });

  it('formatWorkerList renders one line per worker and handles empty', () => {
    expect(formatWorkerList([])).toBe('No workers.');
    const out = formatWorkerList([workerState(), workerState({ task: { ...workerState().task, id: 'w-2' } })]);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('w-1');
    expect(out).toContain('w-2');
  });

  it('formatWorkerReview renders the verdict + findings (LO-007)', () => {
    const out = formatWorkerReview(workerState());
    expect(out).toContain('APPROVE');
    expect(out).toContain('[low] nit');
  });

  it('formatWorkerLogs renders the sanitized tails + artifact path (LO-007)', () => {
    const out = formatWorkerLogs(workerState());
    expect(out).toContain('/state/w-1/patch.diff');
    expect(out).toContain('impl-stdout');
  });

  it('formatProviderUsage shows claude headroom + basis and codex remaining tokens vs budget per role', () => {
    const report: ProviderUsageReport = {
      roles: [
        {
          role: 'implementer',
          candidates: [
            { label: 'claude:a1', provider: 'claude', account: 'a1', available: true, headroom_pct: 72, remaining_tokens: null, basis: 'live' },
            { label: 'claude:a2', provider: 'claude', account: 'a2', available: false, headroom_pct: null, remaining_tokens: null, basis: 'unknown', reason: 'cooldown' },
            { label: 'codex', provider: 'codex', account: null, available: true, headroom_pct: null, remaining_tokens: 2_950_000, basis: 'budget' },
          ],
        },
      ],
    };
    const out = formatProviderUsage(report);
    expect(out).toContain('implementer:');
    expect(out).toContain('claude:a1');
    expect(out).toContain('headroom 72%');
    expect(out).toContain('basis=live');
    expect(out).toContain('UNAVAILABLE');
    expect(out).toContain('(cooldown)');
    expect(out).toContain('codex');
    expect(out).toContain('2950000 tokens left');
    expect(out).toContain('basis=budget');
  });

  it('formatProviderUsage handles an empty report', () => {
    expect(formatProviderUsage({ roles: [] })).toBe('No provider roles configured.');
  });
});
