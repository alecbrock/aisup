import { detect429InOutput } from '../daemon/loops/recovery-handler.js';
import { detectAuthFailure } from '../recovery/patterns.js';
import type { ConcreteCandidate } from '../providers/types.js';
import type { WorkerExecResult } from './runner.js';

/**
 * Worker multi-provider failover loop (Part B). Runs a resolved candidate list one at a time, each in a
 * fresh worktree, until one succeeds or all are exhausted. A boundary violation on ANY candidate is
 * terminal (fail-closed, no failover) — a failed candidate that touched the main tree is a security event.
 */

export type CandidateFailureKind = 'timed_out' | 'unspawnable' | 'rate_limited' | 'auth_failed' | 'task_failed';

/** Classify a worker run result for failover. Returns null on a clean (code 0) exit. */
export function classifyCandidateFailure(result: WorkerExecResult): CandidateFailureKind | null {
  if (result.timedOut) return 'timed_out';
  if (result.code === null) return 'unspawnable';
  if (result.code !== 0) {
    const blob = `${result.stdout}\n${result.stderr}`;
    if (detect429InOutput(blob)) return 'rate_limited';
    if (detectAuthFailure(blob)) return 'auth_failed';
    return 'task_failed';
  }
  return null;
}

/**
 * True for failures that mark the candidate reactively UNAVAILABLE (a capacity/auth/availability
 * signal). A plain `task_failed` advances to the next candidate but is NOT a capacity signal, so the
 * target stays selectable for later tasks.
 */
export function isFailoverWorthy(kind: CandidateFailureKind): boolean {
  return kind !== 'task_failed';
}

export type FailoverOutcome =
  | { kind: 'success'; candidate: ConcreteCandidate; worktree: string; result: WorkerExecResult }
  | { kind: 'boundary_violation'; candidate: ConcreteCandidate; worktree: string }
  | { kind: 'exhausted'; tried: ConcreteCandidate[] }
  | { kind: 'cancelled'; worktree?: string };

export interface CandidateLoopHooks {
  /** Create a fresh worktree for this candidate (same base_sha); returns the worktree path. */
  createWorktree(candidate: ConcreteCandidate, index: number): Promise<string>;
  /** Run the candidate's provider in its worktree and return the raw exec result. */
  runCandidate(candidate: ConcreteCandidate, worktree: string): Promise<WorkerExecResult>;
  /** Audit the main tree against the pre-first-candidate baseline; false = boundary violation. */
  auditBoundary(): Promise<boolean>;
  /** Remove a failed candidate's worktree before the next candidate is created. */
  removeWorktree(worktree: string): Promise<void>;
  /** Mark a candidate reactively unavailable (failover-worthy failures only). */
  markUnavailable(candidate: ConcreteCandidate, kind: CandidateFailureKind): void;
  /** Cooperative cancellation between candidates. */
  isCancelled(): boolean;
  onCandidateFailed(candidate: ConcreteCandidate, kind: CandidateFailureKind): Promise<void>;
  onFailover(from: ConcreteCandidate, to: ConcreteCandidate): Promise<void>;
  onCleanupError(worktree: string, error: string): Promise<void>;
}

/**
 * Run the candidate loop. The boundary audit runs after EVERY candidate (before any failover or
 * cleanup); a violation short-circuits to a terminal `boundary_violation`. On a failover-worthy
 * failure the candidate is marked unavailable; on any non-success failure its worktree is removed
 * before the next candidate. Cancellation is honored between candidates.
 */
export async function runCandidateLoop(
  candidates: readonly ConcreteCandidate[],
  hooks: CandidateLoopHooks
): Promise<FailoverOutcome> {
  const tried: ConcreteCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    // Between-candidate cancellation only: the first candidate always runs once (mirrors the
    // pre-failover pipeline, which checked cancellation AFTER the run, never before it).
    if (i > 0 && hooks.isCancelled()) return { kind: 'cancelled' };
    const candidate = candidates[i];
    tried.push(candidate);

    const worktree = await hooks.createWorktree(candidate, i);
    const result = await hooks.runCandidate(candidate, worktree);

    if (hooks.isCancelled()) return { kind: 'cancelled', worktree };

    // Boundary audit on EVERY candidate, before any failover/cleanup (fail-closed, terminal).
    const boundaryOk = await hooks.auditBoundary();
    if (!boundaryOk) return { kind: 'boundary_violation', candidate, worktree };

    const failure = classifyCandidateFailure(result);
    if (failure === null) return { kind: 'success', candidate, worktree, result };

    await hooks.onCandidateFailed(candidate, failure);
    if (isFailoverWorthy(failure)) hooks.markUnavailable(candidate, failure);

    try {
      await hooks.removeWorktree(worktree);
    } catch (e) {
      await hooks.onCleanupError(worktree, e instanceof Error ? e.message : String(e));
    }

    const next = candidates[i + 1];
    if (next) await hooks.onFailover(candidate, next);
  }

  return { kind: 'exhausted', tried };
}
