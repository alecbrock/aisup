# Phase 3: Multi-LLM Worker Orchestration Implementation Plan

Created: 2026-06-02
Author: alec.m.brock@gmail.com
Status: VERIFIED
Approved: Yes
Iterations: 1
Worktree: No
Type: Feature
Reviews merged: docs/reviews/2026-06-02-plan-review-phase3-multi-llm-worker-orchestration.md (8 iterations, 33 findings — all resolved incl. MD-001); docs/reviews/2026-06-16-plan-review-phase3-multi-llm-worker-orchestration.md (final pass — APPROVE; LO-101 + IN-101 merged)

## Summary

**Goal:** A bounded coding task can be dispatched to an LLM worker (Codex / Gemini / local) that runs shell-free in an isolated git worktree; its output diff is validated by the existing gate engine, reviewed by a *different* model, and — only after explicit user approval — applied to the main workspace as a working-tree patch (no auto-commit).

This phase adds Feature **G** (Multi-LLM Worker Orchestration) and **H₂** (Validation Gate Engine for workers) from the PRD. It builds entirely on Phase 1/2 primitives — config loader, journal event contract, `runGates` engine, shell-free `execFile`, atomic state persistence — and adds no competing event shape or second state machine.

## Source-of-Truth & Status Reconciliation

**Verified prerequisites (do not re-litigate):**
- Phase 1, Phase 1 remediation, Phase 2, and Phase 2 remediation are **complete and verified**.
- `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` — `Status: VERIFIED`, `Iterations: 5` (28/28 tasks).
- `docs/reviews/2026-06-02-phase2-spec-verify-findings.md` — **Round 3 compliance audit CLEAN, zero open issues** (F1–F4 resolved with regression tests; full suite 457 passed / 0 failed / 2 skipped).

