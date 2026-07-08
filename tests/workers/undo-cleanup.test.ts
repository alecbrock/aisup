import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { undoWorkerMerge } from '../../src/workers/merge.js';
import { orphanWorktrees } from '../../src/workers/worktree.js';
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

function mergedState(patchPath: string): WorkerState {
  const sha = createHash('sha256').update(readFileSync(patchPath)).digest('hex');
  return {
    task: { id: 'tid', task_type: 'implement', title: 't', prompt: 'p', base_ref: 'HEAD', base_sha: 'sha', implementer: 'codex', reviewer: null, workspace_root: '/r', created_at: '', updated_at: '' },
    status: 'MERGED', worktree_path: null,
    output: { exit_code: 0, timed_out: false, stdout_tail: '', stderr_tail: '', patch: '', patch_path: patchPath, patch_sha256: sha, patch_bytes: 0, changed_files: ['app.ts'], boundary_ok: true },
    review: null, validation: null, approval: { decided: true, granted: true, by: 'u', at: 'now' },
    error_summary: null, created_at: '', updated_at: '',
  };
}

describe('C10: worker undo + cleanup', () => {
  let repo: string;
  beforeEach(async () => { repo = mkdtempSync(join(tmpdir(), 'aisup-undo-')); await initRepo(repo); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('undo reverse-applies a cleanly-merged patch, restoring the original tree', async () => {
    // Build a patch (v=1 -> v=2) and apply it (simulating a merge).
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2;\n');
    const { stdout: patch } = await g(['diff'], repo);
    await g(['checkout', '--', 'app.ts'], repo);
    const patchPath = join(repo, 'w.patch');
    writeFileSync(patchPath, patch);
    await g(['apply', patchPath], repo); // merge applied → v=2
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toContain('v = 2');

    const { journal, events } = spyJournal();
    const res = await undoWorkerMerge({ workspaceRoot: repo, state: mergedState(patchPath), journal });
    expect(res.reverted).toBe(true);
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toContain('v = 1'); // reverted
    expect(events.some((e) => e.event_type === 'worker.merge_reverted')).toBe(true);
  });

  it('undo refuses when the working tree has diverged from the applied patch', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2;\n');
    const { stdout: patch } = await g(['diff'], repo);
    await g(['checkout', '--', 'app.ts'], repo);
    const patchPath = join(repo, 'w.patch');
    writeFileSync(patchPath, patch);
    await g(['apply', patchPath], repo);
    // Diverge: an unrelated local edit makes the reverse-apply unclean.
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2;\nexport const extra = true;\n');

    const { journal } = spyJournal();
    const res = await undoWorkerMerge({ workspaceRoot: repo, state: mergedState(patchPath), journal });
    expect(res.reverted).toBe(false);
    expect(res.reason).toBe('diverged');
  });

  it('orphanWorktrees returns only worktree_dir paths not referenced by an active worker', () => {
    const worktreeDir = '.worktrees';
    const all = ['/repo/.worktrees/a', '/repo/.worktrees/b', '/repo/.worktrees/c', '/repo'];
    const referenced = new Set(['/repo/.worktrees/b']);
    const orphans = orphanWorktrees(all, referenced, worktreeDir);
    expect(orphans).toEqual(['/repo/.worktrees/a', '/repo/.worktrees/c']); // b referenced; /repo is main, not under worktree_dir
  });
});
