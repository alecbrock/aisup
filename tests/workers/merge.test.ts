import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeWorkerOutput } from '../../src/workers/merge.js';
import { patchSha256 } from '../../src/workers/worktree.js';
import type { WorkerState } from '../../src/workers/types.js';
import type { JournalEvent, JournalWriter } from '../../src/journal/types.js';

const exec = promisify(execFile);
const g = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> => exec('git', args, { cwd });

function spyJournal(): { journal: JournalWriter; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  return { events, journal: { append: async (e) => { events.push(e); } } };
}

async function initRepo(dir: string): Promise<void> {
  await g(['init', '-b', 'main'], dir);
  await g(['config', 'user.email', 't@t.dev'], dir);
  await g(['config', 'user.name', 'Tester'], dir);
  writeFileSync(join(dir, 'app.ts'), 'export const v = 1;\n');
  await g(['add', 'app.ts'], dir);
  await g(['commit', '-m', 'init'], dir);
}

// Produce a clean patch (v=1 -> v=2) and revert the repo.
async function makePatch(dir: string): Promise<string> {
  writeFileSync(join(dir, 'app.ts'), 'export const v = 2;\n');
  const { stdout } = await g(['diff'], dir);
  await g(['checkout', '--', 'app.ts'], dir);
  return stdout;
}

function makeState(repo: string, patch: string, patchPath: string, granted: boolean): WorkerState {
  return {
    task: {
      id: 'tid', task_type: 'implement', title: 't', prompt: 'p', base_ref: 'HEAD', base_sha: 'sha',
      implementer: 'codex', reviewer: 'gemini', workspace_root: repo, created_at: 'now', updated_at: 'now',
    },
    status: 'AWAITING_APPROVAL',
    worktree_path: null,
    output: {
      exit_code: 0, timed_out: false, stdout_tail: '', stderr_tail: '',
      patch, patch_path: patchPath, patch_sha256: patchSha256(patch), patch_bytes: Buffer.byteLength(patch),
      changed_files: ['app.ts'], boundary_ok: true,
    },
    review: { reviewer: 'gemini', verdict: 'approve', degraded: false, findings: [], raw_output_tail: '' },
    validation: { passed: true, failed_gates: [] },
    approval: { decided: granted, granted, by: granted ? 'user' : null, at: granted ? 'now' : null },
    error_summary: null,
    created_at: 'now', updated_at: 'now',
  };
}

describe('mergeWorkerOutput (@requires_git)', () => {
  let repo: string;
  let patchPath: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'aisup-merge-'));
    await initRepo(repo);
    patchPath = join(repo, 'patch.diff');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('applies an approved clean patch to the working tree with no commit', async () => {
    const patch = await makePatch(repo);
    writeFileSync(patchPath, patch);
    const headBefore = (await g(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const { journal, events } = spyJournal();
    const res = await mergeWorkerOutput({ workspaceRoot: repo, state: makeState(repo, patch, patchPath, true), journal });
    expect(res.merged).toBe(true);
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const v = 2;\n');
    expect(events.some((e) => e.event_type === 'worker.merged')).toBe(true);
    expect((await g(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(headBefore); // no commit
  });

  it('refuses to merge without approval.granted (no file change)', async () => {
    const patch = await makePatch(repo);
    writeFileSync(patchPath, patch);
    const { journal, events } = spyJournal();
    const res = await mergeWorkerOutput({ workspaceRoot: repo, state: makeState(repo, patch, patchPath, false), journal });
    expect(res.merged).toBe(false);
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const v = 1;\n');
    expect(events.some((e) => e.event_type === 'worker.merged')).toBe(false);
  });

  it('refuses a drifted patch artifact with patch_hash_mismatch BEFORE apply --check', async () => {
    const patch = await makePatch(repo);
    writeFileSync(patchPath, patch);
    const state = makeState(repo, patch, patchPath, true);
    // mutate the on-disk patch artifact after the hash was recorded
    writeFileSync(patchPath, patch + '\n# tampered\n');
    const { journal, events } = spyJournal();
    const res = await mergeWorkerOutput({ workspaceRoot: repo, state, journal });
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('patch_hash_mismatch');
    expect(res.resetApproval).toBe(true);
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const v = 1;\n'); // unchanged
    const failed = events.find((e) => e.event_type === 'worker.merge_failed');
    expect(failed?.details.reason).toBe('patch_hash_mismatch');
  });

  it('fails a conflicting patch with apply_conflict, resets approval, and refuses the retry until re-approved (HI-006)', async () => {
    const patch = await makePatch(repo);
    writeFileSync(patchPath, patch);
    // advance the base so the patch no longer applies cleanly
    writeFileSync(join(repo, 'app.ts'), 'export const v = 555;\n');
    await g(['add', 'app.ts'], repo);
    await g(['commit', '-m', 'conflict'], repo);
    const state = makeState(repo, patch, patchPath, true);
    const { journal, events } = spyJournal();
    const res = await mergeWorkerOutput({ workspaceRoot: repo, state, journal });
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('apply_conflict');
    expect(res.resetApproval).toBe(true);
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const v = 555;\n'); // unchanged
    expect(events.find((e) => e.event_type === 'worker.merge_failed')?.details.reason).toBe('apply_conflict');

    // Orchestrator resets approval → a second attempt is refused until re-approved.
    state.approval = { decided: false, granted: false, by: null, at: null };
    const retry = await mergeWorkerOutput({ workspaceRoot: repo, state, journal });
    expect(retry.merged).toBe(false);
    expect(retry.reason).toBe('not_approved');
  });
});