**PRD status updates required before code work** (delivered by Task 1, mirroring Phase 2's Task 0):
- The PRD's 2026-06-01 reconciliation note and Feature Inventory still mark Phase 2 features (D₂, F, H₁, K) "in progress." They are now implemented/verified.
- Feature Inventory rows **G** and **H₂** move from "Approved" to "In progress (Phase 3)."
- No stale Phase 2 "in progress" wording may remain as a source of truth for implementation.

**Non-goals / explicitly deferred (Phase 4 or out of scope — must not leak into Phase 3):**
- Mobile/remote dashboard, dashboard token auth, ntfy fallback, rich Slack formatting, Slack thread-per-tool-call (Phase 4).
- Proxy-level / Bifrost-style API model routing (PRD: complementary, not a supervisor feature).
- Multiple simultaneous lead sessions (one lead session; workers are separate).
- launchd auto-start; Windows/Linux support.
- Remote-control reconnect after account switches (still deferred; no investigation task in this phase).
- Auto-merge / auto-approval. **User approval is mandatory for every merge.**
- Direct git writes to the **main workspace** or any permanent user-facing git state (`add`/`commit`/`push`/`reset`/`clean`/`checkout`) on the user's behalf (AGENTS rule 10). Merge applies a working-tree patch only. (Narrow exception: a worktree-local `git add -A -N` intent-to-add is permitted **inside the isolated worker worktree only**, solely to capture new files in the diff — never in the main workspace. See Autonomous Decision 4 and the Security table.)

## Approach

**Chosen:** A new `src/workers/` subsystem orchestrated by the existing daemon. Workers are **one-shot bounded `execFile` subprocesses** (mirroring `src/gates/engine.ts`'s `defaultGateRunner`, AGENTS rule 8) run with `cwd = <isolated git worktree>` and an allowlisted env. A **single generic config-driven adapter** (`buildWorkerCommand`) covers Codex/Gemini/local as config presets — no invented CLI signatures (the command/args ARE the config; real CLIs are exercised only behind host gates). The worker output artifact is the worktree's `git diff`; the **only** merge candidate is that diff, so writes outside the worktree are structurally excluded and additionally caught by a boundary audit. Validation reuses `runGates` with `cwd = worktree` (H₂). Cross-model review runs a *different* adapter over the patch. Merge = `git apply` to the main workspace after explicit approval — never `add`/`commit`/`push`.

**Why:** Maximises reuse of audited Phase 1/2 primitives (gate engine, journal contract, atomic state store, shell-free subprocess) and keeps one canonical event contract and one worker state machine; the cost is that interactive/streaming worker UX and OS-level sandboxing are out of scope for Phase 3 (bounded batch runs + cwd-confinement + audit instead).

### Autonomous Decisions (design choices resolved during planning)

These were confirmed with the user as the recommended options:
1. **Worker execution = shell-free `execFile`** (not tmux panes). Bounded non-interactive runs; matches the gate engine + AGENTS rule 8.
2. **Generic config-driven adapter + presets** (not per-provider classes). One `buildWorkerCommand` impl; Codex/Gemini/local are config entries; gemini/local ship disabled as host-gated placeholders.
3. **Isolation = cwd + git-diff-scoped merge + isolated temp HOME + boundary audit** (no OS `sandbox-exec`). The *enforceable* guarantee is structural: the **only** merge candidate is the worktree's own git diff, so a write anywhere else can never reach the main workspace through merge. Containment of the realistic escape vectors (a trusted local CLI resolving `$HOME` and writing `~/.claude` / `.claude/settings.local.json`) is achieved by running the worker with an **isolated temporary `HOME`** in its allowlisted env. The boundary audit is *detection* under the workspace tree and over a configured forbidden-path set (ignored-aware `git status`, content-hash snapshot of configured sensitive paths, symlink-component rejection). **Threat model:** accidental escape by a CLI the operator already trusts — not a deliberately adversarial binary. **Residual (explicitly accepted):** an arbitrary absolute-path write **outside `workspace_root` and outside the isolated temp HOME** (e.g. `/tmp`, `/etc`) is **neither OS-prevented nor generally detected** in Phase 3 — the boundary audit cannot observe paths it does not snapshot. The enforceable guarantees are narrower and concrete: (a) such writes never enter the merge candidate (structural diff-scoping), (b) main-workspace and configured forbidden-path changes *are* detected by the boundary audit, and (c) trusted-CLI `$HOME` writes are redirected into the throwaway HOME. OS sandboxing / filesystem monitoring (`sandbox-exec`) is the named deferred hardening required to prevent or detect arbitrary absolute-path writes, and is out of scope for Phase 3 per this decision.
4. **Merge = working-tree `git apply` only; user commits.** No `add`/`commit`/`push` to the main workspace by aisup (AGENTS rule 10). "Applies cleanly" = `git apply --check` then `git apply`. The sole automatic `git add` anywhere is the worktree-local `git add -A -N` intent-to-add used to capture new files in the worker diff (isolated worktree only, never the main workspace).

## Phase 3 Architecture

One canonical worker state machine, one worker event family, one task contract. No hidden status channels; no second task format.

### Worker lifecycle state machine

```
QUEUED ──► RUNNING ──► IMPLEMENTED ──► VALIDATING ──► REVIEWING ──► AWAITING_APPROVAL ──► MERGING ──► MERGED   (terminal ✓)
              │             │              │              │           ▲     │                  │
              ▼             ▼              ▼              ▼           │     ▼                  ▼
            FAILED        FAILED        REJECTED       REJECTED       │  REJECTED            (apply conflict:
          (exec err/    (boundary/      (gate fail)   (review reject/ │  (user deny)         emit worker.merge_failed,
           timeout)      secret deny)                  parse fail)    └───status STAYS AWAITING_APPROVAL)
```

- **Terminal states:** `MERGED`, `FAILED`, `REJECTED`, `CANCELLED`. These are the only terminal `WorkerStatus` values.
- **CANCELLED** is reachable by user request from any non-terminal state. **Cancel is cooperative, not a force-kill** (the reused `execFile` engine exposes no abort/kill hook — confirmed absent in `src/gates/engine.ts` and `src/runner/builder.ts`). `cancel(id)` records `CANCELLED` immediately and frees the slot; for `QUEUED`/`AWAITING_APPROVAL` there is no live child. For `RUNNING`/`VALIDATING`/`REVIEWING` the in-flight subprocess is **not killed** — it runs to completion or its `timeout_seconds`, and on completion the orchestrator checks `status === 'CANCELLED'` and **discards the result** (no further transition; cleanup runs then). A late completion therefore can never resurrect a cancelled worker. See Task 10.
- **Gates run before review** (cheap deterministic signal first). A gate failure → `REJECTED`. The deterministic seeded-bug review test (TS-003) uses a bug that *passes* gates but *fails* review, proving review is a distinct gate.
- **Apply conflict is NOT a status.** A failed `git apply --check` during MERGING does not introduce a `MERGE_FAILED` status; it emits the `worker.merge_failed` event and the task's status **stays `AWAITING_APPROVAL`**. **On `worker.merge_failed`, approval is reset to undecided/non-granted** (`decided:false, granted:false, by:null, at:null`) so the merge preconditions (`AWAITING_APPROVAL` **and** `approval.granted`) are no longer satisfied — a fresh explicit user approval is required before any second `git apply --check`/`git apply` attempt. This preserves the "approval required for every merge" invariant while keeping the worker re-approvable (it survives a daemon restart like any AWAITING_APPROVAL worker; the user re-approves after rebasing/re-dispatching). `WorkerStatus` therefore has no `MERGE_FAILED` member.
- This machine is independent of and must not be confused with `SessionStatus` (`src/session/types.ts`). `WorkerStatus` values (`QUEUED/RUNNING/IMPLEMENTED/VALIDATING/REVIEWING/AWAITING_APPROVAL/MERGING/MERGED/FAILED/REJECTED/CANCELLED`) share no names with `SessionStatus` (`CREATING/ACTIVE/SWITCH_PENDING_AT_IDLE/SWITCHING/STOPPING/STOPPED/EXHAUSTED`) — verified disjoint; re-confirm at implementation (Task 3 DoD).

### Worker task contract schema (`src/workers/types.ts`)

```typescript
export type WorkerStatus =
  | 'QUEUED' | 'RUNNING' | 'IMPLEMENTED' | 'VALIDATING' | 'REVIEWING'
  | 'AWAITING_APPROVAL' | 'MERGING' | 'MERGED' | 'FAILED' | 'REJECTED' | 'CANCELLED';

export interface WorkerTask {
  id: string;                       // uuid
  task_type: string;                // routing key, e.g. "implement" | "bugfix" | "refactor"
  title: string;                    // set at dispatch from --title; defaults to the prompt truncated to 80 chars
  prompt: string;                   // the task instruction given to the worker
  base_ref: string;                 // requested git ref the worktree branches from (default: HEAD)
  base_sha: string;                 // immutable commit base_ref resolves to at dispatch (rev-parse --verify <base_ref>^{commit}); worktree create + all diffs use this
  implementer: string;              // resolved adapter name
  reviewer: string | null;          // resolved adapter name (null only when degraded+allowed)
  workspace_root: string;           // absolute path to the main git repo
  created_at: string;
  updated_at: string;
}

export interface WorkerState {
  task: WorkerTask;
  status: WorkerStatus;
  worktree_path: string | null;     // detached worktree; no branch ref is ever created (Phase 3 is detached-only)
  output: WorkerOutput | null;
  review: ReviewVerdict | null;
  validation: { passed: boolean; failed_gates: string[] } | null;
  approval: { decided: boolean; granted: boolean; by: string | null; at: string | null };
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerOutput {
  exit_code: number | null;         // null on timeout/unspawnable
  timed_out: boolean;
  stdout_tail: string;              // tail-truncated (reuse GATE_OUTPUT_TAIL_LIMIT); redacted before persist (HI-002)
  stderr_tail: string;              // tail-truncated; redacted before persist (HI-002)
  patch: string;                    // `git -C <worktree> diff <base_sha>` text; only set after sanitization passes (HI-002)
  patch_path: string;               // saved artifact path under the worker dir (written only after sanitization passes)
  patch_sha256: string;             // sha256 of the sanitized patch bytes; computed before review; merge re-verifies (MD-009)
  patch_bytes: number;              // byte length of the sanitized patch
  changed_files: string[];          // from `git diff --name-only <base_sha>`
  boundary_ok: boolean;             // workspace-boundary audit result
}

export interface ReviewVerdict {
  reviewer: string;
  verdict: 'approve' | 'reject';
  degraded: boolean;                // true when reviewer == implementer (same-model fallback)
  findings: { severity: 'low' | 'medium' | 'high'; summary: string }[];
  raw_output_tail: string;
}
```

### Worker adapter interface (generic, config-driven)

A single `buildWorkerCommand` builds the argv/env/stdin from an adapter config plus a task. No subprocess in the builder (pure/testable).

```typescript
export interface WorkerAdapterConfig {
  name: string;
  command: string;                  // executable only — shell-free, no embedded args (validated)
  args: string[];                   // base args
  prompt_via: 'arg' | 'stdin' | 'file';
  prompt_arg_flag: string | null;   // prompt_via='arg': flag before the prompt (null = positional last arg)
  prompt_file_flag: string | null;  // prompt_via='file': flag before a temp prompt-file path
  env_allowlist: string[];          // env var NAMES passed through to the subprocess
  timeout_seconds: number;
  enabled: boolean;
}

// Pure: returns the launch plan; the runner (Task 5) executes it via execFile.
// `promptFile` (prompt_via='file') carries BOTH the path the runner must write AND the exact
// contents to write — the builder stays pure (no I/O), the runner does the write/delete (MD-008).
// The path is placed OUTSIDE the captured worktree (under the worker state dir) so it never
// contaminates the diff (MD-003).
export function buildWorkerCommand(
  adapter: WorkerAdapterConfig, task: WorkerTask, worktreePath: string, workerStateDir: string,
): { command: string; args: string[]; env: Record<string, string>; stdin: string | null; promptFile: { path: string; contents: string } | null };
```

- **Output is always the worktree git diff** in Phase 3 (no adapter-specific output formats), so the adapter interface carries no output-parsing config.
- **No invented signatures:** presets ship with conservative defaults and `enabled: false`; the operator sets `command`/`args`/`prompt_via` to match their installed CLI version. The runbook documents this (Task 15).

### Worktree creation, cleanup & isolation rules (`src/workers/worktree.ts`)

All git operations are shell-free `execFile('git', [...])`.

**The enforceable guarantee is structural:** the only thing ever applied to the main workspace is the worktree's git diff (merge gate, Task 9). Everything below is either part of that structural containment or best-effort *detection* layered on top.

- **Create:** resolve the immutable base FIRST — `git -C <workspace_root> rev-parse --verify <base_ref>^{commit}` → `base_sha` (MD-013); reject a `base_ref` that fails to resolve or whose string begins with `-` (argument-injection guard — a leading-`-` ref would be parsed by git as an option; LO-006). Then `git -C <workspace_root> worktree add --detach <worktree_dir>/<task-id> <base_sha>` — **always detached HEAD; no branch ref is ever created** (Phase 3 is detached-only; MD-014). Reject a `worktree_dir` that is empty, `.`, contains a `.git` path segment, resolves equal to `workspace_root`, has any symlink component, or escapes `workspace_root` (MD-011; mirror the symlink/parent-component checks in `src/failover/migrator.ts:149-166`).
- **`worktree_dir`** (default `.aisup-workers/`, relative to `workspace_root`) **must be gitignored** in the main repo. Task 6 verifies the entry exists and the loader warns if missing.
- **Isolated temp `HOME` (real filesystem containment):** the worker subprocess runs with `HOME=<worktree_dir>/<task-id>/.home` (a per-task throwaway dir) injected into its allowlisted env. A trusted CLI that resolves `$HOME` (e.g. writes to `~/.claude`, `~/.claude/settings.local.json`, transcript dirs) lands in the throwaway HOME, not the operator's real one. This is the primary write-containment for the realistic escape vector and is **not** OS sandboxing.
- **Output capture:** worktree-local `git -C <worktree> add -A -N` (intent-to-add so new files appear in the diff — this is the **only** automatic `git add` and it is scoped to the isolated worktree, never the main workspace; MD-012) then `git -C <worktree> diff <base_sha>` → patch; `git -C <worktree> diff --name-only <base_sha>` → changed files (always against the immutable `base_sha`, not the movable `base_ref`; MD-013). No commit. **`.home/` must be excluded from all three calls** (`add`, `diff`, `diff --name-only`) so throwaway-HOME contents can never enter the patch and ride into the operator's real workspace on merge: add a worktree-local `.git/info/exclude` entry for `.home/` **and** pass a `:(exclude).home/` pathspec on the diff/name-only calls (belt-and-suspenders; MD-003). The prompt file (prompt_via='file') lives **outside** the captured tree under `~/.aisup/workers/<id>/`, so it cannot contaminate the diff (MD-003/MD-008).
- **Boundary audit (detection — assumes a quiescent main tree):**
  1. Before dispatch, snapshot the main workspace two ways: (a) `git -C <workspace_root> status --porcelain --ignored` (the `--ignored` flag is mandatory — without it a write to a gitignored path like `.claude/settings.local.json` is invisible) excluding `worktree_dir` → `before`; (b) **expand `security.forbidden_path_globs` against the main workspace and snapshot every matched existing file by existence + size + mtime + content hash (sha256)** — `git status --ignored` reports the *presence* of an ignored path but NOT content changes to a pre-existing ignored file, so a worker modifying an existing `.env`/transcript would otherwise be invisible to the audit (HI-004).
  2. After the worker exits, recompute both → `after`. If `after != before` (the worker modified tracked/untracked/**ignored** files in the *main* tree, or any forbidden-glob-matched file's hash/size/mtime changed), `boundary_ok = false`.
  3. Reject any changed path in the worktree diff that resolves outside the worktree (defense-in-depth; structurally the diff is worktree-scoped).
  4. `boundary_ok === false` ⇒ status `FAILED`, emit `worker.boundary_violation`, **merge blocked**.
  - *Detection caveat (accepted residual — see Autonomous Decision 3):* the audit assumes the operator is not concurrently editing the main tree during a worker run. Arbitrary absolute-path writes **outside `workspace_root` and outside the temp HOME** (e.g. `/tmp`, `/etc`) are **neither prevented nor detected** in Phase 3 — the audit only snapshots the workspace tree and the configured forbidden-path set. The structural diff-scoping still guarantees those writes never reach merge; OS sandboxing is the named deferred hardening to prevent/detect them (HI-007).
- **Artifact sanitization (security) — runs BEFORE any artifact is persisted (HI-002):** sanitize the captured-in-memory patch **before** writing `patch.diff`/`output.json` or embedding `WorkerOutput` in `state.json`. Two distinct checks: (a) **forbidden-path match** — apply `forbidden_path_globs` via `picomatch` against the **`changedFiles` path list** from `captureDiff` (picomatch matches *paths*, not free text); (b) **secret-content match** — a line-oriented regex over the patch *text* (e.g. `/(token|secret|api[_-]?key|password|authorization|bot_token|app_token|signing_secret)\s*[:=]/i`), because the journal's `SECRET_KEY_PATTERN` is `^…$`-anchored to whole object keys and matches nothing in diff lines (MD-004). Signature: `sanitizePatch(changedFiles, patch, forbiddenGlobs)`. A hit ⇒ `REJECTED`, emit `worker.security_denied` carrying only violation categories/paths (never content), and **do not persist the raw patch or raw stdout/stderr tails** — persist only redacted metadata (HI-002). On success, compute `patch_sha256` over the sanitized bytes and persist it for the review→merge integrity check (MD-009).
- **Cleanup:** `git -C <workspace_root> worktree remove --force <path>` on terminal states, governed by `workers.retention`. `worktree remove` is the only destructive git op permitted and is path-validated (realpath, no symlink component) to live under `worktree_dir` — never the main tree. Because workers are detached-only, there is **no worker branch ref to delete** (MD-014). **No `reset`/`clean`/`checkout`/`push`/`commit`/`branch` is ever issued automatically.**

### Output artifact, cross-model review & merge contracts

- **Output artifact** = `WorkerOutput` (above): sanitized patch + redacted tails + changed files + boundary flag + `patch_sha256`. Persisted under `~/.aisup/workers/<id>/` (`patch.diff`, `output.json`) **only after `sanitizePatch` passes** (HI-002); on a sanitizer hit only redacted violation metadata is persisted — never the raw patch or raw stdout/stderr tails.
- **Cross-model review** (`src/workers/review.ts`): build a reviewer prompt from `{task, sanitized patch}` and run the **reviewer adapter via the Task 5 runner in a dedicated throwaway review directory** — NOT the implementation worktree and NOT the main workspace — with the same isolated-`HOME`/allowlisted-env discipline as the implementer and the patch delivered via stdin/file (HI-008). The reviewer is a read-only verdict gate: after it returns, assert the implementation worktree, the main workspace, and `patch_sha256` are unchanged; any reviewer-side filesystem change fails the review closed (`worker.review_failed`, reason `reviewer_side_effect`). Then parse a strict verdict.
  - **Reviewer resolution & `reviewer != implementer` policy (MD-010):** the implementer must resolve to an **enabled** adapter; the reviewer resolves to the configured `default_reviewer`/`by_task_type` reviewer **when that adapter is enabled**, otherwise to any other enabled adapter, otherwise falls back to the implementer with `degraded: true`. A disabled reviewer is treated as *unavailable* (not a config error) — except a `by_task_type` reviewer that explicitly names a disabled adapter, which is rejected. When degraded, behaviour is governed by `review.allow_same_model_review` (default `false` → review cannot pass → `REJECTED` with `worker.review_degraded`; merge blocked). aisup never silently same-model-reviews.
  - **Parse contract (fail-closed, NOT operator-tunable; MD-007):** the reviewer must emit a final verdict token (`APPROVE`/`REJECT`, or a JSON `{verdict}` line). Parse failure ⇒ `verdict='reject'` **always** — there is no fail-open config value — emit `worker.review_failed` with reason `parse_failed`. *Large-patch note:* reviewer adapters should prefer `prompt_via: stdin`/`file` (not a positional `arg`) so a large diff cannot exceed `ARG_MAX`/`E2BIG` (IN-002).
- **Validation gate (H₂)** (`src/workers/validation.ts`): call the existing `runGates(workerGates, { journal: taggedJournal, defaultCwd: worktreePath })` where `workerGates = config.workers.validation_gates.map(g => ({ ...g, cwd: null }))` — **worker validation gates must never carry their own `cwd`** (the engine gives `gate.cwd` precedence over `defaultCwd` at `src/gates/engine.ts:65-67`, so a stray `cwd` would silently validate the wrong tree; HI-001), and the loader also rejects any non-null `validation_gates[*].cwd` (Task 2). Pass a **custom shell-free `GateRunner`** that mirrors `defaultGateRunner` but closes over the worker validation env — allowlisted vars + isolated `HOME=<worktree>/.home`, no ambient `process.env` spread — because the engine's default runner inherits the daemon environment (`:13-29` passes no `env`; HI-005). The engine emits fixed `gate.*` details with no extension point (`:59-103`), so worker validation passes a **wrapping `JournalWriter`** that injects `worker_task_id` into every event's `details` — making per-gate events attributable even under concurrent workers, without modifying the audited engine. The worker layer also emits one summary `worker.validated` / `worker.validation_failed`. **Fail-closed:** no `required` gate configured + `validation.allow_no_validation` false ⇒ validation fails (`no_gates_configured`). A failed required gate ⇒ `REJECTED`, merge blocked. *Operability note (MD-005):* gates run in a fresh nested worktree with no installed deps — Node resolves the parent repo's `node_modules` via upward lookup (the worktree is nested under `workspace_root`); other ecosystems (pnpm/Yarn-PnP/Python venv/Go) require the gate command to self-provision.
- **Merge gate** (`src/workers/merge.ts`): preconditions = status `AWAITING_APPROVAL` **and** `approval.granted === true`. **First re-read `patch_path` and require its sha256 to equal the stored `patch_sha256`** — a mismatch means the artifact drifted from the reviewed/approved bytes ⇒ refuse with `worker.merge_failed` reason `patch_hash_mismatch`, no apply (MD-009). Then `git -C <workspace_root> apply --check <patchPath>` (the clean-apply proof); on success `git -C <workspace_root> apply <patchPath>` → `MERGED`. **No `add`/`commit`/`push`.** Apply-check failure ⇒ `worker.merge_failed` (reason `apply_conflict`); the task stays `AWAITING_APPROVAL` **and approval is reset** (`decided:false, granted:false, by:null, at:null`) so a fresh user approval is required before any retry (HI-006). Approval is required for every merge; there is no config that disables it.

### Worker dispatcher / orchestrator & routing (`src/workers/orchestrator.ts`)

- **Async dispatch (MD-002):** `dispatch()` persists a `QUEUED` worker and **returns its id immediately**; the pipeline runs fire-and-forget in the background, then pauses at `AWAITING_APPROVAL`; `approve` resumes `MERGING → MERGED`. The HTTP/CLI caller never blocks for the worker's runtime (up to `timeout_seconds`, 1800s default); progress is observed via `GET /api/workers/:id` and journal events. The ordered security checkpoints within the pipeline are: `IMPLEMENTED` (capture diff in memory) → `auditBoundary` (fail → `FAILED`) → `sanitizePatch` (fail → `REJECTED`; on pass, persist artifacts + compute `patch_sha256`) → `VALIDATING` (fail → `REJECTED`) → `REVIEWING` (fail/degraded → `REJECTED`) → `AWAITING_APPROVAL`, with `patch_sha256` re-verified at merge (IN-004/HI-002/MD-009). Sanitize precedes both artifact persistence and review so secrets never reach disk or the reviewer CLI.
- **Routing heuristic:** `resolveRouting(task_type, config.workers.routing, adapters)` → `{implementer, reviewer, degraded}`. `by_task_type[task_type]` overrides `default_implementer`/`default_reviewer`. The implementer must resolve to an **enabled** adapter (else dispatch is rejected); the reviewer resolves to the configured reviewer when enabled, else any other enabled adapter, else the implementer with `degraded:true` (MD-010).
- **Concurrency & scheduling (MD-002):** at most `workers.max_concurrent` workers hold a slot. **`QUEUED` and `AWAITING_APPROVAL` (including an apply-conflict worker) do NOT hold a slot** — only the active in-flight phases (`RUNNING`/`VALIDATING`/`REVIEWING`/`MERGING`) count, so a worker awaiting approval for hours never blocks new dispatches. A scheduler pump starts the next `QUEUED` worker whenever a slot frees: on daemon startup/rehydration, and on every transition that vacates a slot — reaching `AWAITING_APPROVAL` or any terminal state. Excess dispatches stay `QUEUED` until pumped; they never stall indefinitely.
- **Cancellation (cooperative; MD-006):** `cancel(id)` records `CANCELLED` and frees the slot immediately; it does **not** kill an in-flight child (the reused `execFile` engine exposes no abort hook). For `RUNNING`/`VALIDATING`/`REVIEWING` the subprocess runs to completion/timeout; on completion the orchestrator sees `status === 'CANCELLED'`, discards the result (no transition), and runs cleanup per `retention`. A late completion can never resurrect a cancelled worker, and the worktree/slot are released.
- **Persistence & rehydration:** worker state lives on disk (atomic write, mirroring `SessionManager.writeState`). On daemon restart, an in-flight **subprocess** phase (`RUNNING`/`VALIDATING`/`REVIEWING`) has no live child to recover → mark `FAILED` with `worker.rehydrated_failed`. **`MERGING` is special (HI-003)** — it performs a main-workspace side effect, so it is reconciled against the patch rather than blindly failed: if `git -C <workspace_root> apply --reverse --check <patchPath>` succeeds the patch is already applied → mark `MERGED` + emit `worker.rehydrated_merged`; else if `git apply --check <patchPath>` succeeds no apply occurred → return to `AWAITING_APPROVAL` (approval reset, reason `merge_interrupted_before_apply`); else (neither) leave `AWAITING_APPROVAL` and emit `worker.merge_failed`/`apply_conflict` for operator resolution. `QUEUED` and `AWAITING_APPROVAL` survive restart and remain actionable. This is the explicit worker rehydration contract.
- **Coexistence:** workers run alongside the single lead session (PRD: one lead session; workers separate). The orchestrator is wired in `src/daemon/index.ts` and gated by `workers.enabled` (default `false`).

### CLI / API / Slack surfaces

- **CLI** (`aisup worker …`, Task 11): `dispatch`, `list`, `status <id>`, `review <id>`, `approve <id>`, `deny <id>`, `cancel <id>`, `logs <id>`. `review <id>` and `logs <id>` are **read-only views backed by `GET /api/workers/:id`** — `review` formats the stored `state.review` verdict, `logs` formats the sanitized stdout/stderr tails + artifact paths (no rerun, no extra API route; LO-007). Online via daemon API; mirrors the online/offline pattern in `src/cli/commands/gate.ts`.
- **API** (Task 12): `POST /api/workers`, `GET /api/workers`, `GET /api/workers/:id`, `POST /api/workers/:id/approve`, `POST /api/workers/:id/deny`, `POST /api/workers/:id/cancel`.
- **Slack** (Task 13, **optional/deferrable**): `!worker status`, `!worker approve <id>`, `!worker deny <id>` — worker actions are **subcommands of a single new `worker` command** (mirroring the existing `!gate status` dispatch at `src/slack/service.ts:390-395`), so only `worker` is added to `KNOWN_COMMANDS`. **Do NOT add top-level `!approve`/`!deny`** — `!deny` already exists as the permission-denial command (`src/slack/commands.ts`; `service.ts:380-388`) and a collision would regress the verified Phase 2 permission flow (MD-001). Reuses the `ConfirmationStore` pattern. Marked optional per the prompt — may be deferred without blocking Phase 3.

### Failure modes & recovery behavior

| Failure | Detection | Behavior |
|---|---|---|
| Adapter not found / not executable | `validateRunner`-style resolve before dispatch | `FAILED`, `worker.failed` (reason `adapter_unresolved`) |
| Adapter timeout | `execFile` timeout (`killed`) | `FAILED`, `worker.failed` (`timed_out`) |
| Worktree create fails (dirty base, collision) | git exit ≠ 0 | `FAILED`, `worker.failed` (`worktree_create_failed`) |
| Worker writes outside worktree | boundary audit | `FAILED`, `worker.boundary_violation`, merge blocked |
| Secret/forbidden path in patch | patch sanitizer (before persist) | `REJECTED`, `worker.security_denied`, raw patch/tails not persisted, merge blocked |
| Required gate fails | `runGates` result | `REJECTED`, `worker.validation_failed` |
| Review rejects / parse fails | reviewer verdict (fail-closed) | `REJECTED`, `worker.review_failed` |
| Reviewer mutates worktree/main tree | post-review side-effect audit | `REJECTED`, `worker.review_failed` (`reviewer_side_effect`) |
| Only one model available | routing degraded + `allow_same_model_review=false` | `REJECTED`, `worker.review_degraded` |
| Patch artifact drift before merge | `patch_sha256` mismatch | `worker.merge_failed` (`patch_hash_mismatch`); no apply; stays `AWAITING_APPROVAL`, approval reset |
| `git apply --check` conflict **or a `git apply` runtime error after a passing check** (IN-101) | merge gate | non-terminal `worker.merge_failed` (`apply_conflict`); stays `AWAITING_APPROVAL`, **approval reset** (fresh approval required) |
| Cancel during in-flight run | cooperative cancel | `CANCELLED` immediately, slot freed; subprocess runs to timeout, late result discarded |
| Daemon restart mid-run | rehydration | subprocess phases (`RUNNING/VALIDATING/REVIEWING`) → `FAILED` (`worker.rehydrated_failed`); `MERGING` reconciled against the patch → `MERGED`/`AWAITING_APPROVAL` (HI-003); `AWAITING_APPROVAL`/`QUEUED` preserved |

## Config Contract

New top-level `workers` section. Off by default. Add to `src/config/schema.ts`, `src/config/defaults.ts`, and `validateConfig()`'s explicit return in `src/config/loader.ts` (Task 2). Exact defaults:

```yaml
workers:
  enabled: false
  workspace_root: null            # null ⇒ resolved at dispatch: --workspace > this > active lead session cwd > error; must be a git repo
  worktree_dir: ".aisup-workers"  # relative to workspace_root; must be gitignored; not '.', '.git', or == workspace_root
  max_concurrent: 2               # workers are detached-only — no branch ref is created (MD-014)
  retention:
    keep_merged: false            # remove worktree after merge
    keep_rejected: true           # keep rejected/failed worktrees for inspection
    max_age_hours: 168            # GC worktrees older than this on daemon start
  security:
    env_allowlist: ["PATH", "HOME", "LANG"]  # global default; effective allowlist = union(security.env_allowlist, adapter.env_allowlist) (Task 4, LO-002)
    boundary_audit: true          # must be true; false is rejected
    forbidden_path_globs:         # used by BOTH the patch sanitizer and the pre-existing-ignored-file boundary snapshot (HI-004)
      - "**/.claude/settings.local.json"
      - "**/.claude/transcripts/**"  # transcripts (LO-001)
      - "**/*.jsonl"                 # transcript captures (LO-001)
      - "**/*.tmux-capture"          # tmux pane captures (LO-001)
      - "**/*.pem"
      - "**/.env"
      - "**/.env.*"
  adapters:
    codex:
      command: "codex"
      args: []
      prompt_via: "arg"
      prompt_arg_flag: null
      prompt_file_flag: null
      env_allowlist: ["PATH", "HOME"]
      timeout_seconds: 1800
      enabled: false
    gemini:
      command: "gemini"
      args: []
      prompt_via: "arg"
      prompt_arg_flag: null
      prompt_file_flag: null
      env_allowlist: ["PATH", "HOME"]
      timeout_seconds: 1800
      enabled: false
    local:
      command: ""                 # operator-provided (e.g. ollama, llama-cli)
      args: []
      prompt_via: "stdin"
      prompt_arg_flag: null
      prompt_file_flag: null
      env_allowlist: ["PATH", "HOME"]
      timeout_seconds: 1800
      enabled: false
  routing:
    default_implementer: "codex"
    default_reviewer: "gemini"
    by_task_type: {}              # e.g. { bugfix: { implementer: codex, reviewer: gemini } }
  review:
    allow_same_model_review: false  # the only review knob; parse failure ALWAYS rejects (fail-closed, not tunable — MD-007)
  validation_gates: []            # GateCommandConfig[] run with cwd=worktree (H₂); same shape as gates.gates BUT each gate's `cwd` MUST be null/omitted (HI-001)
  validation:
    allow_no_validation: false    # fail-CLOSED: with no REQUIRED gate configured, validation FAILS — there is
                                  # no zero-deterministic-check path to merge. Set true to explicitly opt out.
  merge:
    require_approval: true        # MUST be true; loader rejects false
    apply_check_required: true
```

**Validation rules (loader, Task 2):**
- `workers.enabled` non-`false` ⇒ require at least one adapter `enabled` and a `routing.default_implementer` that resolves to an **enabled** adapter (MD-010).
- **Fail-closed validation:** when `workers.enabled` and `validation.allow_no_validation` is `false` (default), `validation_gates` must contain at least one `required: true` gate; otherwise the config is rejected. (This closes the empty-gates-fail-open hole: `runGates` returns `passed: true` for an empty list — `src/gates/engine.ts:53-57` — so an unguarded empty list would silently "validate" with zero deterministic checks.) The runtime additionally fails closed (see Task 7) if it ever reaches validation with no required gate and `allow_no_validation` is `false`.
- `workspace_root` resolution order (config + runtime): a dispatch-time `--workspace <path>` override → `config.workers.workspace_root` → the active lead session's `cwd` (`sessionManager.getActiveSession()?.cwd`) → **error** (dispatch rejected) if none resolves. The resolved root, when set in config, must be an existing directory; at runtime it must be a git repo (`git -C <root> rev-parse --is-inside-work-tree`).
- `worktree_dir` must be a relative path with no `..` segments and no leading `/`, and must NOT be empty, `.`, contain a `.git` path segment, or resolve equal to `workspace_root` (MD-011).
- Each adapter `command` must be shell-free (no whitespace) — reuse the gate `command` validator pattern in `validateGates`; empty `command` allowed only when that adapter is `enabled: false`.
- `prompt_via` ∈ {`arg`,`stdin`,`file`}; `timeout_seconds` positive integer; `env_allowlist` an array of env-var-name strings (`^[A-Za-z_][A-Za-z0-9_]*$`).
- `routing.default_implementer` must name a defined, **enabled** adapter (when `workers.enabled`); `default_reviewer` and every `by_task_type` entry must name a defined adapter. A disabled `default_reviewer` is allowed (treated as unavailable → reviewer falls back per the runtime routing rule); a `by_task_type` reviewer naming a **disabled** adapter is rejected (MD-010).
- `base_ref` (config/task/`--base`) must not begin with `-` and must resolve via `git rev-parse --verify <base_ref>^{commit}` at dispatch — argument-injection guard + immutable-base capture (LO-006/MD-013).
- `validation_gates` validated by the existing `validateGates`, **plus a worker-specific rule: every entry's `cwd` must be null/omitted** so worker validation always runs against the worktree (HI-001).
- `review` accepts only `allow_same_model_review`; a config carrying the **removed** `review.parse_failure_verdict` or `review.require_cross_model` is **rejected** with a clear error (parse failure is always fail-closed; same-model fallback is governed by `allow_same_model_review` only) — so a user cannot silently believe they enabled fail-open review (MD-007).
- `merge.require_approval` **must be `true`** — a `false` value is a config error (no auto-merge).
- `security.boundary_audit` must be `true`.

**Do not invent** account paths, tokens, model names, or provider CLI flags. The `codex`/`gemini`/`local` presets are structural placeholders (disabled by default) the operator fills in; real invocation is verified only via host-gated tests.

## File Structure

- `src/workers/types.ts` (create) — `WorkerTask`, `WorkerState`, `WorkerStatus`, `WorkerOutput`, `ReviewVerdict`. Pure types.
- `src/workers/store.ts` (create) — atomic read/write/patch of worker state under `~/.aisup/workers/<id>/`; `list()`; mirrors `SessionManager.writeState`.
- `src/workers/adapter.ts` (create) — `buildWorkerCommand` (pure) + env-allowlist application + routing resolver `resolveRouting`.
- `src/workers/runner.ts` (create) — shell-free `execFile` execution (cwd=worktree, timeout, tail capture); injectable runner.
- `src/workers/worktree.ts` (create) — git worktree create/diff/audit/sanitize/remove; all `execFile('git', …)`.
- `src/workers/validation.ts` (create) — H₂ wrapper over `runGates` with `cwd=worktree`.
- `src/workers/review.ts` (create) — reviewer prompt build, run, verdict parse, cross-model policy.
- `src/workers/merge.ts` (create) — `git apply --check` + `git apply`; approval precondition.
- `src/workers/orchestrator.ts` (create) — pipeline driver, routing, concurrency, persistence, rehydration.
- `src/config/schema.ts` (modify) — add `WorkersConfig` + sub-interfaces; add to `AisupConfig`.
- `src/config/defaults.ts` (modify) — add `workers` defaults.
- `src/config/loader.ts` (modify) — validate `workers`; add to `validateConfig` return.
- `src/journal/types.ts` (modify) — add the `worker.*` event union.
- `src/daemon/index.ts` (modify) — construct + wire the orchestrator; rehydrate workers; shutdown.
- `src/daemon/server.ts` (modify) — `/api/workers` routes + `DaemonServerOptions` wiring.
- `src/cli/commands/worker.ts` (create) — `aisup worker …` commands.
- `src/cli/index.ts` (modify) — register the `worker` command group.
- `src/slack/service.ts`, `src/slack/commands.ts` (modify, optional Task 13) — `!worker status`/`!worker approve`/`!worker deny` subcommands.
- Tests created/modified per task (see below).
- `docs/prd/2026-04-29-ai-supervisor.md`, `docs/runbook.md`, `.gitignore` (modify) — docs/reconciliation.

## Implementation Tasks

### Task 1: PRD & Status Reconciliation for Phase 3

**Objective:** Reconcile the PRD with verified Phase 1/2 reality and mark Phase 3 in progress, so stale "Phase 2 in progress" language cannot become an implementation source of truth. Doc-only, first task before code (mirrors Phase 2's Task 0).

**Files:**
- Modify: `docs/prd/2026-04-29-ai-supervisor.md`

**Key Decisions / Notes:**
- **Verify before editing (update only genuinely stale text):** grep the PRD for status-language variants first. As of this plan's authoring the stale rows are confirmed present — `grep -niE "phase 2.*in progress|in progress.*phase 2"` matches the 2026-06-01 note ("Phase 2 scope (in progress)") and the Feature Inventory rows for D₂/F/H₁/K (PRD lines ~124, 273, 275, 277, 281). Edit exactly those; if a later run finds them already corrected, this becomes verification-only (no edits) and the task records that.
- In the 2026-06-01 reconciliation note, change the "Phase 2 scope (in progress)" bullet to state Phase 2 (D₂, F, H₁, K) is **implemented and verified** (cite the Phase 2 plan VERIFIED / Round 3 CLEAN review), and that **Phase 3 (G, H₂) is now in progress**.
- Feature Inventory table: D₂/F/H₁/K `In progress` → `Implemented (Phase 2)`; **G** and **H₂** `Approved` → `In progress (Phase 3)`.
- Do not alter Phase 4 rows or out-of-scope items. `Trivial:` does not apply (doc edit, but it touches status semantics — verify by re-reading, no test).

**Definition of Done:**
- [ ] No occurrence of "Phase 2" paired with "in progress" remains in the PRD (verify by grep).
- [ ] Feature Inventory shows G and H₂ as "In progress (Phase 3)" and D₂/F/H₁/K as Implemented.
- [ ] Verify: `grep -niE "phase 2.*in progress|in progress.*phase 2" docs/prd/2026-04-29-ai-supervisor.md` returns nothing.

### Task 2: Worker Config & Event Contract Baseline (W-C1)

**Objective:** Establish the `workers` config section (schema + defaults + loader validation) and the `worker.*` journal event union in one pass, before feature tasks depend on them (mirrors Phase 2's C1). Feature tasks then consume one contract.

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/journal/types.ts`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/journal/writer.test.ts`

**Key Decisions / Notes:**
- Add `WorkersConfig`, `WorkerAdapterConfig`, `WorkerRoutingConfig`, `WorkerReviewConfig`, `WorkerValidationConfig`, `WorkerRetentionConfig`, `WorkerSecurityConfig`, `WorkerMergeConfig` to `schema.ts`; add `workers: WorkersConfig` to `AisupConfig`.
- Add the `workers` defaults block (see Config Contract) to `CONFIG_DEFAULTS`.
- In `loader.ts`: add `validateWorkers(merged.workers)` enforcing every rule in the Config Contract; include `workers` in the explicit `validateConfig` return object (typecheck must fail if dropped — follows the C1 pattern at `loader.ts:206-221`). Reuse the gate `command` shell-free check for adapter commands. **Critical rules:** (a) `merge.require_approval` must be `true`; (b) `security.boundary_audit` must be `true`; (c) when `enabled` and `validation.allow_no_validation` is `false`, `validation_gates` must include ≥1 `required` gate (closes the empty-gates-fail-open hole); (d) `worktree_dir` relative, no `..`, no leading `/`, and **not** empty/`.`/`.git`-segment/`== workspace_root` (MD-011); (e) every `validation_gates[*].cwd` is null/omitted (HI-001); (f) `default_implementer` resolves to an **enabled** adapter and a `by_task_type` reviewer never names a **disabled** adapter (MD-010); (g) `base_ref` (config default) has no leading `-` (LO-006). There is no `review.parse_failure_verdict` or `review.require_cross_model` field — both were removed (MD-007); `review.allow_same_model_review` is the only review knob.
- Add to the `EventType` union (journal/types.ts), grouped under a `// Workers` comment — single canonical family, no duplicates of existing `gate.*`:
  `worker.queued`, `worker.dispatched`, `worker.completed`, `worker.failed`, `worker.validated`, `worker.validation_failed`, `worker.review_started`, `worker.review_passed`, `worker.review_failed`, `worker.review_degraded`, `worker.awaiting_approval`, `worker.approved`, `worker.denied`, `worker.merge_started`, `worker.merged`, `worker.merge_failed`, `worker.boundary_violation`, `worker.security_denied`, `worker.cancelled`, `worker.cleanup`, `worker.rehydrated_failed`, `worker.rehydrated_merged`.
  (`worker.rehydrated_merged` is emitted only by the `MERGING` rehydration reconciliation when a restart-interrupted apply is found already applied — HI-003. Reason strings like `reviewer_side_effect`, `patch_hash_mismatch`, and `merge_interrupted_before_apply` ride inside existing `worker.review_failed`/`worker.merge_failed` details — they are NOT new event types.)
  (Lifecycle: `worker.queued` on create → `worker.dispatched` when execution begins → `worker.completed` when the IMPLEMENTED diff is captured. There is no separate `worker.running` — `worker.dispatched` marks the RUNNING-phase start, avoiding a redundant third lifecycle event.)
- Worker validation reuses `gate.started`/`gate.passed`/`gate.failed`/`gate.timeout`/`gate.run_completed` with a `worker_task_id` detail injected by a wrapping writer (Task 7); it does NOT add `worker.gate_*` shapes.

**Definition of Done:**
- [ ] `loadConfig` returns a fully-populated `workers` section for an empty config (defaults) and for a custom config.
- [ ] Each invalid worker config throws a clear `Config validation error`: `merge.require_approval: false`; `security.boundary_audit: false`; adapter `command` with a space; unknown routing adapter; `worktree_dir` containing `..`; `worktree_dir` of `.` or `.git`; a `validation_gates` entry with a non-null `cwd`; `default_implementer` naming a disabled adapter; a `by_task_type` reviewer naming a disabled adapter; `base_ref` beginning with `-`; a config carrying the removed `review.parse_failure_verdict` (or `review.require_cross_model`); `enabled: true` with `validation.allow_no_validation: false` and no required `validation_gates`.
- [ ] Typecheck fails if any `workers` sub-section is omitted from the `validateConfig` return.
- [ ] All new `worker.*` event types are accepted by the journal writer; secret-key rejection still applies to worker event details.
- [ ] Verify: `npm run typecheck && npx vitest run tests/config/loader.test.ts tests/journal/writer.test.ts`

### Task 3: Worker Task Contract & State Store

**Objective:** Provide the worker type contract and an atomic on-disk state store so every later module reads/writes one canonical `WorkerState`.

**Files:**
- Create: `src/workers/types.ts`
- Create: `src/workers/store.ts`
- Create: `tests/workers/store.test.ts`

**Key Decisions / Notes:**
- `types.ts` exactly as in the Architecture section. Confirm no `WorkerStatus` value collides with `SessionStatus`.
- `store.ts`: `WorkerStore` class with `stateDir` (default `~/.aisup/workers`); `create(task)`, `read(id)`, `patch(id, partial)`, `list()`, `dir(id)`. Atomic write via tmp+rename, mode `0o600`/dir `0o700` — mirror `SessionManager.writeState` (`src/session/manager.ts:65-72`). `patch` bumps `updated_at`.
- **Path-safety:** worker ids are generated UUIDs; `read`/`patch`/`dir` validate the id against a UUID regex before joining it into `stateDir` (reject any id with `/`, `..`, or non-UUID shape) so a crafted id cannot traverse out of `stateDir`.
- `list()` reads all `<id>/state.json` under `stateDir`; tolerate malformed files (skip).

**Definition of Done:**
- [ ] `create` persists a `QUEUED` `WorkerState`; `read` round-trips it; `patch` updates fields + `updated_at` and leaves others intact; `list` returns all persisted workers and skips a corrupt entry.
- [ ] A non-UUID / traversal id (`../x`, `a/b`) is rejected by `read`/`patch`/`dir`.
- [ ] `WorkerStatus` and `SessionStatus` are disjoint — `grep -oE "'[A-Z_]+'" src/workers/types.ts` ∩ the `SessionStatus` union in `src/session/types.ts` is empty (assert in a test or document the grep result).
- [ ] State files are written `0o600` under a `0o700` dir.
- [ ] Verify: `npx vitest run tests/workers/store.test.ts`

### Task 4: Worker Adapter Builder & Routing Resolver

**Objective:** Pure construction of a worker subprocess launch plan (argv/env/stdin) from adapter config + task, and routing resolution from task type — no subprocess, no I/O.

**Files:**
- Create: `src/workers/adapter.ts`
- Create: `tests/workers/adapter.test.ts`

**Key Decisions / Notes:**
- `buildWorkerCommand(adapter, task, worktreePath, workerStateDir)` per the interface: assemble `args` from `adapter.args` plus prompt delivery — `arg` (append `[prompt_arg_flag, prompt]` or positional `prompt`), `stdin` (return `stdin: prompt`), `file` (return `promptFile: { path, contents }` where `path` is under `workerStateDir` — **outside the captured worktree**, MD-003 — and `contents` is the exact prompt text, plus args `[prompt_file_flag, path]`). The builder stays pure: it returns `{ path, contents }` (both are mandatory return fields — `contents` is the exact prompt text); the runner (Task 5) performs the write/delete (MD-008).
- Env: build `{}` then copy only the **effective allowlist = union(`security.env_allowlist`, `adapter.env_allowlist`)** names present in `process.env` (the orchestrator composes the union before build; LO-002); never spread full `process.env`. Then **override `HOME`** with the per-task isolated home (`<worktreePath>/.home`, passed in by the caller) so a CLI resolving `$HOME` writes into the throwaway home, not the operator's real one. Nothing secret is included implicitly.
- `resolveRouting(taskType, routing, adapters)` → `{ implementer, reviewer, degraded }`: `by_task_type` override → defaults; the implementer must be an **enabled** adapter; the reviewer is the configured reviewer when **enabled**, else any other enabled adapter (`!= implementer`), else `reviewer = implementer` with `degraded:true` (caller enforces `allow_same_model_review`). A `by_task_type` reviewer naming a disabled adapter is rejected upstream by the loader (MD-010).
- Pure functions only; no `execFile`, no `fs`.

**Definition of Done:**
- [ ] `arg`/`stdin`/`file` prompt delivery each produce the documented argv/stdin/promptFile; for `file` the returned `promptFile.path` is under `workerStateDir` (not the worktree) and `promptFile.contents` equals the prompt; env contains only effective-allowlist names (a non-allowlisted `process.env` var is excluded; a name present only in `security.env_allowlist` IS included — proves the union).
- [ ] `resolveRouting` honours `by_task_type` over defaults, returns a reviewer `!= implementer` when a second enabled adapter exists, treats a disabled configured reviewer as unavailable and falls back, and flags `degraded` when only one enabled adapter remains.
- [ ] Verify: `npx vitest run tests/workers/adapter.test.ts`

### Task 5: Worker Subprocess Runner

**Objective:** Execute a built launch plan as a shell-free, timed `execFile` subprocess in the worktree, capturing tail-truncated stdout/stderr — mirroring the gate engine's `defaultGateRunner`.

**Files:**
- Create: `src/workers/runner.ts`
- Create: `tests/workers/runner.test.ts`

**Key Decisions / Notes:**
- `runWorker(plan, opts)` uses `execFile(plan.command, plan.args, { cwd: opts.cwd, timeout, env: plan.env, maxBuffer })` — reuse the `MAX_BUFFER`/`GATE_OUTPUT_TAIL_LIMIT`/`timedOut` handling from `src/gates/engine.ts:13-29`. `plan.env` already carries the isolated `HOME` (Task 4). When `plan.stdin` is set, write it to the child's stdin and close; when `plan.promptFile` is set (`{ path, contents }`, with `path` under the worker state dir — **outside** the worktree), write `contents` to `path` before spawn and **delete it after the child exits** (`finally`), regardless of success/timeout, so prompt text is not left on disk and never enters the worktree diff (MD-008/MD-003).
- Never pass a shell; never interpolate the prompt into a command string. Returns `{ code, stdout, stderr, timedOut }` (tail-truncated).
- Injectable runner param (default real `execFile`) so tests assert shell-free invocation without spawning real CLIs — include one real-`execFile` test using a trivial command (e.g. `node -e`) to prove no shell, like `tests/gates/engine.test.ts`.

**Definition of Done:**
- [ ] A real `execFile` run (no shell) captures stdout, honours `cwd`, and a sleeping command past `timeout` yields `timedOut: true` with `code: null`.
- [ ] `stdin` prompt delivery reaches the child; output tails are truncated to the limit.
- [ ] A `file` prompt writes `promptFile.contents` to `promptFile.path` (asserted to be under `workerStateDir`, outside the worktree per MD-003) before the child runs (assert content present), and removes it after the run — including on timeout.
- [ ] A prompt containing shell metacharacters is passed literally (no expansion) — proves shell-free.
- [ ] Verify: `npx vitest run tests/workers/runner.test.ts`

### Task 6: Worktree Lifecycle & Workspace-Boundary Enforcement

**Objective:** Create/diff/cleanup isolated git worktrees and enforce the security boundary: the only merge candidate is the worktree diff, escapes are detected, and secrets/forbidden paths are rejected. This is the isolation-critical task.

**Files:**
- Create: `src/workers/worktree.ts`
- Create: `tests/workers/worktree.test.ts`
- Modify: `.gitignore`

**Key Decisions / Notes:**
- All git via `execFile('git', [...])` — shell-free. Functions:
  - `resolveBaseSha({workspaceRoot, baseRef})` → `base_sha` via `git rev-parse --verify <baseRef>^{commit}`; reject a `baseRef` beginning with `-` BEFORE the call (argument-injection guard; LO-006). The orchestrator stores both `base_ref` and the resolved `base_sha` (MD-013).
  - `createWorktree({workspaceRoot, worktreeDir, baseSha, taskId})` → detached worktree at `<worktreeDir>/<taskId>` from `baseSha`, plus `<worktree>/.home` for the isolated HOME, and a worktree-local `.git/info/exclude` entry for `.home/` (MD-003). **No branch ref is created** (detached-only; MD-014).
  - `captureDiff({worktree, baseSha})` → `{patch, changedFiles}`: worktree-local `git add -A -N` (the only automatic `git add`, scoped to the worktree — MD-012) then `git diff <baseSha> -- ':(exclude).home/'` and `git diff --name-only <baseSha> -- ':(exclude).home/'`. `.home/` is excluded via BOTH `.git/info/exclude` and the `:(exclude)` pathspec so HOME contents can never enter the patch (MD-003); diffs are always against the immutable `baseSha` (MD-013).
  - `snapshotMainTree({workspaceRoot, worktreeDir, forbiddenPathGlobs})` → opaque snapshot = `git status --porcelain --ignored` (excluding `worktreeDir`) PLUS, for every existing file matched by expanding `forbiddenPathGlobs` against the workspace, its existence+size+mtime+**sha256 content hash** — `git status` alone cannot see content changes to a pre-existing ignored file (HI-004).
  - `auditBoundary({workspaceRoot, worktreeDir, before})` → `boolean` (false if the after-snapshot differs in status OR any forbidden-glob file's hash/size/mtime changed). Also reject diff paths resolving outside the worktree.
  - `sanitizePatch(changedFiles, patch, forbiddenGlobs)` → `{ok, violations}` — takes `changedFiles` because `picomatch` matches PATHS (MD-004): (a) glob-match `changedFiles` against `forbiddenGlobs` via `picomatch` (direct dep, `package.json:23`); (b) line-scan the patch TEXT with a content-oriented secret regex `/(token|secret|api[_-]?key|password|authorization|bot_token|app_token|signing_secret)\s*[:=]/i`. The journal's `SECRET_KEY_PATTERN` is `^…$`-anchored to whole object keys and matches nothing in diff lines, so the keyword list is duplicated here with a comment linking to `src/journal/writer.ts:5` (MD-004). `violations` carry only categories/paths, never content.
  - `patchSha256(patch)` → hex digest over the sanitized bytes, for the merge integrity check (MD-009).
  - `removeWorktree({workspaceRoot, path})`.
- **`createWorktree` rejects** a `worktreeDir` that is empty/`.`/contains a `.git` segment/resolves equal to `workspaceRoot`/has a symlink component/escapes `workspaceRoot` (MD-011; mirror `src/failover/migrator.ts:149-166`), so a reserved or symlinked worktree dir cannot redirect writes.
- **Persist-after-sanitize ordering (HI-002):** the orchestrator (Task 10) runs `auditBoundary` then `sanitizePatch` **before** persisting `patch.diff`/`output.json` or embedding `WorkerOutput`; on a sanitizer hit only redacted violation metadata is written — never the raw patch or raw stdout/stderr tails. This task exposes the pure checks; Task 10 enforces the order.
- `removeWorktree` validates `path` realpath is under `worktreeDir` with no symlink component before `git worktree remove --force`; never operates on the main tree. No `reset`/`clean`/`checkout`/`commit`/`push`/`branch` anywhere.
- Add `.aisup-workers/` to the repo `.gitignore` and have the module verify the entry exists (warn-level via journal if missing); the merge/diff path must never surface worktree files in the main repo status.

**Definition of Done:**
- [ ] Creating a worktree, writing a file in it, and `captureDiff` yields a patch containing that file (excluding `.home/`); the main repo `git status --ignored` is unchanged by the worktree.
- [ ] A `$HOME`-resolved write into `<worktree>/.home/` (e.g. `.home/.claude/settings.local.json`) produces **no** entry in `WorkerOutput.patch` text AND no entry in `WorkerOutput.changed_files` (both asserted via `captureDiff`, since merge depends on both staying clean) — proves the `.home/` exclusion closes the merge path, not just real-home safety (MD-003).
- [ ] A new untracked file created in the worktree appears in the patch/`changedFiles` (intent-to-add works) while the **main** workspace index/status is unchanged except for the ignored `worktree_dir` (MD-012).
- [ ] `captureDiff` still diffs against the stored `base_sha` after the source branch is advanced post-creation (MD-013).
- [ ] A worker that writes a file into the main workspace (outside the worktree) makes `auditBoundary` return `false`.
- [ ] A worker that writes to a **gitignored** main-tree path (e.g. `.claude/settings.local.json`) makes `auditBoundary` return `false` (proves `--ignored` is in effect).
- [ ] Modifying the **content** of a pre-existing ignored `.env` (matched by `forbidden_path_globs`) makes `auditBoundary` return `false` even though `git status --porcelain --ignored` is byte-identical before/after (proves the content-hash snapshot; HI-004).
- [ ] A worker that writes to `$HOME` lands in the isolated `<worktree>/.home`, not the real home (assert the real `~/.claude` is untouched).
- [ ] `createWorktree` refuses a symlinked `worktree_dir`, and refuses `worktree_dir` of `.` or `.git` (MD-011).
- [ ] `resolveBaseSha` refuses a `base_ref` beginning with `-` (e.g. `--help`) before any `git` command runs (LO-006).
- [ ] `sanitizePatch(changedFiles, patch, globs)` flags a patch that adds `.env` / a `*.pem` / a transcript `*.jsonl` (via `changedFiles`) and flags a secret **assignment line** (via the content regex); a clean patch passes (MD-004/LO-001).
- [ ] `removeWorktree` refuses a path outside `worktree_dir`.
- [ ] Verify: `npx vitest run tests/workers/worktree.test.ts` (marker `@requires_git`).

### Task 7: Worker Validation Gate Integration (H₂)

**Objective:** Run the configured validation gates against the worker's worktree using the existing gate engine, blocking merge on failure. This is Feature H₂.

**Files:**
- Create: `src/workers/validation.ts`
- Create: `tests/workers/validation.test.ts`

**Key Decisions / Notes:**
- `validateWorkerOutput({gates, worktree, workerHome, journal, taskId, allowNoValidation})` calls `runGates(workerGates, { journal: taggedJournal, defaultCwd: worktree, runner: workerGateRunner })` from `src/gates/engine.ts` — do NOT reimplement gate execution. `workerGates = gates.map(g => ({ ...g, cwd: null }))` so no gate can override `defaultCwd` (the engine gives `gate.cwd` precedence at `:65-67`; HI-001). `workerGateRunner` is a **custom shell-free `GateRunner`** mirroring `defaultGateRunner` (`:13-29`) but closing over the worker validation env — the union allowlist + isolated `HOME=workerHome` (`<worktree>/.home`), **no ambient `process.env` spread** — because the engine's default runner inherits the daemon environment (HI-005). Its signature matches `GateRunner` exactly — `(command, args, { cwd, timeoutMs }) => Promise<{ code, stdout, stderr, timedOut }>` — and it passes the captured `workerEnv` to `execFile(command, args, { cwd, timeout: timeoutMs, env: workerEnv, maxBuffer })`; `env` is supplied via the closure (the `GateRunner` `opts` carries only `cwd`/`timeoutMs`), so no engine type change is needed. **Pass a wrapping `JournalWriter` (`taggedJournal`)** that injects `worker_task_id: taskId` into every emitted event's `details` before delegating to the real writer, so concurrent workers' per-gate `gate.*` events stay attributable (the engine has no detail-injection hook — `:59-103`).
- **Fail-closed no-gates guard:** if `gates` has no `required: true` entry and `allowNoValidation` is false, skip `runGates`, emit `worker.validation_failed` reason `no_gates_configured`, return `{passed:false}`. Never treat an empty/optional-only gate list as a pass (mirrors the loader rule in Task 2).
- Map `GateRunResult.passed` → emit `worker.validated` (passed) or `worker.validation_failed` (with `failed_gates`); return `{passed, failed_gates}`.
- Gates run with `cwd = worktree` so tests execute against the worker's changes in isolation, not the main tree.
- **Fresh-worktree deps (MD-005):** gates run in a clean nested worktree with no installed deps. Node gates resolve the parent repo's `node_modules` via upward lookup (the worktree is nested under `workspace_root`); pnpm/Yarn-PnP/Python venv/Go gates must self-provision. Documented in the runbook (Task 15).

**Definition of Done:**
- [ ] Passing gates → `worker.validated`, `{passed:true}`; a failing required gate → `worker.validation_failed` with the gate name, `{passed:false}`.
- [ ] No-required-gate list with `allow_no_validation:false` → `worker.validation_failed` reason `no_gates_configured`, `{passed:false}`, and `runGates` is NOT called (fail-closed; assert the empty list never returns a pass).
- [ ] Every emitted `gate.*` event for a worker run carries the run's `worker_task_id` in `details` (assert via a spy journal); two concurrent runs' events are attributable to distinct ids.
- [ ] Gates execute with `cwd` set to the worktree (assert via an injected gate runner capturing `cwd`).
- [ ] A gate whose config sets `cwd` to a non-worktree path executes with `cwd = worktree` anyway (normalized to null before `runGates`); the wrong tree is never validated (HI-001).
- [ ] A validation gate that prints `$HOME` (`node -e 'process.stdout.write(process.env.HOME)'`) captures the isolated `<worktree>/.home`, not the daemon's real home (HI-005).
- [ ] A gate that requires a dependency resolvable in the parent repo's `node_modules` succeeds in the nested worktree, proving upward resolution — not just a non-zero exit (MD-005).
- [ ] Verify: `npx vitest run tests/workers/validation.test.ts`

### Task 8: Cross-Model Review Flow

**Objective:** Review the worker patch with a *different* model and produce a strict verdict, enforcing the reviewer≠implementer policy and failing closed on parse errors.

**Files:**
- Create: `src/workers/review.ts`
- Create: `tests/workers/review.test.ts`

**Key Decisions / Notes:**
- `reviewWorkerOutput({task, output, reviewerAdapter, runner, review, journal, reviewDir})`: build a reviewer prompt embedding the task + **already-sanitized** patch and an explicit instruction to end with `VERDICT: APPROVE` or `VERDICT: REJECT` plus findings; run via the Task 5 runner in a **dedicated throwaway `reviewDir`** — `~/.aisup/workers/<id>/review/`, under the worker state dir, **outside both the implementation worktree and the main workspace** so it cannot contaminate the diff (NOT the implementation worktree, NOT the main workspace) — with an isolated `HOME`/allowlisted env; parse the trailing verdict (HI-008). The orchestrator creates `reviewDir` before review and removes it on terminal-state cleanup per `retention` (LO-101).
- Reviewer prompt is delivered using the reviewer adapter's `prompt_via` (reuse `buildWorkerCommand`); **prefer `stdin`/`file` over a positional `arg`** so a large patch cannot exceed `ARG_MAX`/`E2BIG` (IN-002). The patch is sanitized by Task 6 BEFORE embedding so secrets are never sent to the reviewer CLI.
- **Read-only gate (HI-008):** snapshot `reviewDir` and assert the implementation worktree + main workspace before and after the reviewer runs; if the reviewer wrote anything outside `reviewDir`, or `output.patch_sha256` changed, fail closed — `verdict:'reject'`, `worker.review_failed` reason `reviewer_side_effect`.
- Cross-model policy: if `reviewerAdapter.name === task.implementer` → `degraded:true`; when `review.allow_same_model_review === false`, emit `worker.review_degraded` and return `verdict:'reject'` **without running the model**. Otherwise run.
- Parse failure ⇒ **always** `verdict:'reject'` (fail-closed; there is no fail-open config — MD-007), emit `worker.review_failed` reason `parse_failed`. Emit `worker.review_started` then `worker.review_passed`/`worker.review_failed`.
- Injectable runner so tests use a deterministic fake reviewer (no host CLI).

**Definition of Done:**
- [ ] A fake reviewer returning `VERDICT: REJECT` over a seeded-bug patch yields `verdict:'reject'` and `worker.review_failed`; `VERDICT: APPROVE` yields `worker.review_passed`.
- [ ] The built reviewer prompt includes a clear instruction to end the response with `VERDICT: APPROVE` or `VERDICT: REJECT` (verified by inspecting the prompt text in a unit test) — the verdict format is load-bearing for the fail-closed parse (MD-007).
- [ ] Same-model reviewer with `allow_same_model_review:false` returns `reject` + `worker.review_degraded` without running the model.
- [ ] Unparseable reviewer output yields the fail-closed `reject` verdict (no config can make it approve; MD-007).
- [ ] The patch is sanitized before being embedded in the reviewer prompt.
- [ ] A fake reviewer that writes `reviewer-side-effect.txt` to its cwd leaves the implementation worktree, the main workspace, and `patch_sha256` unchanged — the write is contained to the throwaway `reviewDir`, and if it escapes the review fails closed with `reviewer_side_effect` (HI-008).
- [ ] Verify: `npx vitest run tests/workers/review.test.ts`

### Task 9: Merge Gate (Approval + Clean Patch Apply)

**Objective:** Apply an approved worker patch to the main workspace as a working-tree edit only, gated on a clean `git apply --check` and recorded user approval — never `add`/`commit`/`push`.

**Files:**
- Create: `src/workers/merge.ts`
- Create: `tests/workers/merge.test.ts`

**Key Decisions / Notes:**
- `mergeWorkerOutput({workspaceRoot, state, journal})`: precondition `status==='AWAITING_APPROVAL' && approval.granted===true` (otherwise throw/return blocked). **Integrity check first (MD-009):** re-read `state.output.patch_path` and require `sha256(file) === state.output.patch_sha256`; a mismatch → `worker.merge_failed` reason `patch_hash_mismatch`, no apply, reset approval. Then `git -C <workspaceRoot> apply --check <patchPath>`; on success `git -C <workspaceRoot> apply <patchPath>` → emit `worker.merged`, return success. Apply-check failure → `worker.merge_failed` (reason `apply_conflict`), do not change files, and reset approval so the caller keeps `AWAITING_APPROVAL` but a fresh approval is required before retry (HI-006). A `git apply` that **throws after a passing `apply --check`** (e.g. a TOCTOU main-tree edit between check and apply) is handled identically to an apply conflict — `git apply` is atomic so no partial write occurs — emit `worker.merge_failed` (reason `apply_conflict`), reset approval, stay `AWAITING_APPROVAL` (IN-101).
- Absolutely no `git add`/`commit`/`push`/`reset`/`clean`/`branch`. The function's only git verbs are `apply --check` and `apply`. Emit `worker.merge_started` first.
- **Approval reset (HI-006):** on any `worker.merge_failed`, signal `approval = {decided:false, granted:false, by:null, at:null}` (the orchestrator persists it); the merge precondition is then unsatisfiable without a new `approve(id, by)`.
- Approval is set by the orchestrator/API, not here; this module refuses to merge without `approval.granted`.

**Definition of Done:**
- [ ] With approval granted and a clean patch, the target files in the main workspace contain the patched content after merge; `worker.merged` emitted; no commit is created (`git log` HEAD unchanged).
- [ ] Without `approval.granted`, merge is refused (no file change).
- [ ] Mutating `patch.diff` after `AWAITING_APPROVAL`, then approving, is refused with `worker.merge_failed` reason `patch_hash_mismatch` BEFORE `git apply --check` runs; main workspace unchanged (MD-009).
- [ ] A conflicting patch fails `apply --check` → `worker.merge_failed` (`apply_conflict`), main workspace unchanged, **approval reset to non-granted**, and a second merge attempt is refused until `approve(id, by)` is called again (HI-006).
- [ ] Verify: `npx vitest run tests/workers/merge.test.ts` (marker `@requires_git`).

### Task 10: Worker Orchestrator, Routing & Daemon Wiring

**Objective:** Drive the full pipeline through the Task 3–9 modules with routing, concurrency, persistence, and rehydration, wired into the daemon and gated by `workers.enabled`.

**Files:**
- Create: `src/workers/orchestrator.ts`
- Create: `tests/workers/orchestrator.test.ts`
- Modify: `src/daemon/index.ts`
- Modify: `tests/daemon/rehydration.test.ts` (worker rehydration cases)

**Key Decisions / Notes:**
- `WorkerOrchestrator` deps: `{ store, config: WorkersConfig, journal, runnerFactory, worktreeOps, validateOutput, reviewOutput, mergeOutput, resolveRunnableAdapter, resolveActiveSessionCwd }` — inject the Task 4–9 functions so the orchestrator is unit-testable without real CLIs/git. `resolveActiveSessionCwd: () => string | null` supplies tier-3 of the workspace resolution (wired in `daemon/index.ts` from `sessionManager.getActiveSession()?.cwd ?? null`, the same handle used at `index.ts:441`/`82`); without it the no-flag dispatch path is unimplementable or forces a global (LO-005).
- **`workspace_root` resolution (at dispatch):** `taskInput.workspace` (`--workspace`) → `config.workers.workspace_root` → `resolveActiveSessionCwd()` → reject the dispatch with a clear error if none resolves. Assert the resolved root is a git repo, then resolve and store the immutable `base_sha` before creating a worktree (MD-013).
- **Async dispatch (MD-002):** `dispatch(taskInput)` resolves routing + workspace_root + `base_sha`, persists `QUEUED` state (`worker.queued`), and **returns the worker id immediately**; the pipeline runs fire-and-forget in the background. A blocking "run then return" handler is forbidden — a worker can run up to `timeout_seconds` (1800s) and would exceed HTTP/socket timeouts.
- **Pipeline order (IN-004/HI-002):** `worker.dispatched` → `RUNNING → IMPLEMENTED` (runner+worktree, isolated HOME) → capture diff in memory → **`auditBoundary`** (fail → `FAILED`/`worker.boundary_violation`) → **`sanitizePatch`** (fail → `REJECTED`/`worker.security_denied`; on pass compute `patch_sha256` and only THEN persist `patch.diff`/`output.json`/`WorkerOutput`) → `worker.completed` → **`VALIDATING`** (Task 7; fail → `REJECTED`) → **`REVIEWING`** (Task 8; fail/degraded → `REJECTED`) → `AWAITING_APPROVAL` (`worker.awaiting_approval`); persist + emit at each transition. Sanitize precedes both persistence and review.
- **Scheduler & slots (MD-002):** `QUEUED` and `AWAITING_APPROVAL` do NOT hold a `max_concurrent` slot — only `RUNNING/VALIDATING/REVIEWING/MERGING` do. A pump starts the next `QUEUED` worker whenever a slot frees: on startup/rehydration and on every transition to `AWAITING_APPROVAL` or a terminal state.
- `approve(id, by)` / `deny(id, by)` / `cancel(id)`: set `approval`, drive `MERGING → MERGED` (Task 9) on approve, `REJECTED` on deny, `CANCELLED` + cleanup on cancel. **On an apply conflict or `patch_hash_mismatch` during approve, persist the reset approval (HI-006)** and leave `AWAITING_APPROVAL` (re-approvable; NOT terminal). **Cancel is cooperative (MD-006):** records `CANCELLED` and frees the slot; an in-flight child is not killed — on its completion the orchestrator sees `CANCELLED`, discards the result (no transition), and runs cleanup, so a late completion never resurrects the worker.
- Cleanup worktrees **and each worker's `reviewDir` (`~/.aisup/workers/<id>/review/`; LO-101)** on terminal states per `retention`; GC stale worktrees older than `max_age_hours` at startup.
- **Rehydration:** on daemon start, subprocess phases (`RUNNING/VALIDATING/REVIEWING`) → `FAILED` + `worker.rehydrated_failed`. **`MERGING` is reconciled against the patch (HI-003):** `git apply --reverse --check` succeeds → `MERGED` + `worker.rehydrated_merged`; else `git apply --check` succeeds → `AWAITING_APPROVAL` (approval reset, reason `merge_interrupted_before_apply`); else → `AWAITING_APPROVAL` + `worker.merge_failed`/`apply_conflict`. `QUEUED` and `AWAITING_APPROVAL` preserved and remain actionable.
- Wire in `src/daemon/index.ts`: construct gated by `config.workers.enabled`; pass the orchestrator's dispatch/approve/deny/cancel/list/get to the server (Task 12); pass `resolveActiveSessionCwd` from the session manager; stop on shutdown. Use a late-bound ref pattern like `exhaustedRecoveryRef`.

**Definition of Done:**
- [ ] `dispatch` returns the worker id BEFORE the pipeline completes (inject a slow fake runner); the worker then advances QUEUED→…→AWAITING_APPROVAL with one event per transition; approve drives MERGED; deny → REJECTED; cancel → CANCELLED (MD-002).
- [ ] A gate failure stops at REJECTED before review-approval; a boundary violation stops at FAILED; a sanitizer hit stops at REJECTED and no raw patch/tails are persisted (HI-002).
- [ ] Dispatch with no `--workspace` and no `config.workers.workspace_root` resolves via the injected `resolveActiveSessionCwd` stub; with that stub returning null and no other source, dispatch is rejected with a clear error (LO-005).
- [ ] With `max_concurrent:2`, a 3rd worker stays `QUEUED` and is pumped to `RUNNING` once one of the first two reaches `AWAITING_APPROVAL`; rehydrated `QUEUED` workers are pumped on startup when a slot is free (MD-002).
- [ ] A cancel issued during `RUNNING` (slow fake runner) ends in `CANCELLED`, frees the slot, cleans the worktree per `retention`, and a late subprocess completion does NOT resurrect the worker (MD-006).
- [ ] Rehydrating a `MERGING` worker whose patch was already applied → `MERGED` + `worker.rehydrated_merged` (NOT `FAILED`); a `MERGING` worker interrupted before apply → `AWAITING_APPROVAL`; other in-flight phases → `FAILED`; `AWAITING_APPROVAL`/`QUEUED` preserved (HI-003).
- [ ] A `MERGING` worker rehydrated after an interrupted apply enters `AWAITING_APPROVAL` with `approval.granted === false` (independently asserted — a fresh approval is required for any retry; HI-006).
- [ ] Verify: `npx vitest run tests/workers/orchestrator.test.ts tests/daemon/rehydration.test.ts`

### Task 11: Worker CLI Surfaces

**Objective:** Operate workers from the CLI (dispatch/list/status/review/approve/deny/cancel/logs), online via the daemon API.

**Files:**
- Create: `src/cli/commands/worker.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli/worker.test.ts`

**Key Decisions / Notes:**
- Mirror `src/cli/commands/gate.ts` online/offline pattern: `daemonRequest()` to the API; dispatch/approve/deny/cancel require the daemon (worker execution lives there); `list`/`status`/`review`/`logs` read the API. `--json` on read commands. **`gate.ts`'s `daemonRequest(path, method)` sends no body** (`gate.ts:22-32`); the worker variant must accept an optional JSON body + `content-type: application/json` for `POST /api/workers` (fastify body parsing is available — `server.ts:264`) (LO-003).
- `dispatch` accepts `--task-type`, `--prompt <text|@file>` (load file when `@`-prefixed), `--title` (defaults to the prompt truncated to 80 chars — `title` is otherwise non-null with no producer; LO-004), `--implementer`, `--reviewer`, `--base`, and `--workspace <path>` (the workspace_root override; highest precedence in the Task 10 resolution order). The POST body carries exactly `{ task_type, prompt, title, implementer?, reviewer?, base_ref?, workspace? }` (LO-004). Register a `worker` command group in `cli/index.ts` with subcommands (commander, like the `gate` group).
- `review <id>` and `logs <id>` are **read-only views over `GET /api/workers/:id`** (no rerun, no extra route; LO-007): `formatWorkerReview` renders `state.review` (verdict + findings + degraded), `formatWorkerLogs` renders the sanitized `stdout_tail`/`stderr_tail` + artifact paths.
- Test the pure formatters (`formatWorkerStatus`/`formatWorkerList`/`formatWorkerReview`/`formatWorkerLogs`) following the `formatGateRun` precedent — do not spawn the daemon in unit tests.

**Definition of Done:**
- [ ] `aisup worker --help` lists all subcommands; `formatWorkerStatus`/`formatWorkerList`/`formatWorkerReview`/`formatWorkerLogs` render a `WorkerState` correctly (pure-function tests).
- [ ] `dispatch --prompt @file` loads the prompt from a file; `dispatch` without `--title` sends a `title` defaulted to the truncated prompt (assert the POST body), and the worker `daemonRequest` sends a JSON body with `content-type: application/json` (LO-003/LO-004).
- [ ] `worker review <id>` formats the stored verdict and `worker logs <id>` formats the sanitized tails + artifact paths from `GET /api/workers/:id` (LO-007).
- [ ] Verify: `npx vitest run tests/cli/worker.test.ts`

### Task 12: Worker HTTP API Surfaces

**Objective:** Expose worker dispatch/list/status/approve/deny/cancel over the daemon's localhost API.

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `tests/daemon/server.test.ts`

**Key Decisions / Notes:**
- Add to `DaemonServerOptions`: `dispatchWorker?`, `listWorkers?`, `getWorker?`, `approveWorker?`, `denyWorker?`, `cancelWorker?` (injected from the orchestrator, like `runGates`/`getLatestGateRun`). Routes: `POST /api/workers`, `GET /api/workers`, `GET /api/workers/:id`, `POST /api/workers/:id/approve`, `POST /api/workers/:id/deny`, `POST /api/workers/:id/cancel`. Behind the existing bearer-auth `preHandler`.
- **`POST /api/workers` returns immediately (MD-002):** parse the body `{ task_type, prompt, title, implementer?, reviewer?, base_ref?, workspace? }` (LO-004), call `dispatchWorker` (which persists `QUEUED` and returns the id), and respond `202 { id, status: 'QUEUED' }` **without awaiting pipeline completion**. Progress is read via `GET /api/workers/:id`.
- When deps are unwired (workers disabled), return `503 { error: 'workers not enabled' }` — mirror the `runGates` 503 pattern at `server.ts:236`.

**Definition of Done:**
- [ ] Each route returns the expected shape with deps wired; `POST /api/workers` parses the JSON body and responds `202 {id, status:'QUEUED'}` without awaiting the pipeline (MD-002); returns 503 when workers are disabled; approve/deny/cancel reach the injected handlers.
- [ ] Routes require the bearer token (401 without it).
- [ ] Verify: `npx vitest run tests/daemon/server.test.ts`

### Task 13: Slack Worker Approval Surface (Optional — deferrable)

**Objective:** Allow remote `!worker status`, `!worker approve <id>`, `!worker deny <id>` from Slack, reusing the existing command/confirmation pattern. **Optional per the prompt — may be deferred without blocking Phase 3.**

**Files:**
- Modify: `src/slack/commands.ts`
- Modify: `src/slack/service.ts`
- Modify: `tests/slack/service.test.ts`

**Key Decisions / Notes:**
- Add **only** `worker` to `KNOWN_COMMANDS` and dispatch worker actions as **subcommands** — `!worker status`, `!worker approve <id>`, `!worker deny <id>` — mirroring the existing `!gate status` subcommand dispatch (`src/slack/service.ts:390-395`). **Do NOT add top-level `approve`/`deny`** — `deny` already exists as the permission-denial command (`commands.ts`; `service.ts:380-388`) and overloading it would regress the verified Phase 2 permission flow (MD-001). Reuse `ConfirmationStore` for approve/deny TTL confirmation. Extend `SlackServiceOpts` with `onWorkerApprove`/`onWorkerDeny`/`getWorkerStatus` callbacks (wired to the orchestrator in `daemon/index.ts`), mirroring the permission `onPermissionGrant`/`onPermissionDeny` wiring.
- Approval still flows through the same orchestrator approve path — no second approval mechanism. If deferred, record the deferral in the runbook (Task 15) and the self-audit, and the runbook must state plainly: **"Worker approval is available via CLI (`aisup worker approve <id>`) and the daemon HTTP API (localhost, `config.daemon.port` default `7394`); Slack `!worker approve`/`!worker deny` are not available in Phase 3"** — so an operator does not expect Slack commands that don't exist.

**Definition of Done:**
- [ ] `!worker approve <id>` / `!worker deny <id>` invoke the orchestrator approve/deny callbacks and report success only on a real state transition (reuse the F3/F4 keystroke-confirmation lesson: report success only when the action actually happened).
- [ ] Bare `!deny` (no id) still routes to the existing permission-denial command — the worker subcommands do not regress it (MD-001).
- [ ] `!worker status` reports current worker states.
- [ ] Verify: `npx vitest run tests/slack/service.test.ts`
- [ ] If deferred: this task's checkbox is marked `DEFERRED` with a one-line reason, and the deferral is noted in the runbook + self-audit.

### Task 14: Integration / E2E Smoke Tests & Host Gates

**Objective:** Prove the seven PRD Phase 3 acceptance criteria end-to-end with deterministic tests, plus host-gated real-CLI smoke tests skipped by default.

**Files:**
- Create: `tests/integration/workers.smoke.test.ts`
- Create: `tests/integration/WORKER_HOST_GATES.md`

**Key Decisions / Notes:**
- Deterministic (always-run, `@requires_git`) coverage using a fake adapter (a tiny `node -e` script that writes a known file / emits a verdict) and a real temp git repo:
  - **Codex/Gemini worktree completion (AC 1,2):** simulated via the generic adapter against a temp repo — proves bounded task → isolated worktree → diff. Real Codex/Gemini are the host-gated tier.
  - **Seeded-bug cross-model review (AC 3, TS-003):** patch with a subtle bug that *passes gates* but the fake reviewer rejects → merge blocked. Also a fake reviewer that writes a file to its cwd leaves the worktree/main workspace/`patch_sha256` unchanged (HI-008 containment).
  - **Boundary enforcement (AC 4) — implementable cases only (HI-007):** (a) a worker writing into the main workspace (tracked or gitignored path) → `auditBoundary` false → FAILED, merge blocked; (b) a worker modifying a **pre-existing ignored** forbidden-glob file (e.g. an existing `.env`) → audit false via the content-hash snapshot (HI-004); (c) a `$HOME`-resolving write is contained by the isolated temp HOME and is **absent from the captured patch** (`.home/` exclusion; MD-003). Do NOT assert detection of arbitrary absolute-path writes outside `workspace_root`/temp HOME — those are an accepted, undetected residual; only assert the structural guarantee that they never reach the merge candidate (HI-007).
  - **Secrets never persisted (HI-002):** a worker patch adding `.env` / an `api_key = "…"` line → `worker.security_denied`, and no raw `patch.diff` / raw patch field in `output.json` / `state.json` (only redacted violation metadata).
  - **Failed gate blocks merge (AC 5):** a required gate exits non-zero → REJECTED.
  - **Approval required (AC 6):** merge attempt without approval is refused; with approval it proceeds.
  - **Clean patch apply (AC 7):** approved patch applies to the main temp workspace and the file content matches; the patch is computed against the stored `base_sha`, so advancing the source branch after dispatch does not change the applied result (MD-013).
- Host-gated tiers (skipped unless env+markers): `@requires_codex` (`AISUP_TEST_CODEX=1`), `@requires_gemini` (`AISUP_TEST_GEMINI=1`), `@requires_local_llm` (`AISUP_TEST_LOCAL_LLM=1`). Installed adapters vary per host, so tests must **skip (never fail)** for an unavailable adapter. `WORKER_HOST_GATES.md` MUST record the actual adapters installed on the test host and the exact step-by-step procedure to run each available tier. (On the planning host today: `codex` present; `gemini`/`local` absent — informational, not an assumption baked into the tests.)
- Isolated temp `HOME`/`~/.aisup` and a unique `worktree_dir` per run; never touch the real repo or `~/.aisup`. No interactive processes in Vitest.

**Definition of Done:**
- [ ] Each of AC 1–7 has a passing deterministic assertion (real git temp repo, fake adapter); the seeded bug is caught by review, not gates.
- [ ] AC4 asserts only the implementable boundary cases — main-workspace write, configured forbidden-path write, pre-existing ignored-file content change, and `$HOME` containment + patch-absence — and does NOT assert detection of arbitrary absolute-path writes (HI-007).
- [ ] A forbidden/secret-bearing patch emits `worker.security_denied` and leaves no raw patch/tails in any worker artifact (HI-002); a fake reviewer's cwd write does not touch the worktree/main workspace/patch artifact (HI-008).
- [ ] Host-gated real-CLI tests **skip** (not fail) when their env marker/adapter is absent; `WORKER_HOST_GATES.md` lists the host's actual installed adapters and per-tier run procedure.
- [ ] No orphan worktrees, `reviewDir`s, or state remain after the suite (LO-101); the real repo/`~/.aisup` are untouched.
- [ ] Verify: `npx vitest run tests/integration/workers.smoke.test.ts` and `AISUP_TEST_CODEX=1 npx vitest run tests/integration/workers.smoke.test.ts` (records codex result; other tiers skip when absent).

### Task 15: Documentation & Runbook Updates

**Objective:** Document worker config, CLI/API/Slack surfaces, security model, and host-gated CLI setup so an operator can enable and run workers.

**Files:**
- Modify: `docs/runbook.md`
- Modify: `docs/prd/2026-04-29-ai-supervisor.md`

**Key Decisions / Notes:**
- Runbook: a "Multi-LLM Workers" section — enabling `workers`, configuring adapters (codex/gemini/local placeholders, prompt delivery), routing, validation gates (incl. the fail-closed "must configure ≥1 required gate" rule), the approval/merge flow, the security boundary, and the host-gated test markers. Note `.aisup-workers/` is gitignored. **Security boundary (state precisely; HI-007):** the enforceable guarantees are (1) only the worktree git diff is ever a merge candidate, (2) main-workspace and configured forbidden-path changes are detected by the boundary audit (incl. content changes to pre-existing ignored files), and (3) trusted-CLI `$HOME` writes are redirected into a throwaway HOME; the **accepted residual** is that arbitrary absolute-path writes outside `workspace_root` and outside the temp HOME are **neither prevented nor detected** (OS sandboxing is the named deferred hardening). No auto-commit; the only automatic `git add` is the worktree-local intent-to-add. **Operability notes:** validation gates run in a fresh nested worktree with no installed deps — Node resolves the parent repo's `node_modules` via upward lookup, other ecosystems must self-provision (MD-005); reviewer adapters should prefer `prompt_via: stdin`/`file` over `arg` for large patches (IN-002); workers branch from the **committed** `base_ref` (default `HEAD`) resolved to an immutable `base_sha`, so uncommitted main-tree edits are not seen by the worker (IN-003/MD-013). **Where approval lives:** worker approval is via CLI (`aisup worker approve <id>`) and the daemon HTTP API (localhost `config.daemon.port`, default `7394`); if Task 13 was deferred, Slack `!worker approve`/`!worker deny` are not available in Phase 3.
- PRD: flip Feature Inventory **G** and **H₂** from "In progress (Phase 3)" to "Implemented (Phase 3)" once tasks land (this is the closing doc edit — keep it accurate to actual completion). If Slack worker surface (Task 13) was deferred, state so.
- Documentation-sync: update counts/lists where the runbook enumerates commands or events.

**Definition of Done:**
- [ ] Runbook documents enabling workers, adapter config, routing, validation gates, approval/merge, and the security boundary; host-gate markers listed. The residual is stated precisely — no claim that arbitrary absolute-path writes are detected (HI-007); the fresh-worktree-deps, large-patch stdin/file, and committed-base notes are present (MD-005/IN-002/IN-003).
- [ ] PRD G/H₂ status reflects actual completion; any deferral (Task 13) is recorded.
- [ ] Verify: re-read both docs; `grep -n "workers" docs/runbook.md` shows the new section.

## Validation Strategy

**Unit (always-run, mock external deps):**
- Contract parsing & loader validation (Task 2): defaults, custom values, every invalid-config rejection (auto-merge-disabled, spaced adapter command, unknown routing adapter, `..` in `worktree_dir`).
- Adapter builder & routing (Task 4): argv/env/stdin per `prompt_via`; env allowlist; reviewer≠implementer resolution.
- Runner (Task 5): shell-free `execFile`, timeout, tail truncation, literal metacharacter passing.
- Validation wrapper (Task 7): pass/fail mapping; `cwd=worktree`.
- Review (Task 8): verdict parse, fail-closed, degraded same-model.
- Merge precondition logic (Task 9): approval gating.
- Orchestrator (Task 10): state transitions, routing, concurrency, rehydration — all via injected fakes.
- Store (Task 3), CLI formatters (Task 11), API routes (Task 12), Slack (Task 13).

**Integration (`@requires_git`, real temp repo):**
- Worktree lifecycle + boundary audit + patch sanitize (Task 6).
- Merge apply/apply-check against a real temp workspace (Task 9).
- The seven-AC smoke suite (Task 14).

**Host-gated (skipped by default, explicit markers + env):**
- `@requires_codex` / `AISUP_TEST_CODEX=1`, `@requires_gemini` / `AISUP_TEST_GEMINI=1`, `@requires_local_llm` / `AISUP_TEST_LOCAL_LLM=1` — real worker runs; **skip (never fail)** when the adapter/env is absent. `tests/integration/WORKER_HOST_GATES.md` records the host's actual installed adapters and per-tier procedure.

**Deterministic acceptance proofs (no host CLI):**
- Seeded-bug review (TS-003), failed-gate-blocks-merge, approval-required, clean-patch-apply, boundary-escape — all via fake adapters + real temp git.

**Suite / typecheck / build:**
- `npm run typecheck` · `npx vitest run` (full suite, 0 failures) · `npm run build` (tsup). An `npm run lint` script exists but eslint is not installed, so lint is not a working gate — typecheck + vitest are the gates (IN-001; see [[lint-not-configured]]).

**Runtime profile:** API/CLI only — **no browser E2E required**. Program-execution checks: `aisup worker --help`, and the deterministic smoke suite exercising the real pipeline against a temp repo stand in for live execution; real-CLI live runs are the host-gated tier.

## Security & Isolation Requirements (explicit & testable)

| Requirement | Mechanism | Test |
|---|---|---|
| Worker writes outside the worktree never reach the main workspace | **structural:** only the worktree git diff is ever a merge candidate (Task 9) | Task 14 AC4: a non-worktree write is absent from the merged result |
| Realistic `$HOME`-resolving escapes contained AND kept out of the patch | isolated temp `HOME=<worktree>/.home` + `.home/` excluded from the diff via `.git/info/exclude` + `:(exclude)` pathspec (Tasks 4–6) | Task 6: a `$HOME` write hits the temp home (real `~/.claude` untouched) AND is absent from the captured patch/changed files (MD-003) |
| Out-of-worktree / forbidden-path writes detected (within the workspace + configured set) | ignored-aware `git status --porcelain --ignored` + content-hash snapshot of forbidden-glob files; symlink-component + reserved-path rejection | Task 6: gitignored-path write, pre-existing ignored-file content change, and symlinked/`.`/`.git` worktree_dir all caught (HI-004/MD-011). **Residual (HI-007):** arbitrary absolute-path writes outside `workspace_root`/temp HOME are neither prevented nor detected — `sandbox-exec` deferred |
| Worker validation gates run isolated | custom `GateRunner` with `cwd=worktree`, isolated `HOME`, no ambient env; gate `cwd` normalized to null | Task 7: gate `$HOME` is the temp home (HI-005); a gate-set `cwd` cannot escape the worktree (HI-001) |
| Shell-free worker + reviewer subprocesses | `execFile(command, args)` only; no shell | Task 5 literal-metacharacter test |
| Allowlisted worker env | builder copies only the union(`security`, adapter) `env_allowlist` names | Task 4 env test (LO-002) |
| Secrets / tokens / account paths / transcripts / tmux captures / `.claude/settings.local.json` never in artifacts | patch sanitizer — `forbidden_path_globs` over `changedFiles` (picomatch) + content-secret line scan — runs BEFORE any artifact is persisted | Task 6 sanitize test (forbidden path via `changedFiles` + secret assignment line; MD-004/LO-001); Task 14: raw patch/tails never persisted on a hit (HI-002) |
| Reviewer is a read-only gate (no second writer) | reviewer runs in a throwaway review dir (`~/.aisup/workers/<id>/review/`, outside the worktree/main tree; removed on cleanup — LO-101), isolated HOME/env; post-review side-effect audit + `patch_sha256` immutability | Task 8: a reviewer cwd-write does not touch worktree/main workspace/patch artifact (HI-008); Task 14: no `reviewDir` orphaned after the suite (LO-101) |
| Approved/reviewed patch is the merged patch | `patch_sha256` computed after sanitize, re-verified before `git apply` | Task 9: mutated `patch.diff` refused with `patch_hash_mismatch` (MD-009) |
| No automatic destructive git | only `worktree add/remove`, `diff`, `status`, `apply[ --check]`, `rev-parse`, and the worktree-local `add -A -N` (intent-to-add, never the main tree); `remove` path-validated under `worktree_dir` | Task 6 remove-refuses-outside + new-file-in-patch tests (MD-012); Task 9 no-commit assertion |
| Merge requires explicit user approval, every time (incl. after a conflict) | merge precondition `approval.granted`; `merge.require_approval` forced true; approval reset on `merge_failed` | Task 9 + Task 14 approval-required; Task 9 approval-reset-after-conflict (HI-006) |

## Event & Observability Contract

One canonical worker event family (Task 2). Required detail fields (never secrets/transcript content):

| Event | Required details |
|---|---|
| `worker.queued` / `worker.dispatched` | `worker_task_id`, `task_type`, `implementer`, `reviewer`, `base_ref`, `base_sha` |
| `worker.completed` | `worker_task_id`, `worktree_path` (safe), `changed_files` (paths only), `exit_code`, `timed_out` |
| `worker.failed` | `worker_task_id`, `reason` (`adapter_unresolved`/`timed_out`/`worktree_create_failed`/…) |
| `worker.validated` / `worker.validation_failed` | `worker_task_id`, `failed_gates` |
| `worker.review_started` / `worker.review_passed` / `worker.review_failed` / `worker.review_degraded` | `worker_task_id`, `reviewer`, `verdict`, `degraded`, `reason` |
| `worker.awaiting_approval` | `worker_task_id`, `changed_files` |
| `worker.approved` / `worker.denied` | `worker_task_id`, `by` (safe id) |
| `worker.merge_started` / `worker.merged` / `worker.merge_failed` / `worker.rehydrated_merged` | `worker_task_id`, `reason` (on fail: `apply_conflict` / `patch_hash_mismatch` / `merge_interrupted_before_apply`) |
| `worker.boundary_violation` / `worker.security_denied` | `worker_task_id`, `violations` (paths/categories, no content) |
| `worker.cancelled` / `worker.cleanup` / `worker.rehydrated_failed` | `worker_task_id` |

Per-gate validation detail reuses existing `gate.started`/`gate.passed`/`gate.failed`/`gate.timeout`/`gate.run_completed`; the `worker_task_id` is injected into each event's `details` by the wrapping `JournalWriter` in Task 7 (the engine has no detail-injection hook), keeping events attributable under concurrent workers without a duplicate event family.

## Traceability Matrix

| PRD Acceptance Criterion | Plan Destination | Validation Evidence Required | Notes |
|---|---|---|---|
| 1. Codex worker completes bounded task in isolated worktree | Tasks 4,5,6,10 | Deterministic worktree-completion test (Task 14); host-gated `@requires_codex` real run | codex present on host |
| 2. Gemini worker completes bounded task in isolated worktree | Tasks 4,5,6,10 | Same deterministic test (generic adapter); host-gated `@requires_gemini` | gemini not installed → placeholder + host gate |
| 3. Cross-model review catches a seeded bug | Task 8 | TS-003 seeded-bug test (bug passes gates, review rejects) | reviewer≠implementer enforced |
| 4. Worker cannot write outside allowed workspace | Task 6 | Boundary-escape test → audit false → merge blocked (main-tree + pre-existing ignored-file + `$HOME` cases) | structural diff-scoping enforces; audit detects workspace + forbidden-path writes only — arbitrary absolute-path writes are an undetected residual (HI-007) |
| 5. Failed validation gate blocks merge | Task 7 | Failed-required-gate test → REJECTED | reuses `runGates` |
| 6. User approval required for every merge | Tasks 9,10,11,12,(13) | Approval-required test; `merge.require_approval` forced true | no auto-merge |
| 7. Approved patch applies cleanly to main workspace | Task 9 | `git apply --check`+`apply` test; content match; no commit | working-tree apply only |
| H₂ worker validation gate engine | Task 7 | `worker.validated`/`worker.validation_failed` tests | built on Phase 2 gate engine |

### Deferred / Not Phase 3 (must not leak in)

| Item | Disposition | Guard |
|---|---|---|
| Mobile/remote dashboard, dashboard token auth, ntfy, rich Slack, thread-per-tool-call | Phase 4 | Not in any task; self-audit checks |
| Proxy/Bifrost API model routing | Out of scope (PRD) | No proxy code; routing is task-type→adapter only |
| Multiple simultaneous lead sessions | Out of scope | One lead session; workers separate; concurrency is worker-only |
| Remote-control reconnect after switch | Deferred (no task) | Not touched in Phase 3 |
| launchd auto-start; Windows/Linux | Out of scope | Not touched |
| Auto-merge / auto-approval | Forbidden | `merge.require_approval` forced true; approval gate test |
| `git add`/`commit`/`push` to the main workspace by aisup | Forbidden (AGENTS rule 10) | Task 9 no-commit assertion; only `apply`/`apply --check` write to the main tree. The sole automatic `git add` is the worktree-local `add -A -N` intent-to-add (isolated worktree only; MD-012) |
| Named worker branches (`branch_prefix`) | Removed in Phase 3 (detached-only) | Workers create detached worktrees only; no branch ref is written or cleaned up (MD-014). A future named-branch mode would need its own create/delete lifecycle + cleanup tests |
| OS `sandbox-exec` hardening | Deferred (recorded residual) | Isolation = structural diff-scoping + isolated temp HOME + ignored-aware/content-hash audit. **Accepted residual (HI-007):** arbitrary absolute-path writes outside `workspace_root`/temp HOME (e.g. `/tmp`, `/etc`) are **neither OS-prevented nor detected**; `sandbox-exec`/filesystem monitoring is the named future hardening. Threat model = accidental escape by a trusted local CLI, not an adversarial binary. |

## Final Self-Audit Checklist (must be true before implementation starts)

- [ ] PRD Phase 3 scope reconciled with verified Phase 1/2 state (Task 1).
- [ ] No Phase 4 or proxy-routing scope leaked in (Deferred matrix); branch mode removed (detached-only, MD-014).
- [ ] Worker worktree isolation is testable: structural diff-scoping + isolated temp HOME (with `.home/` excluded from the patch, MD-003) + ignored-aware + content-hash audit (Task 6 escape tests: gitignored-path, pre-existing ignored-file content change (HI-004), reserved/symlinked `worktree_dir` (MD-011), HOME containment); the absolute-path residual is recorded precisely as **undetected**, not "detected/journaled" (HI-007).
- [ ] Artifacts are sanitized BEFORE persistence and before review; raw patch/tails never hit disk on a security hit (HI-002); the merged patch is hash-bound to the reviewed patch (MD-009).
- [ ] Cross-model review policy is concrete (reviewer≠implementer via enabled-adapter resolution (MD-010); degraded handling; fail-closed parse with no fail-open config (MD-007); reviewer runs read-only in a throwaway dir with a post-review side-effect audit (HI-008)).
- [ ] Merge approval gate is concrete (approval precondition; `require_approval` forced true; no auto-merge; approval reset on apply conflict / hash mismatch so every merge needs fresh approval (HI-006)).
- [ ] Validation gate engine (H₂) is concrete (reuses `runGates`, cwd=worktree with gate `cwd` normalized to null (HI-001), custom env-isolated runner (HI-005)) and **fail-closed**: no zero-check merge path (empty/optional-only gates ⇒ validation fails unless `allow_no_validation`).
- [ ] Gate events are attributable to a worker (`worker_task_id` injected via a wrapping writer; concurrent runs stay distinguishable).
- [ ] Orchestrator semantics are concrete: async dispatch returns the id immediately + slot-freeing scheduler (MD-002); cooperative cancel with no late-completion resurrection (MD-006); `MERGING` rehydration reconciled against the patch (HI-003).
- [ ] Config defaults and validation are exact (Config Contract + Task 2 rules), incl. immutable `base_sha` capture and `base_ref` leading-`-` rejection (MD-013/LO-006).
- [ ] Event contract is canonical (one `worker.*` family incl. `worker.rehydrated_merged`; gate events reused, not duplicated).
- [ ] Host-gated tests have explicit env markers (`@requires_codex/gemini/local_llm`).
- [ ] No `git add/commit/push` to the main workspace by aisup; the only automatic `git add` is the worktree-local `add -A -N` (MD-012); merge is working-tree `apply` only.
- [ ] The plan is implementable without reading prior reviews for missing requirements.

## Progress Tracking

Completed: 15 / 15 — Remaining: 0

- [x] Task 1: PRD & status reconciliation
- [x] Task 2: Worker config & event contract baseline (W-C1)
- [x] Task 3: Worker task contract & state store
- [x] Task 4: Worker adapter builder & routing resolver
- [x] Task 5: Worker subprocess runner
- [x] Task 6: Worktree lifecycle & boundary enforcement
- [x] Task 7: Worker validation gate integration (H₂)
- [x] Task 8: Cross-model review flow
- [x] Task 9: Merge gate (approval + patch apply)
- [x] Task 10: Worker orchestrator, routing & daemon wiring
- [x] Task 11: Worker CLI surfaces
- [x] Task 12: Worker HTTP API surfaces
- [x] Task 13: Slack worker approval surface (implemented, not deferred)
- [x] Task 14: Integration / E2E smoke tests & host gates
- [x] Task 15: Documentation & runbook updates

## E2E Test Scenarios

API/CLI profile (no UI). These structured scenarios are executed by spec-verify Phase B against a temp git repo with fake adapters.

### TS-001: Dispatch → approve → clean merge (happy path)
**Priority:** Critical
**Preconditions:** `workers.enabled`, a temp git repo as `workspace_root`, one enabled implementer + one enabled reviewer (fakes), all validation gates passing.
**Mapped Tasks:** 5,6,7,8,9,10,11,12

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | `aisup worker dispatch --task-type implement --prompt "<task>"` | Returns the worker id immediately (`202`/`QUEUED`, no blocking on the run); the pipeline then advances in the background to `AWAITING_APPROVAL`; `worker.awaiting_approval` journaled |
| 2 | `aisup worker status <id>` | Shows `AWAITING_APPROVAL`, changed files, review `approve`, gates passed |
| 3 | `aisup worker approve <id>` | `MERGING`→`MERGED`; patch applied to main workspace; file content matches; no commit created |

### TS-002: Boundary violation blocks merge
**Priority:** Critical
**Preconditions:** Fake worker that writes a file into the main workspace (outside the worktree).
**Mapped Tasks:** 6,10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Dispatch the escaping worker | Boundary audit fails; status `FAILED`; `worker.boundary_violation` journaled; no merge candidate |
| 2 | `aisup worker approve <id>` | Refused — task is terminal `FAILED`, not `AWAITING_APPROVAL` |

### TS-003: Cross-model review catches a seeded bug
**Priority:** Critical
**Preconditions:** Patch contains a subtle bug that passes all configured gates; fake reviewer rejects it.
**Mapped Tasks:** 7,8,10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Dispatch the worker | Gates pass (`worker.validated`); review rejects (`worker.review_failed`); status `REJECTED` |
| 2 | `aisup worker approve <id>` | Refused — not `AWAITING_APPROVAL`; merge never runs |

### TS-004: Failed gate + approval-required
**Priority:** High
**Preconditions:** One required validation gate exits non-zero.
**Mapped Tasks:** 7,9,10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Dispatch the worker | `worker.validation_failed`; status `REJECTED`; review/merge skipped |
| 2 | Attempt merge of any non-approved worker | Refused without `approval.granted` |

### TS-005: Apply conflict requires fresh approval
**Priority:** High
**Preconditions:** An `AWAITING_APPROVAL` worker whose patch no longer applies cleanly to the main workspace.
**Mapped Tasks:** 9,10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | `aisup worker approve <id>` | `git apply --check` fails → `worker.merge_failed` (`apply_conflict`); status stays `AWAITING_APPROVAL`; **approval is reset** (`granted=false`) |
| 2 | `aisup worker approve <id>` (after rebasing/re-dispatching) | A fresh approval is required and accepted; merge is re-attempted only with the new approval (HI-006) |
