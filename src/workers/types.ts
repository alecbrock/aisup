/** Worker lifecycle states. Disjoint from SessionStatus (src/session/types.ts) by design. */
export type WorkerStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'IMPLEMENTED'
  | 'VALIDATING'
  | 'REVIEWING'
  | 'AWAITING_APPROVAL'
  | 'MERGING'
  | 'MERGED'
  | 'FAILED'
  | 'REJECTED'
  | 'CANCELLED';

export interface WorkerTask {
  id: string; // uuid
  task_type: string; // routing key, e.g. "implement" | "bugfix" | "refactor"
  title: string; // set at dispatch; defaults to the prompt truncated to 80 chars
  prompt: string; // the task instruction given to the worker
  base_ref: string; // requested git ref the worktree branches from (default: HEAD)
  base_sha: string; // immutable commit base_ref resolves to at dispatch
  implementer: string; // resolved adapter name
  reviewer: string | null; // resolved adapter name (null only when degraded+allowed)
  workspace_root: string; // absolute path to the main git repo
  created_at: string;
  updated_at: string;
}

export interface WorkerOutput {
  exit_code: number | null; // null on timeout/unspawnable
  timed_out: boolean;
  stdout_tail: string; // tail-truncated; redacted before persist
  stderr_tail: string; // tail-truncated; redacted before persist
  patch: string; // `git -C <worktree> diff <base_sha>` text; set only after sanitization passes
  patch_path: string; // saved artifact path under the worker dir
  patch_sha256: string; // sha256 of the sanitized patch bytes; computed before review
  patch_bytes: number; // byte length of the sanitized patch
  changed_files: string[]; // from `git diff --name-only <base_sha>`
  boundary_ok: boolean; // workspace-boundary audit result
}

export interface ReviewVerdict {
  reviewer: string;
  verdict: 'approve' | 'reject';
  degraded: boolean; // true when reviewer == implementer (same-model fallback)
  findings: { severity: 'low' | 'medium' | 'high'; summary: string }[];
  raw_output_tail: string;
}

export interface WorkerApproval {
  decided: boolean;
  granted: boolean;
  by: string | null;
  at: string | null;
}

export interface WorkerValidationResult {
  passed: boolean;
  failed_gates: string[];
}

export interface WorkerState {
  task: WorkerTask;
  status: WorkerStatus;
  worktree_path: string | null; // detached worktree; no branch ref is ever created
  output: WorkerOutput | null;
  review: ReviewVerdict | null;
  validation: WorkerValidationResult | null;
  approval: WorkerApproval;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}
