import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { MAX_BUFFER } from '../gates/engine.js';
import type { WorkerState } from './types.js';
import type { JournalWriter } from '../journal/types.js';

const execFileAsync = promisify(execFile);

export interface MergeResult {
  merged: boolean;
  reason: 'not_approved' | 'no_patch' | 'patch_hash_mismatch' | 'apply_conflict' | null;
  /** When true, the orchestrator must reset approval to non-granted (HI-006). */
  resetApproval: boolean;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Apply an approved worker patch to the main workspace as a working-tree edit only — gated on a
 * clean `git apply --check`, recorded user approval, and a patch-artifact integrity check. Never
 * add/commit/push/reset/clean/branch; the only git verbs are `apply --check` and `apply`.
 */
export async function mergeWorkerOutput(opts: {
  workspaceRoot: string;
  state: WorkerState;
  journal: JournalWriter;
}): Promise<MergeResult> {
  const { workspaceRoot, state, journal } = opts;
  const taskId = state.task.id;

  // Precondition: must be AWAITING_APPROVAL and explicitly approved.
  if (state.status !== 'AWAITING_APPROVAL' || state.approval.granted !== true) {
    return { merged: false, reason: 'not_approved', resetApproval: false };
  }
  if (!state.output) {
    return { merged: false, reason: 'no_patch', resetApproval: false };
  }
  const patchPath = state.output.patch_path;

  await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merge_started', details: { worker_task_id: taskId } });

  // Integrity check first (MD-009): the on-disk patch must still match the reviewed/approved bytes.
  if (!existsSync(patchPath) || sha256File(patchPath) !== state.output.patch_sha256) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.merge_failed',
      details: { worker_task_id: taskId, reason: 'patch_hash_mismatch' },
    });
    return { merged: false, reason: 'patch_hash_mismatch', resetApproval: true };
  }

  // Clean-apply proof.
  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', '--check', patchPath], { maxBuffer: MAX_BUFFER });
  } catch {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.merge_failed',
      details: { worker_task_id: taskId, reason: 'apply_conflict' },
    });
    return { merged: false, reason: 'apply_conflict', resetApproval: true };
  }

  // Apply to the working tree only. A throw after a passing check (TOCTOU) is treated identically
  // to a conflict — git apply is atomic, so no partial write occurs (IN-101).
  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', patchPath], { maxBuffer: MAX_BUFFER });
  } catch {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.merge_failed',
      details: { worker_task_id: taskId, reason: 'apply_conflict' },
    });
    return { merged: false, reason: 'apply_conflict', resetApproval: true };
  }

  await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merged', details: { worker_task_id: taskId } });
  return { merged: true, reason: null, resetApproval: false };
}

export interface UndoResult {
  reverted: boolean;
  reason: 'not_merged' | 'no_patch' | 'patch_hash_mismatch' | 'diverged' | null;
}

/**
 * C10: revert a previously-merged worker patch by reverse-applying the SAME approved patch bytes to
 * the working tree. Best-effort and git-safe: gated on `git apply --reverse --check` so a tree that
 * has diverged (conflicting local edits, or an already-reverted patch) is refused, never force-reset.
 * The only git verbs are `apply --reverse --check` and `apply --reverse`.
 */
export async function undoWorkerMerge(opts: {
  workspaceRoot: string;
  state: WorkerState;
  journal: JournalWriter;
}): Promise<UndoResult> {
  const { workspaceRoot, state, journal } = opts;
  const taskId = state.task.id;
  if (state.status !== 'MERGED') return { reverted: false, reason: 'not_merged' };
  if (!state.output) return { reverted: false, reason: 'no_patch' };
  const patchPath = state.output.patch_path;

  if (!existsSync(patchPath) || sha256File(patchPath) !== state.output.patch_sha256) {
    await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merge_revert_failed', details: { worker_task_id: taskId, reason: 'patch_hash_mismatch' } });
    return { reverted: false, reason: 'patch_hash_mismatch' };
  }

  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', '--reverse', '--check', patchPath], { maxBuffer: MAX_BUFFER });
  } catch {
    await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merge_revert_failed', details: { worker_task_id: taskId, reason: 'diverged' } });
    return { reverted: false, reason: 'diverged' };
  }

  try {
    await execFileAsync('git', ['-C', workspaceRoot, 'apply', '--reverse', patchPath], { maxBuffer: MAX_BUFFER });
  } catch {
    await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merge_revert_failed', details: { worker_task_id: taskId, reason: 'diverged' } });
    return { reverted: false, reason: 'diverged' };
  }

  await journal.append({ ts: new Date().toISOString(), event_type: 'worker.merge_reverted', details: { worker_task_id: taskId } });
  return { reverted: true, reason: null };
}
