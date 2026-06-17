import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildWorkerCommand } from './adapter.js';
import { runWorker } from './runner.js';
import type { WorkerExec } from './runner.js';
import type { WorkerAdapterConfig, WorkerReviewConfig } from '../config/schema.js';
import type { WorkerTask, WorkerOutput, ReviewVerdict } from './types.js';
import type { JournalWriter } from '../journal/types.js';

/** Build the reviewer prompt — task + sanitized patch + a strict trailing-verdict instruction (MD-007). */
export function buildReviewPrompt(task: WorkerTask, patch: string): string {
  return [
    'You are an independent code reviewer. A DIFFERENT model produced the change below for this task.',
    '',
    `Task type: ${task.task_type}`,
    `Task: ${task.prompt}`,
    '',
    'Proposed patch (unified diff):',
    '```diff',
    patch,
    '```',
    '',
    'Review the patch for correctness, security, and adherence to the task. List any findings.',
    'End your response with EXACTLY ONE line, either:',
    'VERDICT: APPROVE',
    'or',
    'VERDICT: REJECT',
  ].join('\n');
}

/** Parse the trailing verdict token (or a JSON {verdict} line). Returns null on parse failure. */
function parseVerdict(output: string): 'approve' | 'reject' | null {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /VERDICT:\s*(APPROVE|REJECT)/i.exec(lines[i]);
    if (m) return m[1].toLowerCase() === 'approve' ? 'approve' : 'reject';
    try {
      const obj = JSON.parse(lines[i]) as { verdict?: unknown };
      if (typeof obj?.verdict === 'string') {
        const v = obj.verdict.toLowerCase();
        if (v === 'approve' || v === 'reject') return v;
      }
    } catch {
      // not JSON — keep scanning
    }
  }
  return null;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Sorted relpath:size:mtime fingerprint of a tree (skips top-level skip names + .git). */
function treeFingerprint(root: string, skipTop: Set<string>): string {
  const parts: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? join(root, rel) : root;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      if (rel === '' && skipTop.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(childRel);
      } else if (e.isFile()) {
        try {
          const st = statSync(join(abs, e.name));
          parts.push(`${childRel}:${st.size}:${st.mtimeMs}`);
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Review the worker patch with a different model and produce a strict verdict (Feature: cross-model
 * review). Runs the reviewer in a throwaway reviewDir with isolated HOME/env; fails closed on a
 * reviewer side-effect (HI-008) or a parse failure (MD-007). The patch must already be sanitized.
 */
export async function reviewWorkerOutput(opts: {
  task: WorkerTask;
  output: WorkerOutput;
  reviewerAdapter: WorkerAdapterConfig;
  review: WorkerReviewConfig;
  journal: JournalWriter;
  reviewDir: string;
  worktreePath: string;
  runner?: WorkerExec;
}): Promise<ReviewVerdict> {
  const { task, output, reviewerAdapter, review, journal, reviewDir, worktreePath, runner } = opts;
  const workspaceRoot = task.workspace_root;
  const degraded = reviewerAdapter.name === task.implementer;
  const reviewer = reviewerAdapter.name;

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'worker.review_started',
    details: { worker_task_id: task.id, reviewer, degraded },
  });

  // Same-model fallback: never silently same-model-review.
  if (degraded && !review.allow_same_model_review) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.review_degraded',
      details: { worker_task_id: task.id, reviewer, verdict: 'reject', degraded: true, reason: 'same_model_disallowed' },
    });
    return { reviewer, verdict: 'reject', degraded: true, findings: [], raw_output_tail: '' };
  }

  mkdirSync(join(reviewDir, '.home'), { recursive: true });

  // Read-only gate: fingerprint the worktree + main workspace (minus the worktree subtree) before.
  const worktreeTop = relative(workspaceRoot, worktreePath).split(sep)[0];
  const fingerprint = (): string =>
    `${treeFingerprint(worktreePath, new Set(['.home']))}||${treeFingerprint(workspaceRoot, new Set([worktreeTop]))}`;
  const before = fingerprint();

  const reviewTask: WorkerTask = { ...task, prompt: buildReviewPrompt(task, output.patch) };
  const plan = buildWorkerCommand(reviewerAdapter, reviewTask, reviewDir, reviewDir);
  const res = await runWorker(plan, { cwd: reviewDir, timeoutSeconds: reviewerAdapter.timeout_seconds, exec: runner });

  // Read-only gate: any change to the worktree/main workspace or the patch artifact fails closed.
  const after = fingerprint();
  const patchUnchanged = existsSync(output.patch_path) && sha256File(output.patch_path) === output.patch_sha256;
  if (before !== after || !patchUnchanged) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.review_failed',
      details: { worker_task_id: task.id, reviewer, verdict: 'reject', degraded, reason: 'reviewer_side_effect' },
    });
    return { reviewer, verdict: 'reject', degraded, findings: [], raw_output_tail: res.stdout };
  }

  const verdict = parseVerdict(res.stdout);
  if (verdict === null) {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.review_failed',
      details: { worker_task_id: task.id, reviewer, verdict: 'reject', degraded, reason: 'parse_failed' },
    });
    return { reviewer, verdict: 'reject', degraded, findings: [], raw_output_tail: res.stdout };
  }

  if (verdict === 'reject') {
    await journal.append({
      ts: new Date().toISOString(),
      event_type: 'worker.review_failed',
      details: { worker_task_id: task.id, reviewer, verdict: 'reject', degraded, reason: 'rejected' },
    });
    return { reviewer, verdict: 'reject', degraded, findings: [], raw_output_tail: res.stdout };
  }

  await journal.append({
    ts: new Date().toISOString(),
    event_type: 'worker.review_passed',
    details: { worker_task_id: task.id, reviewer, verdict: 'approve', degraded },
  });
  return { reviewer, verdict: 'approve', degraded, findings: [], raw_output_tail: res.stdout };
}
