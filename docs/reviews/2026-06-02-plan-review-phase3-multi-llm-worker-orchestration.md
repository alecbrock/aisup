# Implementation Plan Review: Phase 3 — Multi-LLM Worker Orchestration

**Plan:** `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`
**Reviewed:** 2026-06-04
**Review Iterations:** 8 (independent evidence-driven pass + second-order conflict pass + third orchestrator/lifecycle pass + fourth validation/security/rehydration pass + fifth boundary/approval/artifact-integrity pass + sixth residual-security/reviewer-side-effect/git-command-consistency pass + seventh git-ref lifecycle pass + eighth plan-application and fresh local-evidence pass)
**Status:** ISSUES_FOUND (superseded 2026-06-16 — MD-001 resolved after iteration 8; all 33 findings now merged into the plan, see plan header "Reviews merged")

> **Iteration 8 status:** The implementation plan is now `Status: PENDING`,
> `Approved: Yes`, and incorporates the prior review labels throughout the plan.
> A fresh plan-application pass re-checked all 33 active findings from iterations
> 3-7 against the current plan and current repository evidence. **No new issues
> were found.** Thirty-two prior findings are now resolved in the plan. One prior
> finding, **MD-001**, remains partially open because the plan still names top-level
> Slack `!approve`/`!deny` in the File Structure and Task 13 Objective sections,
> despite the corrected Task 13 implementation notes requiring `!worker approve`
> / `!worker deny` subcommands only.

## Summary

| Severity | Current Findings | Description |
|---|---:|---|
| CRITICAL | 0 | Blocks implementation or causes incorrect behavior |
| HIGH | 0 | Significant gap likely to cause rework, failed validation, or integration confusion |
| MEDIUM | 1 | Quality issue that materially reduces clarity, coverage, or maintainability |
| LOW | 0 | Minor improvement |
| INFO | 0 | Observation or optional alternative |

**Total current findings:** 1 (1 MEDIUM)
**Recommendation:** FIX_AND_RE_REVIEW — the architecture and all HIGH-risk prior fixes are now represented in the plan, but the remaining Slack command wording must be corrected before implementation so Task 13 cannot reintroduce the verified Phase 2 `!deny` permission-command collision.

The plan's core architecture is sound. The eighth pass found no new issues beyond the one partially unapplied prior finding below.

## Current Findings

### MEDIUM

#### MD-001: Slack command collision fix is only partially applied

**Evidence:**
- Current plan `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md:200` correctly says Slack worker actions are subcommands of the single `worker` command and explicitly says not to add top-level `!approve`/`!deny`.
- Current plan `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md:627-633` correctly says to add only `worker` to `KNOWN_COMMANDS`, use `!worker approve <id>` / `!worker deny <id>`, and preserve bare `!deny` for permission denial.
- But current plan `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md:323` still describes the Slack file changes as `` `!worker`/`!approve`/`!deny` ``.
- Current plan `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md:619` still states the Task 13 objective as allowing remote `` `!worker status`, `!approve <id>`, `!deny <id>` ``.
- Current code still has `deny` as the permission-denial command: `src/slack/commands.ts:1`, and `src/slack/service.ts:380-388` routes bare `!deny` to `onPermissionDeny`. The existing subcommand precedent is `case 'gate'` handling `!gate status` at `src/slack/service.ts:390-395`.

**Issue:**
The prior MD-001 fix is present in the detailed Task 13 notes and the Slack surface section, but not in the File Structure list or Task 13 Objective. A future implementer following the summary/objective text can still add top-level worker `!approve`/`!deny` despite the corrected details later in the task.

**Impact:**
This can regress the verified Phase 2 permission fallback flow by overloading bare `!deny`, or force the implementer to resolve a self-contradictory Task 13 contract mid-implementation.

**Optimal Fix:**
Update the plan in place so every Slack reference uses only `!worker status`, `!worker approve <id>`, and `!worker deny <id>` for worker actions. Specifically, change the File Structure line to describe `!worker ...` subcommands, and change the Task 13 Objective to remove top-level `!approve`/`!deny`.

**Why This Fix:**
It keeps one Slack command namespace, follows the existing `!gate status` subcommand pattern, and avoids any change to the existing permission `!deny` behavior.

**Fix Validated:**
YES — the collision is verified in `src/slack/commands.ts:1` and `src/slack/service.ts:380-388`; the safe subcommand pattern is verified at `src/slack/service.ts:390-395`; the current plan still has two contradictory top-level worker-command references.

**Validation Command or Check:**
`rg -n "!approve|!deny|!worker approve|!worker deny|KNOWN_COMMANDS" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md src/slack/commands.ts src/slack/service.ts`

**Test Changes:**
Task 13's `tests/slack/service.test.ts` cases should assert `!worker approve <id>`, `!worker deny <id>`, and `!worker status`, plus a regression case that bare `!deny` still routes to permission denial.

**Affected Tasks or Sections:**
File Structure; Task 13 Objective; Task 13 DoD; CLI/API/Slack surfaces.

---

## Prior-Finding Resolution Matrix

| ID | Iteration 8 status | Current plan evidence |
|---|---|---|
| HI-001 | RESOLVED | Worker gate `cwd` rejected/normalized: lines 184, 279, 297, 362, 496 |
| HI-002 | RESOLVED | Sanitization before persistence and tests: lines 110-112, 175, 180, 561, 570, 650, 660 |
| HI-003 | RESOLVED | `MERGING` rehydration reconciles patch: lines 193, 218, 565, 574 |
| HI-004 | RESOLVED | Forbidden-glob content-hash snapshot: lines 170, 237, 451, 468, 649 |
| HI-005 | RESOLVED | Custom env-isolated validation `GateRunner`: lines 184, 485, 497, 718 |
| HI-006 | RESOLVED | Approval reset on merge failure: lines 70, 185, 535, 537, 544, 563, 575 |
| HI-007 | RESOLVED | Absolute-path residual now states neither prevented nor detected: lines 49, 174, 649, 659, 674, 717, 771 |
| HI-008 | RESOLVED | Reviewer throwaway dir and side-effect checks: lines 181, 512, 523, 648, 660, 722 |
| MD-001 | PARTIAL | Correct at lines 200 and 627-633; still contradictory at lines 323 and 619 |
| MD-002 | RESOLVED | Async dispatch and scheduler: lines 189, 191, 560, 562, 572, 609 |
| MD-003 | RESOLVED | `.home/` and prompt-file patch exclusion: lines 148-150, 168, 407, 426, 463, 716 |
| MD-004 | RESOLVED | `sanitizePatch(changedFiles, patch, forbiddenGlobs)` and line regex: lines 175, 453, 721 |
| MD-005 | RESOLVED | Fresh nested worktree dependency note/test: lines 184, 489, 498, 674 |
| MD-006 | RESOLVED | Cooperative cancel and late-completion discard: lines 68, 192, 563, 573 |
| MD-007 | RESOLVED | Review fail-closed; removed config rejected: lines 183, 278, 298, 362, 514, 520 |
| MD-008 | RESOLVED | Prompt-file `{path, contents}` contract: lines 147-153, 407, 426, 433 |
| MD-009 | RESOLVED | Patch hash persisted and rechecked before merge: lines 114, 185, 535, 543, 723 |
| MD-010 | RESOLVED | Enabled implementer and disabled reviewer fallback semantics: lines 182, 190, 295, 409 |
| MD-011 | RESOLVED | Reserved/symlinked `worktree_dir` rejection: lines 165, 292, 362, 456, 470 |
| MD-012 | RESOLVED | Worktree-local `git add -A -N` exception: lines 36, 50, 168, 464, 724, 769 |
| MD-013 | RESOLVED | Immutable `base_sha` capture and diff: lines 86, 165, 168, 296, 448, 465, 559, 653 |
| MD-014 | RESOLVED | Detached-only worktrees; branch mode removed: lines 97, 165, 176, 229, 770 |
| LO-001 | RESOLVED | Transcript/tmux globs in defaults: lines 237-241, 453, 472, 721 |
| LO-002 | RESOLVED | Effective env allowlist union: lines 235, 408, 413, 720 |
| LO-003 | RESOLVED | Worker daemon request body/content-type: lines 588, 595 |
| LO-004 | RESOLVED | `title` source and body shape defined; `input_artifact_path` removed: lines 83, 589, 609 |
| LO-005 | RESOLVED | `resolveActiveSessionCwd` dependency: lines 558-559, 571 |
| LO-006 | RESOLVED | Leading-`-` `base_ref` rejection: lines 165, 296, 362, 448, 471 |
| LO-007 | RESOLVED | `review` and `logs` read-only over `GET /api/workers/:id`: lines 198, 590, 596 |
| IN-001 | RESOLVED | Lint wording corrected: line 707 |
| IN-002 | RESOLVED | Reviewer stdin/file guidance for large patches: lines 183, 511, 674 |
| IN-003 | RESOLVED | Committed-base note in runbook requirements: line 674 |
| IN-004 | RESOLVED | Orchestrator checkpoint order pinned: lines 189, 561 |

## Historical Findings Detail (Iterations 1-7)

The detailed findings below are preserved as audit history. They reflect the pre-iteration-8 plan state and should not be treated as current unless listed in **Current Findings** above.

### HIGH

#### HI-001: Worker validation gates can silently run outside the worker worktree when a gate-level `cwd` is set

**Evidence:**
- Plan Task 7 (line 461): `validateWorkerOutput` calls `runGates(gates, { journal: taggedJournal, defaultCwd: worktree })`.
- Plan Task 7 (line 464): "Gates run with `cwd = worktree` so tests execute against the worker's changes in isolation, not the main tree."
- Plan config (line 269): `validation_gates: []` uses `GateCommandConfig[]`, "same shape as `gates.gates`."
- `src/gates/engine.ts:65-67` runs each gate with `cwd: gate.cwd ?? deps.defaultCwd`, so any non-null `validation_gates[*].cwd` overrides the worker worktree.
- Plan Task 2 validates `validation_gates` by the existing `validateGates` only (line 287), with no worker-specific restriction that `cwd` must be null.

**Issue:**
The plan claims H2 gates validate the worker worktree, but the reused gate engine gives each gate's own `cwd` precedence over `defaultCwd`. If an operator copies an existing supervisor gate with `cwd` set to the main workspace or another absolute path, the worker validation can pass against the wrong tree while the worker patch remains untested.

**Impact:**
This can invalidate a headline Phase 3 guarantee: "Failed validation gate blocks merge" only means something if the gate runs against the worker output. A literal implementation following the plan can silently validate the main workspace instead, causing false approvals and confusing test results.

**Optimal Fix:**
In Task 2 and Task 7, add a worker-specific gate-cwd contract: `workers.validation_gates[*].cwd` must be `null`/omitted and the validation wrapper forces `cwd = worktree` before calling `runGates`. The smallest implementation is `const workerGates = gates.map((g) => ({ ...g, cwd: null }))` plus loader validation that rejects non-null worker gate `cwd` with a clear config error. Add a Task 7 test where a configured gate has `cwd` set away from the worktree and is rejected or normalized before execution.

**Why This Fix:**
It preserves reuse of the audited gate engine while removing the one inherited field that contradicts worker isolation. Rejecting or normalizing `cwd` is safer than relying on operator discipline and keeps H2's execution target unambiguous.

**Fix Validated:**
YES — the gate precedence is verified in `src/gates/engine.ts:65-67`; the plan's validation rules do not restrict worker gate `cwd`.

**Validation Command or Check:**
`grep -n "cwd: gate.cwd" src/gates/engine.ts`; Task 7 unit test asserts worker validation cannot execute a gate outside `worktree`.

**Test Changes:**
Add `tests/workers/validation.test.ts` coverage for a gate with `cwd` set to a non-worktree path, expecting a config rejection or normalized `cwd=worktree`.

**Affected Tasks or Sections:**
Task 2 validation rules; Task 7; H2 traceability row; Task 14 AC5.

---

#### HI-002: Raw patch/output artifacts are persisted before sanitization, contradicting the "secrets never in artifacts" guarantee

**Evidence:**
- `WorkerState.output` embeds `WorkerOutput` (plan lines 93-100), and `WorkerOutput` includes raw `stdout_tail`, `stderr_tail`, and `patch` text (lines 110-114).
- Output artifacts are persisted under `~/.aisup/workers/<id>/` as `patch.diff` and `output.json` (plan line 175).
- Artifact sanitization is described as "before review or merge" (plan line 170), and Task 8 sanitizes before embedding the reviewer prompt (line 483). The plan does not state that sanitization happens before writing `patch.diff`, `output.json`, or `state.json`.
- Security table line 676 promises "Secrets / tokens / account paths / transcripts / tmux captures / `.claude/settings.local.json` never in artifacts."

**Issue:**
The plan rejects forbidden patches only after the diff has been captured, but it also defines the captured patch and output tails as persisted artifacts. A worker that adds `.env`, a transcript, or a secret assignment can have that raw content written to `patch.diff`, `output.json`, and possibly `state.json` before `sanitizePatch` rejects review/merge. That violates the stated "never in artifacts" security requirement even if merge is blocked.

**Impact:**
Secrets or transcript content can land in aisup's worker artifact directory despite a "security_denied" outcome. This is a security-control ordering bug, not just a documentation mismatch, and it will be hard to retroactively clean up if implemented as written.

**Optimal Fix:**
Pin the artifact order in Task 6/Task 10: capture the diff in memory, compute `changedFiles`, run `sanitizePatch(changedFiles, patch)` and output-tail redaction before writing any worker artifact or embedding `WorkerOutput` in state. On sanitizer failure, persist only redacted metadata/violation categories, emit `worker.security_denied`, and do not write raw `patch.diff` or raw stdout/stderr tails. If rejected worktrees are retained, document that retention is for local inspection only and add a security override to remove the worktree when forbidden content is detected.

**Why This Fix:**
It makes the security claim enforceable at the first persistence boundary. Blocking review/merge is not enough when the artifact store itself is part of the threat surface.

**Fix Validated:**
NO - [FIX UNVALIDATED] for the exact redaction implementation because `src/workers/` does not exist yet. The issue itself is validated by the plan's raw patch/output persistence contract and sanitizer placement before review/merge only.

**Validation Command or Check:**
Task 6 test: a patch adding `.env` or `api_key = "..."` emits `worker.security_denied` and leaves no raw `patch.diff` / raw patch field in `output.json` / `state.json`.

**Test Changes:**
Extend `tests/workers/worktree.test.ts` and the Task 14 security smoke case to assert forbidden patch content is not persisted in worker artifacts.

**Affected Tasks or Sections:**
Task 6; Task 8; Task 10 pipeline; Security & Isolation table row 6; Event & Observability contract for `worker.security_denied`.

---

#### HI-003: Rehydrating `MERGING` as `FAILED` can misreport an already-applied patch after a daemon restart

**Evidence:**
- Merge side effect: Task 9 runs `git -C <workspaceRoot> apply --check <patchPath>` and then `git -C <workspaceRoot> apply <patchPath>` (plan lines 504-505).
- Orchestrator approval path transitions through `MERGING → MERGED` (plan lines 528 and 774).
- Rehydration rule (plan line 530): in-flight workers, including `MERGING`, are marked `FAILED` with `worker.rehydrated_failed`.
- The plan promises approved patches apply to the main workspace and no commit is created (lines 497-505, 710, 774).

**Issue:**
`MERGING` is different from `RUNNING`/`VALIDATING`/`REVIEWING` because it performs a main-workspace side effect. If the daemon exits after `git apply` succeeds but before the orchestrator persists `MERGED`, startup sees status `MERGING` and the plan instructs it to mark the worker `FAILED`. The main workspace may already contain the patch while the durable state says it failed.

**Impact:**
The user can be told a merge failed even though files were modified. That creates incorrect recovery instructions, can hide uncommitted changes, and undermines the explicit approval/merge audit trail.

**Optimal Fix:**
Give `MERGING` a special rehydration path instead of lumping it with subprocess phases. On startup, if a worker is `MERGING`, inspect the patch against the main workspace: if `git apply --reverse --check <patchPath>` succeeds, mark `MERGED` and emit a recovery event such as `worker.rehydrated_merged` (or `worker.merged` with `reason: rehydrated`). If `git apply --check <patchPath>` succeeds, no apply occurred, so move back to `AWAITING_APPROVAL` or `FAILED` with an explicit `merge_interrupted_before_apply` reason. If neither check succeeds, keep `AWAITING_APPROVAL` and emit `worker.merge_failed` / `apply_conflict` for operator resolution. Add a test for restart after a simulated successful apply but before state persistence.

**Why This Fix:**
It reconciles durable worker state with the actual main-workspace side effect. Treating all in-flight states as failed is reasonable for lost subprocesses, but not for a phase that may already have changed user files.

**Fix Validated:**
NO - [FIX UNVALIDATED] — no worker merge code exists yet, and this review did not execute git write commands. The side-effect ordering is nevertheless confirmed by the plan's own `git apply` sequence and rehydration rule.

**Validation Command or Check:**
Task 10/Task 9 integration test: persist a `MERGING` worker whose patch has already been applied, restart/rehydrate, and assert state becomes `MERGED` rather than `FAILED`.

**Test Changes:**
Add a `tests/daemon/rehydration.test.ts` worker case for applied-before-persist and a second case for interrupted-before-apply.

**Affected Tasks or Sections:**
Task 9; Task 10 rehydration; Failure modes table; TS-001 clean merge scenario.

---

#### HI-004: Boundary audit misses content changes to pre-existing ignored files and directories

**Evidence:**
- Boundary audit plan (line 165): before/after uses `git -C <workspace_root> status --porcelain --ignored`, plus a configured forbidden sensitive-path snapshot.
- Task 6 DoD (line 445): a write to a gitignored main-tree path such as `.claude/settings.local.json` must make `auditBoundary` return `false`.
- Current `.gitignore` ignores `.env`, `.env.*`, `.claude/settings.local.json`, and `.claude/transcripts/` (`.gitignore:5-6,14-15`).
- Local temp-repo probe run during this review: after creating an ignored `.env` and `ignored-dir/file.txt`, `git status --porcelain --ignored` printed the same `!! .env` and `!! ignored-dir/` lines before and after changing their contents. The status output did not reveal the modification.
- Task 6's proposed `snapshotMainTree({workspaceRoot, worktreeDir, forbiddenSensitivePaths})` takes explicit paths, not `forbidden_path_globs`, so the plan does not define how existing `.env`, `.env.*`, transcript files, or other ignored-glob matches are enumerated and content-checked.

**Issue:**
`git status --porcelain --ignored` detects the presence of ignored files/directories, but it does not detect content changes inside ignored files that already existed before dispatch. Unless the forbidden-path snapshot explicitly expands and hashes every sensitive ignored glob before/after, a worker can modify an existing main-tree `.env` or transcript file and leave the boundary status snapshot unchanged.

**Impact:**
AC4's "worker cannot write outside allowed workspace" detection proof is incomplete for the most security-relevant ignored paths. The structural diff-scoped merge still prevents those edits from being applied through merge, but the user's real ignored file may already have been modified and the worker can still move toward validation/review as if the boundary were clean.

**Optimal Fix:**
Strengthen Task 6's boundary audit contract: expand `security.forbidden_path_globs` against the main workspace before dispatch, snapshot each matched existing file by existence + size + mtime + content hash, and repeat after the worker exits. Keep `git status --porcelain --ignored` for new ignored paths, but do not rely on it for modifications to existing ignored paths. Add explicit tests for both a newly-created ignored path and a pre-existing ignored path whose content changes.

**Why This Fix:**
It keeps the plan's current detection-based model and makes the load-bearing ignored-path claim true. Hashing configured sensitive files is narrower and cheaper than hashing every ignored file in the repo, while covering the paths the plan already promises to protect.

**Fix Validated:**
YES — the gap was reproduced in a temp git repo during review; `.gitignore` confirms the real repo has pre-existing ignored-sensitive path classes the audit is supposed to catch.

**Validation Command or Check:**
Task 6 test: create a temp git repo with a pre-existing ignored `.env`, take the boundary snapshot, modify `.env` from the fake worker, and assert `auditBoundary` returns `false` even though `git status --porcelain --ignored` is unchanged.

**Test Changes:**
Extend `tests/workers/worktree.test.ts` and Task 14 AC4 to cover both new ignored-file creation and pre-existing ignored-file modification.

**Affected Tasks or Sections:**
Task 6 boundary audit; Task 14 AC4; Security & Isolation table row "Out-of-worktree writes detected"; LO-001 default forbidden globs.

---

#### HI-005: Worker validation gates inherit the daemon's real environment instead of the worker isolation environment

**Evidence:**
- Task 7 calls `runGates(gates, { journal: taggedJournal, defaultCwd: worktree })` (plan line 461) and asserts gates run with `cwd=worktree` (line 464).
- The existing gate engine's default runner calls `execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer })` with no `env` option (`src/gates/engine.ts:13-29`).
- `GateRunner` receives only `{ cwd?: string; timeoutMs: number }` (`src/gates/types.ts:27-32`), so the engine has no built-in environment override field.
- Worker environment isolation is specified for the worker subprocess in Task 4/5 (`HOME=<worktree>/.home`, allowlisted env; plan lines 162, 396, 414), but Task 7 does not specify an equivalent custom gate runner for validation gates.

**Issue:**
H2 validation gates run in the worker worktree, but they still inherit the daemon process environment by default, including the operator's real `HOME` and any ambient secrets. A validation command that resolves `$HOME` or writes tool caches can touch the real user environment, bypassing the worker subprocess isolation rules.

**Impact:**
This weakens both the isolation model and the validation story. The plan can correctly confine the implementer CLI while the subsequent validation gate escapes through the inherited daemon env. It also makes host-gated tests less trustworthy unless they explicitly prove validation gates use the temp `HOME`/`~/.aisup` boundary.

**Optimal Fix:**
In Task 7, require worker validation to pass a custom `GateRunner` into `runGates` that mirrors the default shell-free runner but closes over a worker validation env: allowlisted variables plus isolated `HOME=<worktree>/.home` (or another per-task temp home) and no ambient spread. Keep `defaultCwd=worktree` and also apply HI-001's gate-cwd normalization. Add a test gate that prints/writes `$HOME` and assert it is the isolated worker home, not the daemon's real home.

**Why This Fix:**
It preserves reuse of `runGates` and its canonical `gate.*` events while sealing the missing environment boundary. A custom runner is already supported by the gate engine, so no competing gate engine or event shape is needed.

**Fix Validated:**
YES — the existing engine and runner type show `cwd` is injectable but `env` is not unless a custom runner closes over it; the plan does not currently specify that custom runner.

**Validation Command or Check:**
Task 7 unit test: validation gate runs `node -e 'process.stdout.write(process.env.HOME)'` and the captured stdout tail equals the isolated worker home path.

**Test Changes:**
Add validation-runner env isolation coverage to `tests/workers/validation.test.ts`; include a Task 14 smoke assertion that the real `~/.aisup` is untouched by validation gates, not only by the worker adapter.

**Affected Tasks or Sections:**
Task 7; Task 14; Security & Isolation table rows for isolated HOME and allowlisted env; Final Self-Audit validation/isolation checklist.

---

#### HI-006: Apply-conflict recovery leaves approval granted, so a later merge may not require a fresh user approval

**Evidence:**
- Worker state stores `approval: { decided, granted, by, at }` (plan line 102).
- Merge precondition is `status === 'AWAITING_APPROVAL' && approval.granted === true` (plan lines 180 and 504).
- Apply-check failure emits `worker.merge_failed` and the task stays `AWAITING_APPROVAL` (plan lines 70, 208, 511, 528).
- The plan says the user can "re-approve after rebasing/re-dispatching" (line 70) and requires explicit user approval for every merge (lines 13, 50, 679).
- No task says to clear `approval.granted` or bind approval to a specific patch attempt after `worker.merge_failed`.

**Issue:**
When `approve()` sets `approval.granted=true` and `git apply --check` later fails, the plan leaves the worker in `AWAITING_APPROVAL` but does not clear the granted approval. The durable state can therefore remain both `AWAITING_APPROVAL` and already approved.

**Impact:**
A scheduler, restart recovery path, or later manual retry can see the merge preconditions satisfied without a new explicit approval after the conflict context changed. That contradicts the "approval required for every merge" requirement and makes the "re-approve" wording false.

**Optimal Fix:**
On `worker.merge_failed`, reset approval to an undecided/non-granted state (`decided:false`, `granted:false`, `by:null`, `at:null`) or introduce an approval attempt record that is consumed by exactly one merge attempt. Document that apply conflicts require a fresh approval before another `git apply --check`/`git apply` attempt. Add tests for conflict -> approval cleared -> second merge refused until a new approval call.

**Why This Fix:**
It is the smallest state-machine correction that keeps `AWAITING_APPROVAL` re-approvable while preserving the hard user-approval invariant. It avoids adding a new `MERGE_FAILED` status, which the plan intentionally excludes.

**Fix Validated:**
YES — the approval precondition, apply-conflict status behavior, and absence of approval reset are all in the plan text.

**Validation Command or Check:**
Task 9/10 test: approve a worker whose patch conflicts, assert `worker.merge_failed`, status `AWAITING_APPROVAL`, `approval.granted === false`, and a second merge attempt is refused until `approve(id, by)` is called again.

**Test Changes:**
Extend `tests/workers/merge.test.ts` and `tests/workers/orchestrator.test.ts` with apply-conflict approval-reset coverage.

**Affected Tasks or Sections:**
Task 9; Task 10 approve/apply-conflict flow; Failure modes table; Security & Isolation approval row; TS-001/TS-004.

---

#### HI-007: Residual absolute-path writes are overclaimed as detected even though the plan's own audit cannot observe them

**Evidence:**
- Autonomous Decision 3 says an arbitrary absolute-path write such as `/tmp` or `/etc` is "detected and journaled, not OS-prevented" (plan line 49).
- The worktree boundary caveat later says the audit "cannot observe writes to arbitrary absolute paths outside `workspace_root` and outside the temp HOME" (plan line 169).
- The Security & Isolation table repeats that arbitrary absolute-path writes are "detected/journaled, not OS-prevented" (plan line 673), and the Deferred matrix repeats the same residual claim (plan line 724).
- No OS sandbox, syscall tracer, filesystem monitor, or declared list of external absolute paths exists in the plan; the only detection mechanisms are `git status --porcelain --ignored` under the workspace and snapshots of configured forbidden sensitive paths.

**Issue:**
The plan contradicts itself on a load-bearing security residual. It correctly admits in the boundary caveat that arbitrary absolute-path writes outside the workspace/temp HOME cannot be observed, but multiple higher-level sections claim those writes are still detected and journaled. Without OS sandboxing or explicit external-path monitoring, that detection is not implementable.

**Impact:**
An implementer or runbook reader can believe Phase 3 detects writes to `/tmp`, `/etc`, or another absolute path when it does not. That overstates AC4 and can produce false verification claims or fake `worker.boundary_violation` behavior that is not backed by evidence.

**Optimal Fix:**
Normalize the residual language across Autonomous Decision 3, the Security table, the Deferred matrix, Task 14 AC4, and the runbook requirements: arbitrary absolute-path writes outside `workspace_root` and outside the isolated temp HOME are **not prevented and not generally detected** in Phase 3. The enforceable guarantees are: those writes never enter the merge candidate, main-workspace/forbidden-path changes are detected by the boundary audit, and trusted CLI `$HOME` writes are redirected into the throwaway HOME. Name OS sandboxing or filesystem monitoring as the future hardening needed for arbitrary absolute-path prevention/detection.

**Why This Fix:**
It keeps the accepted threat model honest without expanding scope. It also aligns every security claim with the one detection caveat that is technically accurate.

**Fix Validated:**
YES — the contradiction is entirely in the current plan text, and the listed detection mechanisms cannot observe arbitrary absolute paths outside the workspace/temp HOME.

**Validation Command or Check:**
`rg -n "arbitrary absolute|detected and journaled|cannot observe|sandbox-exec" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`; after the plan fix, no section should claim arbitrary external absolute-path writes are detected unless a real detection mechanism is added.

**Test Changes:**
No new runtime test is required for the accepted residual. Task 14 should assert only the implementable boundary cases: main-workspace writes, configured forbidden-path writes, pre-existing ignored sensitive files, and `$HOME` containment.

**Affected Tasks or Sections:**
Autonomous Decision 3; Worktree boundary caveat; Security & Isolation table; Deferred matrix; Task 14 AC4; Task 15 runbook.

---

#### HI-008: Reviewer subprocesses have no side-effect boundary, so review can mutate the worktree after validation

**Evidence:**
- The review contract runs the reviewer adapter "via the same runner" over `{task, patch}` (plan line 176), and Task 8 repeats that `reviewWorkerOutput` runs via the Task 5 runner (plan lines 482-486).
- The Task 5 runner executes with a caller-provided `cwd` (`execFile(plan.command, plan.args, { cwd: opts.cwd, ... })`, plan line 414).
- Task 8 never states which `cwd` the reviewer receives, whether it is allowed to see the implementation worktree, whether it has a dedicated temp HOME, or whether a boundary audit runs after review.
- Task 10's pipeline reaches `VALIDATING → REVIEWING → AWAITING_APPROVAL` (plan line 527), but it does not define a reviewer-side snapshot, worktree-change check, or patch immutability check beyond the separate MD-009 artifact-hash gap.
- Task 14's seeded-bug review proof uses a fake reviewer that returns a verdict (plan line 607), not a reviewer that attempts filesystem writes.

**Issue:**
The reviewer is another LLM CLI subprocess, but the plan treats it as if it were a pure verdict parser. If the reviewer runs with `cwd=worktree`, it can modify the implementation worktree after validation and after the output patch was captured. If it runs with an accidentally wrong cwd, it can dirty the main workspace. The plan does not say whether these side effects are forbidden, ignored, re-audited, or cause rejection.

**Impact:**
This creates a second side-effecting LLM boundary after the worker implementation phase. A patch can pass validation, then a reviewer process can mutate files without those mutations being validated or intentionally merged. MD-009's patch hash would protect the merge artifact, but it does not by itself define how to handle reviewer-created filesystem side effects or dirty retained worktrees.

**Optimal Fix:**
Constrain the review runner explicitly. Preferred: run reviewers in a dedicated throwaway review directory, not the implementation worktree or main workspace, with the same isolated HOME/env discipline and the patch delivered via stdin/file. If the reviewer must run in the implementation worktree, Task 8/Task 10 must snapshot the worktree before review, audit after review, and fail closed if the reviewer changes any file or if the reviewed patch hash changes. Add a fake reviewer test that writes to its cwd and assert that the implementation worktree, main workspace, and merge artifact remain unchanged or the review is rejected.

**Why This Fix:**
It preserves cross-model review as a read-only gate instead of introducing an untracked second writer. A throwaway review directory is simpler than trying to reason about post-validation worktree mutations.

**Fix Validated:**
YES — the current plan defines runner execution and review invocation but omits reviewer cwd/side-effect semantics. The exact implementation is not present yet because `src/workers/` does not exist.

**Validation Command or Check:**
Task 8/Task 10 test: fake reviewer writes `reviewer-side-effect.txt` to its cwd; the orchestrator either rejects the review because a side effect was detected or proves the write happened only in a throwaway review directory and cannot affect the implementation worktree/main workspace/patch artifact.

**Test Changes:**
Extend `tests/workers/review.test.ts` and `tests/workers/orchestrator.test.ts` with reviewer side-effect containment. Extend Task 14 smoke coverage if the reviewer runs against any real filesystem workspace.

**Affected Tasks or Sections:**
Task 8; Task 10 pipeline; Task 14 seeded-bug/cross-model review proof; Security & Isolation table; Final Self-Audit reviewer/isolation entries.

---

### MEDIUM

#### MD-001: Slack `!deny` collides with the existing permission-denial command; `!approve` is inconsistent with the existing `!permit`

**Evidence:**
- `src/slack/commands.ts:1` — `KNOWN_COMMANDS = new Set(['interrupt','stop','status','cmd','relay','help','confirm','failover','permit','deny','gate'])`. `deny` already exists; `approve` does not — permission *approval* is `permit`.
- `src/slack/service.ts:380-388` — `case 'deny'` maps `!deny` to **permission** denial: `onPermissionDeny(session.aisup_session_id)`, requires an active session, takes **no id argument**.
- `src/slack/service.ts:370-377` — `case 'permit'` is the permission **approval** verb.
- Plan Task 13 (line 587): "Add `worker`, `approve`, `deny` to `KNOWN_COMMANDS`; add dispatch cases" and `!approve <id>` / `!deny <id>`.

**Issue:** `!deny <id>` for worker denial directly overloads the existing `!deny` permission command. The plan does not specify how the dispatcher disambiguates "bare `!deny` = permission" vs "`!deny <uuid>` = worker," so a literal implementation either breaks the permission flow or silently routes worker ids into `onPermissionDeny`. `!approve` also diverges from the established `!permit` convention for no reason.

**Impact:** Regression risk to the verified Phase 2 permission-fallback flow (Feature F), or an ambiguous command surface. Task 13 is explicitly optional/deferrable, which caps the blast radius, but as written the design conflicts with shipped code.

**Optimal Fix:** Route worker actions through the single new `worker` command as subcommands — `!worker status`, `!worker approve <id>`, `!worker deny <id>` — mirroring the existing `!gate status` subcommand dispatch (`src/slack/service.ts:390-395`). Add only `worker` to `KNOWN_COMMANDS`; do **not** add top-level `approve`/`deny`. Update Task 13's command list and DoD accordingly.

**Why This Fix:** It reuses an in-repo precedent (`!gate status`), eliminates the collision entirely, keeps one verb namespace, and avoids touching the permission commands. No new ambiguity rule is needed.

**Fix Validated:** YES — `!gate status` subcommand pattern verified at `src/slack/service.ts:390-395`; collision verified at `commands.ts:1` and `service.ts:380-388`.

**Validation Command or Check:** `grep -n "case 'gate'" src/slack/service.ts` (precedent); `grep -n "deny\|permit" src/slack/commands.ts` (collision).

**Test Changes:** Task 13's `tests/slack/service.test.ts` cases assert `!worker approve <id>`/`!worker deny <id>`/`!worker status` rather than `!approve`/`!deny`.

**Affected Tasks or Sections:** Task 13; CLI/API/Slack Surfaces section (line 194).

---

#### MD-002: Dispatch return semantics and the QUEUED→RUNNING promotion trigger are unspecified — risks a blocking API handler and a stuck queue

**Evidence:**
- Plan Task 10 (line 527): `dispatch(taskInput)` "create `QUEUED` state … then (respecting `max_concurrent`) emit `worker.dispatched`, run `RUNNING → IMPLEMENTED` … → `AWAITING_APPROVAL`; persist + emit at each transition."
- Plan Task 12 (line 569): `POST /api/workers` → `dispatchWorker`.
- Adapter `timeout_seconds` default `1800` (Config Contract, line 242) — a worker can run up to 30 minutes.
- Concurrency rule (line 186): "at most `max_concurrent` workers in non-terminal active phases; excess stay `QUEUED`."
- TS-001 step 1 (line 772): "Worker created `QUEUED`, then advances to `AWAITING_APPROVAL`."

**Issue:** Two coupled gaps: (1) The plan never states that `dispatch()` returns the worker id **immediately** (persisting `QUEUED`) and drives the pipeline **asynchronously**. A literal "run the pipeline, then return" implementation makes `POST /api/workers` (and the CLI `fetch`) block for the worker's full runtime — up to the 1800s timeout — exceeding HTTP/socket timeouts. (2) No task names what **promotes a `QUEUED` worker to `RUNNING`** when a `max_concurrent` slot frees. `dispatch()` checks the slot at dispatch time, but with `max_concurrent: 2` and a 3rd worker queued, nothing in the plan starts it when worker 1 finishes — the orchestrator needs a scheduler/pump.

**Impact:** Without explicit async semantics, the implementer may build a blocking handler (bad UX, timeouts). Without a promotion trigger, queued workers stall indefinitely. Both are implementer-readiness gaps that the deterministic fake-adapter tests (instant runs) would not catch.

**Optimal Fix:** In Task 10, state that `dispatch()` persists `QUEUED`, returns the worker id immediately, and the orchestrator advances the pipeline in the background (fire-and-forget with failures captured to `FAILED`/`REJECTED`). Add a one-line scheduler contract: on daemon startup/rehydration and on every transition to a terminal/`AWAITING_APPROVAL` state, the orchestrator starts the next `QUEUED` worker if a slot is free. **Also pin which states count toward `max_concurrent`** — the plan's "non-terminal active phases" (line 186) is ambiguous about `AWAITING_APPROVAL`: if it occupies a slot, a worker awaiting approval for hours blocks all new dispatches; if it does not, the slot-freeing trigger must fire when a worker *reaches* `AWAITING_APPROVAL`, not only on terminal transitions. State explicitly that `AWAITING_APPROVAL` (and the paused apply-conflict case) does **not** hold a slot, and that reaching it triggers promotion. In Task 12, state `POST /api/workers` returns the created `QUEUED` worker (e.g. `202`/id) without awaiting completion; progress is observed via `GET /api/workers/:id` and journal events.

**Why This Fix:** It matches the daemon's existing async/loop-driven model and the concurrency intent already in the plan; it only makes the implied behavior explicit, avoiding a blocking-await build.

**Fix Validated:** YES (design consistency) — concurrency model is in the plan; async daemon precedent exists (`src/daemon/loop-manager.ts`, late-bound refs at `src/daemon/index.ts:301`).

**Validation Command or Check:** Re-read Task 10/Task 12 after edit; confirm dispatch return value and slot-promotion trigger are stated.

**Test Changes:** Orchestrator test (Task 10) asserts `dispatch` returns before the pipeline completes (inject a slow fake runner), that a 3rd worker with `max_concurrent:2` starts after one of the first two reaches `AWAITING_APPROVAL`/terminal, and that rehydrated `QUEUED` workers are pumped on startup when slots are free.

**Affected Tasks or Sections:** Tasks 10, 12; Orchestrator/Concurrency section (lines 184-188); TS-001.

---

#### MD-003: `.home/` exclusion from the captured patch is the linchpin of HOME-isolation's *merge*-safety, but is under-specified and under-tested

**Evidence:**
- Isolation rules (line 162): the worker runs with `HOME=<worktree_dir>/<task-id>/.home` — a throwaway dir **inside the worktree**.
- Output capture (line 163) / Task 6 (line 435): `git -C <worktree> add -A -N` then `git -C <worktree> diff <base_ref>`, "excluding `.home/`".
- Merge candidate is the captured patch (`WorkerOutput.patch`, applied verbatim by Task 9 `git apply`).
- Task 6 DoD (line 446): asserts a `$HOME` write lands in `.home` and the real `~/.claude` is untouched — but there is **no** assertion that `.home/` content is **absent from the captured patch**.

**Issue:** `.home/` lives inside the worktree, so `git add -A -N` will stage it and `git diff` will include it unless excluded across **all three** capture calls (`add`, `diff`, `diff --name-only`). If the exclusion is incomplete, the worker's throwaway-HOME writes (e.g. a CLI writing `~/.claude/settings.local.json` → `.home/.claude/settings.local.json`) enter the patch and are applied to the operator's **real** workspace on merge — silently defeating the isolation guarantee. The plan states "excluding `.home/`" but not the mechanism, and the DoD verifies real-home safety, not patch-absence.

**Impact:** A partial exclusion is a real isolation hole that the current DoD would not detect (the real home stays untouched while the contamination rides in via the patch). Security-load-bearing.

**Optimal Fix:** In Task 6, specify the exclusion mechanism applied consistently to `git add`, `git diff`, and `git diff --name-only` — e.g. a worktree-local `.git/info/exclude` entry for `.home/` plus a `:(exclude).home/` pathspec on the diff/name-only calls. Add a DoD line + test: a `$HOME`-resolved write into `.home/` produces **no** entry in `WorkerOutput.patch` / `changed_files` (so it can never reach merge). **Same exclusion class applies to the `prompt_via: 'file'` temp file:** Task 4's builder receives `worktreePath` and "returns the intended file path" (plan line 395) without pinning a location; if the runner (Task 5) writes that prompt file *inside* the worktree it becomes a second contamination source. Specify that the prompt file lives **outside** the captured tree (e.g. under the worker's state dir `~/.aisup/workers/<id>/` or `os.tmpdir()`), or is covered by the same exclusion + patch-absence test.

**Why This Fix:** Closing the merge path is what actually enforces the guarantee; verifying patch-absence (not just real-home safety) is the assertion that catches an incomplete exclusion.

**Fix Validated:** [FIX UNVALIDATED] — no worktree code exists yet (`grep -rn worktree src/` returns nothing), so the exact git invocation can't be run against real code now. The git mechanism (info/exclude + `:(exclude)` pathspec) is standard and well-defined.

**Validation Command or Check:** During implementation: create a worktree, write `.home/.claude/x`, run capture, assert the path is absent from patch + `--name-only`.

**Test Changes:** Add the patch-absence assertion to `tests/workers/worktree.test.ts` (Task 6) and the AC4 smoke case (Task 14).

**Affected Tasks or Sections:** Task 6 (lines 435, 446); Task 4 (line 395, prompt-file path); Task 5 (line 414, prompt-file write/delete); Security table row 2 (line 672); Task 14 AC4.

---

#### MD-004: Patch secret-content scanning reuses a module-private, key-name-anchored regex that does not fit free-text scanning; `sanitizePatch` lacks the paths needed for glob matching

**Evidence:**
- `src/journal/writer.ts:5` — `const SECRET_KEY_PATTERN = /^(.*_)?(token|secret|apikey|api_key|authorization|password|bot_token|app_token|signing_secret)$/i;` — **module-private (not exported)**, anchored `^…$`, and applied by `scanForSecrets` (writer.ts:7-25) to **object key names** via `Object.entries`, not to text.
- Plan Task 6 (line 170): "scan the patch for forbidden paths … and secret-key content patterns (reuse the `SECRET_KEY_PATTERN` family from `src/journal/writer.ts`)."
- Plan architecture (line 440): "`sanitizePatch` reuses the journal secret-key pattern family + `forbidden_path_globs` via `picomatch`."
- `sanitizePatch(patch, forbiddenGlobs)` (line 435) is given the **patch text only** — no file-path list — yet `picomatch` matches **paths**.

**Issue:** Two precision gaps: (1) `SECRET_KEY_PATTERN` is not exported, so "reuse … from `src/journal/writer.ts`" can't be a literal import (Task 6 doesn't list `writer.ts` as modified to export it); and even if exported, its `^…$` anchoring tests a *complete object key* and matches **nothing** when run over diff lines like `+const apiKey = "sk-…"`. Reusing it verbatim yields a sanitizer that catches no content. (2) `sanitizePatch` needs the changed-file **paths** to apply `forbidden_path_globs`, but the signature only receives raw patch text; it must parse `+++ b/<path>` lines or be passed `changedFiles` (which `captureDiff` already returns, line 435).

**Impact:** Taken literally, the secret-content half of the "secrets never in artifacts" guarantee is non-functional, and glob path-matching has no path input. This undermines a stated security control and will cause rework when the implementer discovers the symbol isn't exported / the regex matches nothing.

**Optimal Fix:** In Task 6: (a) define a **content-oriented** secret scan for patch text — reuse the *keyword list* (token|secret|api_key|password|authorization|…) in a line-oriented form (e.g. `(token|secret|api[_-]?key|password|authorization)\s*[:=]`), and either export `SECRET_KEY_PATTERN`/the keyword list from `writer.ts` (add it to Task 6's modified files) or duplicate the keyword list with a comment linking the two; (b) change `sanitizePatch` to accept `changedFiles` (from `captureDiff`) for `picomatch` glob matching, or parse paths from the diff headers explicitly.

**Why This Fix:** It separates path-glob matching (needs paths) from content scanning (needs a text regex), and removes the false "reuse the existing pattern" claim that would otherwise produce a no-op sanitizer.

**Fix Validated:** YES — verified `SECRET_KEY_PATTERN` is a private const and `scanForSecrets` is key-name-oriented (`src/journal/writer.ts:5-25`); `captureDiff` already returns `changedFiles` (plan line 435).

**Validation Command or Check:** `grep -n "export" src/journal/writer.ts` (confirms the const isn't exported); unit test: a patch line containing `api_key = "…"` is flagged; a `*.pem` changed path is flagged via `changedFiles`.

**Test Changes:** Task 6 sanitize test asserts a secret **assignment line** is caught (not just a forbidden path) and a forbidden path is matched from `changedFiles`.

**Affected Tasks or Sections:** Task 6 (lines 170, 435, 440, 448); Task 8 sanitize-before-review (line 483); Security table rows 6-7.

---

#### MD-005: Validation gates run with `cwd=worktree`, but a fresh `git worktree` checkout has no installed dependencies — H₂ against a realistic gate is unproven

**Evidence:**
- Task 7 (line 464): gates run with "`cwd = worktree` so tests execute against the worker's changes in isolation, not the main tree."
- Worktree is created via `git -C <workspace_root> worktree add --detach <worktree_dir>/<task-id> <base_ref>` (line 160) — a clean checkout; gitignored artifacts (`node_modules/`, `.venv/`, build output) are **not** present.
- Deterministic tests use a fake gate (`node -e` script, Task 14 line 605) that needs no dependencies.
- `worktree_dir` must be relative, no `..`, no leading `/` (line 282) ⇒ the worktree is **always nested under `workspace_root`**.

**Issue:** A configured real gate (e.g. `npm test`, `tsc`, `pytest`) running in the worktree finds no local `node_modules`/venv. For Node specifically the worktree's nesting under `workspace_root` means Node's upward `node_modules` resolution *can* reach `<workspace_root>/node_modules`, which often makes npm-based gates work — but this is **unstated, fragile, and ecosystem-specific** (pnpm, Yarn PnP, Python venvs, Go module/build caches resolve differently and may silently use the wrong toolchain). The plan neither documents the assumption nor tests a dependency-requiring gate, so the H₂ "validate the worker's changes" capability is proven only against trivial fake gates.

**Impact:** AC5 (failed gate blocks merge) is satisfied by a fake required gate that exits non-zero — that proves the *wiring*. But an operator enabling real validation gates may hit "command not found / module not found" immediately, and the plan gives no guidance. Operability gap for a headline feature.

**Optimal Fix:** Add a note to Task 7 + the runbook (Task 15) documenting that gates execute in a fresh nested worktree without locally-installed dependencies; Node resolves the parent repo's `node_modules` via upward lookup (worktree is nested under `workspace_root`), while other ecosystems require the gate command to perform its own setup (or run an install step). Add one deterministic gate test that depends on a resolvable artifact in the parent tree to prove the resolution path, not just an exit code.

**Why This Fix:** It converts a hidden load-bearing assumption into a documented, tested contract, and sets operator expectations without expanding scope (no dependency-install machinery added).

**Fix Validated:** YES (mechanism) — worktree nesting under `workspace_root` is guaranteed by the relative-`worktree_dir` rule (line 282); Node upward resolution is standard. Non-npm caveats are real.

**Validation Command or Check:** During implementation: in a worktree under a repo with `node_modules`, run a gate that requires a dep and assert resolution; document the result in `WORKER_HOST_GATES.md`.

**Test Changes:** Add a dependency-resolution gate case to `tests/workers/validation.test.ts` (Task 7) or the smoke suite (Task 14).

**Affected Tasks or Sections:** Task 7 (line 464); Task 15 runbook (line 630); Task 14.

---

#### MD-006: `cancel()` is documented as reachable "from any non-terminal state," but the runner has no subprocess-termination hook and the completion-after-cancel race is unhandled

**Evidence:**
- State machine (plan line 68): "**CANCELLED** is reachable by user request from any non-terminal state." Terminal set excludes it being a mid-run no-op.
- Orchestrator (line 528): "`cancel(id)`: … `CANCELLED` + cleanup on cancel."
- Runner (Task 5, lines 414-416): `runWorker(plan, opts)` is modeled on the gate engine's `defaultGateRunner` and returns `{ code, stdout, stderr, timedOut }`. No `AbortSignal`, no child handle, no kill path is part of the contract.
- Verified precedent: `src/gates/engine.ts:13-29` (`defaultGateRunner`) and `src/runner/builder.ts` expose **no** `AbortSignal`/`.kill()`/`AbortController` — confirmed by `grep -rnE "AbortSignal|abort|\.kill\(|AbortController" src/gates/engine.ts src/runner/builder.ts` returning nothing. The runner the plan says to mirror cannot be cancelled.
- Orchestrator DoD (line 534) tests `cancel → CANCELLED` only with **instant fake adapters**, so a cancel issued while a real subprocess is mid-flight (`RUNNING`/`VALIDATING`/`REVIEWING`) is never exercised.

**Issue:** For `QUEUED` (never started) and `AWAITING_APPROVAL` (paused, no live process) cancellation is trivial — flip state + clean up. But for `RUNNING`/`VALIDATING`/`REVIEWING` there is a live `execFile` child (worker CLI, a gate, or the reviewer CLI), and the plan provides **no mechanism to terminate it** and **no rule for the race** where that child completes *after* the user cancelled. As written, an implementer either (a) builds a `cancel()` that only flips the state record while the subprocess keeps running to its `timeout_seconds` (up to 1800s) — and may then have a late completion overwrite `CANCELLED` with `IMPLEMENTED`/`AWAITING_APPROVAL`, or even attempt cleanup of a worktree still in use — or (b) discovers late that the Task 5 runner needs abort support it was never speced to have.

**Impact:** A stated user-facing capability (cancel an in-flight worker) is either non-functional for the states where it matters most, or silently races with pipeline completion — a correctness and resource-lifetime gap (a "cancelled" worker still consuming a `max_concurrent` slot and holding a worktree). This is exactly the class of bug the fake-adapter tests cannot catch.

**Optimal Fix:** Pick one and state it in Task 10 (and reflect it in Task 5 if abort is chosen):
1. **Cooperative-cancel (consistent with the no-abort engine precedent):** `cancel()` records `CANCELLED`; the orchestrator marks the worker cancelled and, on subprocess completion, checks `status === 'CANCELLED'` and **discards** the result (no further transition, run cleanup then). The in-flight child is bounded by `timeout_seconds` and its output is dropped. Document that an in-flight subprocess is not force-killed.
2. **Hard-cancel:** add an optional `AbortSignal` to the Task 5 `runWorker` contract (and pass `{ signal }` to `execFile`), have `cancel()` abort the controller for the worker's current child, then transition to `CANCELLED`.
Either way, add a Task 10 DoD line + test using a **slow** fake runner: a cancel during `RUNNING` ends in `CANCELLED`, the slot is freed, the worktree is cleaned per `retention`, and a late completion does **not** resurrect the worker.

**Why This Fix:** It removes the gap between the documented "cancel from any non-terminal state" and an implementable mechanism, and explicitly resolves the completion-after-cancel race that the instant-fake tests hide. Option 1 matches the existing run-to-timeout engine model (lowest risk); option 2 is cleaner if responsiveness matters.

**Fix Validated:** YES (gap) — verified no abort/kill in the engine + runner the plan mirrors; verified the cancel DoD uses fakes only. The chosen-fix details are `[FIX UNVALIDATED]` (no `src/workers/` runner exists yet).

**Validation Command or Check:** `grep -rnE "AbortSignal|\.kill\(|AbortController" src/gates/engine.ts src/runner/builder.ts` (confirms no abort precedent). During implementation: a slow-runner cancel test asserts state, slot, and worktree outcomes.

**Test Changes:** Add the slow-runner cancel test to `tests/workers/orchestrator.test.ts` (Task 10); the runner abort test to `tests/workers/runner.test.ts` if option 2 is chosen.

**Affected Tasks or Sections:** Task 10 (lines 528, 534); Task 5 (lines 414-416); State machine (line 68); Concurrency (line 186 — a cancelled-but-running worker and slot accounting).

---

#### MD-007: Review config permits fail-open parse behavior and carries an unused cross-model flag

**Evidence:**
- Config defaults include `review.require_cross_model: true`, `allow_same_model_review: false`, and `parse_failure_verdict: "reject"` (plan lines 265-268).
- The behavior sections consume `allow_same_model_review` and `parse_failure_verdict` (plan lines 177-178, 484-485), but `require_cross_model` appears nowhere else in the plan.
- Validation rules explicitly allow `review.parse_failure_verdict` to be either `approve` or `reject` (plan line 286).
- The plan repeatedly describes review parsing as fail-closed: parse failure is in the "Review rejects / parse fails" failure row (line 206), Task 8 says unparseable reviewer output yields the configured fail-closed verdict (line 491), and the final self-audit calls review "fail-closed" (line 731).

**Issue:**
Two review-policy knobs conflict with the stated contract. `require_cross_model` is dead config unless a task defines how it differs from `allow_same_model_review`. More importantly, allowing `parse_failure_verdict: "approve"` creates a deliberate fail-open path for unparseable reviewer output, contradicting the plan's "parse failure ⇒ reject" / "fail-closed" language.

**Impact:**
An implementer following the Config Contract can ship a setting that lets a broken reviewer adapter approve a patch without producing a valid verdict. That weakens the cross-model review gate and makes tests that assert fail-closed parsing ambiguous.

**Optimal Fix:**
Remove `review.parse_failure_verdict` as a configurable option or force it to the only allowed value, `"reject"`. Drop `review.require_cross_model` unless it has a distinct validated meaning; the current `allow_same_model_review` flag already expresses the degraded same-model fallback policy. If both fields remain, add exact validation semantics and tests for each.

**Why This Fix:**
Fail-closed review should be a hard safety property, not an operator-tunable footgun. Removing the unused flag and fail-open value simplifies the config and aligns tests with the architecture prose.

**Fix Validated:**
YES — plan grep confirms `require_cross_model` is only in the defaults, and `parse_failure_verdict` is allowed to be `approve` despite fail-closed prose.

**Validation Command or Check:**
`grep -n "require_cross_model\\|parse_failure_verdict" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`; Task 2 loader test rejects `parse_failure_verdict: approve`.

**Test Changes:**
Update `tests/config/loader.test.ts` and `tests/workers/review.test.ts` so parse failure always rejects.

**Affected Tasks or Sections:**
Config Contract; Task 2; Task 8; Final Self-Audit checklist.

---

#### MD-008: `prompt_via: file` has no way for the runner to know what content to write

**Evidence:**
- `buildWorkerCommand` returns `{ command, args, env, stdin, promptFile }` (plan line 148); there is no `promptText` / `promptContent` field.
- Task 4 says `prompt_via: "file"` returns a prompt-file path and args, but the builder does not write the file because it is pure (plan line 395).
- Task 5 says when `plan.promptFile` is set, the runner writes "the prompt" to that file before spawn (plan line 414), but `runWorker(plan, opts)` receives only the built launch plan and `opts`, not the original `WorkerTask.prompt`.

**Issue:**
The file-prompt adapter mode is not implementable as specified. The builder is intentionally pure and does not write the file, while the runner is assigned file I/O but does not receive the prompt text. A literal implementation must either invent a hidden dependency on the task or write an empty file.

**Impact:**
Adapters configured with `prompt_via: file` will not receive the task prompt, and tests for file prompt delivery cannot be written against the current interface. This also compounds MD-003's prompt-file placement risk because the plan has not defined the file's content or location contract.

**Optimal Fix:**
Extend the built launch plan with explicit prompt-file content, e.g. `{ promptFile: { path, contents } | null }`, or keep `{ promptFile }` and add `promptContent: string | null`. The runner writes that content to a path outside the captured worktree (or an explicitly excluded path per MD-003) and deletes it in `finally`. Alternatively, move file writing into a separate adapter-prep function that is allowed to do I/O and returns the final launch plan.

**Why This Fix:**
It preserves the pure builder boundary while making the runner's responsibility executable and testable. Passing the content explicitly is clearer than letting the runner reach back into the original task.

**Fix Validated:**
YES — the return type and Task 5 runner contract are both in the plan and lack prompt content.

**Validation Command or Check:**
Re-read Task 4/Task 5 after edit; `tests/workers/runner.test.ts` asserts the file contains the exact prompt before child execution and is deleted after.

**Test Changes:**
Add file-prompt content delivery coverage to `tests/workers/adapter.test.ts` and `tests/workers/runner.test.ts`.

**Affected Tasks or Sections:**
Task 4; Task 5; Worker adapter interface.

---

#### MD-009: The reviewed/approved patch is not bound to the merge artifact by hash

**Evidence:**
- `WorkerOutput` stores both raw `patch` and `patch_path` (plan lines 113-114).
- Output artifacts are persisted as `patch.diff` and `output.json` under `~/.aisup/workers/<id>/` (plan line 175).
- Review uses the patch embedded in the reviewer prompt (Task 8, line 482), while merge applies `patchPath` with `git apply --check` and `git apply` (Task 9, lines 504-505).
- No `patch_sha256`, immutable artifact check, or "verify patch file still equals reviewed output" precondition appears in `WorkerOutput`, Task 8, Task 9, or Task 10.

**Issue:**
The plan validates and reviews a patch, but the merge step reads a mutable patch file from disk with no integrity check tying it back to the reviewed/sanitized output. If `patch.diff` is accidentally rewritten, truncated, or otherwise diverges between review and merge, Task 9 can apply content that was not the reviewed patch.

**Impact:**
This undermines the core "reviewed by a different model, then approved, then applied" guarantee. The local artifact directory is user-owned and not an adversarial boundary, but accidental or implementation-induced artifact drift is enough to create an unreviewed merge.

**Optimal Fix:**
Add `patch_sha256` (and optionally `patch_bytes`) to `WorkerOutput`; compute it immediately after sanitization and before review. Persist the hash in `state.json`/`output.json`, include it in approval display, and have Task 9 re-read `patch_path` and require the hash to match before `git apply --check`. Alternatively, merge from the sanitized in-state patch text and treat `patch.diff` as a display artifact only.

**Why This Fix:**
A content hash is a small addition that preserves the current artifact design while making validation, review, approval, and merge refer to the same bytes. It is simpler than adding an immutable artifact store.

**Fix Validated:**
NO - [FIX UNVALIDATED] — no worker artifact code exists yet. The issue is validated by the plan's separate `patch`/`patch_path` fields and merge-from-file contract with no hash precondition.

**Validation Command or Check:**
Task 9 test: after a worker reaches `AWAITING_APPROVAL`, mutate `patch.diff`, approve, and assert merge is refused with a hash-mismatch event/reason before `git apply --check` runs.

**Test Changes:**
Add patch-hash mismatch coverage to `tests/workers/merge.test.ts` or `tests/workers/orchestrator.test.ts`.

**Affected Tasks or Sections:**
WorkerOutput schema; Task 6 capture/persistence; Task 8 review; Task 9 merge; Task 10 approval pipeline.

---

#### MD-010: Disabled reviewer fallback is ambiguous, so the one-adapter degraded path may never be reached

**Evidence:**
- Config defaults set `routing.default_implementer: "codex"` and `default_reviewer: "gemini"` while every adapter preset is disabled by default (plan lines 233-268).
- Runtime routing says implementer/reviewer must reference enabled adapters, and reviewer defaults to a model `!= implementer` (plan lines 185-186).
- The degraded-review contract says when only one adapter is enabled, set `degraded:true`; with `allow_same_model_review=false`, review cannot pass and emits `worker.review_degraded` (plan lines 177, 207, 484, 490).
- Loader validation only says `default_reviewer` must name a defined adapter (plan line 285), not an enabled one.

**Issue:**
The plan does not state what happens when the configured `default_reviewer` names a disabled adapter, which is the default shape if an operator enables only `codex`. One reading rejects dispatch because the reviewer is not enabled; another silently falls back to the implementer and reaches the degraded-review policy. Those are materially different user-visible outcomes.

**Impact:**
The one-model path can be implemented as an adapter-resolution error instead of the planned `worker.review_degraded` rejection, producing confusing config behavior and tests that disagree with the failure-mode table.

**Optimal Fix:**
Pin routing semantics in Task 2/Task 4/Task 10: implementer must resolve to an enabled adapter; reviewer resolution first tries the configured reviewer when enabled, otherwise selects another enabled adapter, otherwise falls back to the implementer with `degraded:true`. If a by-task reviewer explicitly names a disabled adapter and strictness is desired, reject with a clear config/runtime error; otherwise document that disabled reviewers are treated as unavailable. Add tests for "only codex enabled, default_reviewer gemini disabled" and for an explicit disabled by-task reviewer.

**Why This Fix:**
It preserves the stated degraded same-model safety policy and removes an ambiguity that will otherwise surface immediately for the default placeholder config.

**Fix Validated:**
YES — the default reviewer, enabled-adapter rule, and degraded-review policy are all present in the plan and currently conflict by omission.

**Validation Command or Check:**
Task 4 routing test: with only `codex.enabled=true` and default reviewer `gemini.enabled=false`, `resolveRouting` returns reviewer `codex` with degraded true, and Task 8 rejects when `allow_same_model_review=false`.

**Test Changes:**
Extend `tests/workers/adapter.test.ts` and `tests/workers/review.test.ts` with disabled-reviewer fallback cases.

**Affected Tasks or Sections:**
Config Contract; Task 2 loader validation; Task 4 routing; Task 8 same-model policy; Failure modes table.

---

#### MD-011: `worktree_dir` validation allows reserved paths like `.` and `.git`

**Evidence:**
- Validation rules only require `worktree_dir` to be relative, contain no `..`, and have no leading `/` (plan line 282).
- Worktree creation uses `<worktree_dir>/<task-id>` (plan line 160), and cleanup validates paths as being under `worktree_dir` before `git worktree remove --force` (plan lines 171 and 438).
- The current repo has a real `.git` directory and a root `.gitignore`; `.aisup-workers/` is not currently ignored and is planned to be added by Task 6 (`.gitignore:1-18`, plan line 441).

**Issue:**
The stated validation permits `worktree_dir: "."`, `worktree_dir: ".git"`, or paths under `.git`. `.` makes the allowed cleanup boundary the main workspace root rather than a dedicated worker container, and `.git` places worktree contents under git metadata. Both contradict the isolation intent even though they pass the stated "relative/no `..`/no leading slash" rule.

**Impact:**
An operator typo or config mistake can put worker directories in dangerous locations and weaken the safety of the path validation that guards `worktree remove --force`. This is likely caught during implementation or tests, but the plan should reject it up front.

**Optimal Fix:**
Expand Task 2/Task 6 validation: reject empty string, `.`, paths with a `.git` segment, paths that resolve equal to `workspace_root`, and paths that are not matched by an explicit `.gitignore` entry. Keep the existing symlink-component and escape checks. Add tests for `.`, `.git`, `.git/workers`, and the normal `.aisup-workers` default.

**Why This Fix:**
It keeps worker cleanup scoped to a dedicated ignored container and avoids making git metadata or the main workspace a valid worker root.

**Fix Validated:**
YES — the plan's validation rule omits reserved-path rejection; the repo's `.git` and `.gitignore` layout confirm the reserved paths are meaningful in this project.

**Validation Command or Check:**
Task 2/Task 6 test: invalid `worktree_dir` values `.`, `.git`, and `.git/workers` are rejected before any git command is run.

**Test Changes:**
Add invalid-worktree-dir cases to `tests/config/loader.test.ts` and `tests/workers/worktree.test.ts`.

**Affected Tasks or Sections:**
Config Contract; Task 2; Task 6 create/remove path validation; Security & Isolation cleanup row.

---

#### MD-012: The plan forbids automatic `git add` while relying on `git add -A -N` to capture new files

**Evidence:**
- Non-goals forbid direct git writes, including `add`/`commit`/`push`, and say merge applies a working-tree patch only (plan line 36).
- Autonomous Decision 4 says "No `add`/`commit`/`push` by aisup" (plan line 50), and the deferred matrix/final checklist repeat "No `git add/commit/push` performed by aisup" (plan lines 723 and 738).
- Task 6's output capture requires `git -C <worktree> add -A -N` so new files appear in the diff (plan lines 163 and 435).
- The Security & Isolation table's allowed git verbs list omits `git add -N`, saying only `worktree add/remove`, `diff`, `status`, and `apply[ --check]` are automatic (plan line 678).

**Issue:**
The plan has a policy contradiction. Capturing new untracked files in a git diff commonly needs intent-to-add, and Task 6 correctly names `git add -A -N`; other sections then forbid any automatic `git add` and omit it from the allowed-verb list. A literal implementer can either violate the policy text or remove `git add -N` and fail to include new files in worker patches.

**Impact:**
This can cause rework in the isolation-critical worktree task, and it can produce false security-review objections because the plan says `git add` is forbidden while using it. The risk is lower than a main-workspace `git add` because this operation is scoped to the isolated worker worktree, but the distinction must be explicit.

**Optimal Fix:**
Clarify that the `git add` prohibition applies to the main workspace and to permanent user-facing git state. Add a narrow exception: `git add -A -N` is permitted only inside the isolated worker worktree, only for intent-to-add diff capture, and never in the main workspace. Update the Security table's allowed git verbs to include `add -N` under that scoped exception, and add a Task 6 test that a new untracked file appears in the patch while the main workspace index remains untouched.

**Why This Fix:**
It preserves the necessary diff-capture mechanism while keeping AGENTS rule 10 and the no-auto-commit policy intact. The alternative is a more complex custom untracked-file diff assembler with no clear benefit for Phase 3.

**Fix Validated:**
YES — the contradiction is in the current plan text; no worker code exists yet.

**Validation Command or Check:**
`rg -n "git -C <worktree> add|No .*add|git add/commit/push|worktree add/remove" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`; after the plan fix, the only automatic `git add` allowed should be the worktree-local `git add -A -N` exception.

**Test Changes:**
Extend `tests/workers/worktree.test.ts`: create an untracked file in the worker worktree, capture the diff, assert the file appears in the patch/changed files, and assert the main workspace index/status is unchanged except for the ignored worktree dir.

**Affected Tasks or Sections:**
Non-goals; Autonomous Decision 4; Task 6 output capture; Security & Isolation table; Deferred matrix; Final Self-Audit checklist.

---

#### MD-013: `base_ref` is not resolved to an immutable commit before worktree creation and diff capture

**Evidence:**
- `WorkerTask.base_ref` is a string "git ref the worktree branches from (default: HEAD)" (plan line 86).
- Worktree creation uses `git -C <workspace_root> worktree add --detach <worktree_dir>/<task-id> <base_ref>` (plan line 160).
- Output capture later uses `git -C <worktree> diff <base_ref>` / `diff --name-only <base_ref>` (plan lines 113, 163, 435).
- There is no `base_sha`, `base_commit`, or `rev-parse` step in the plan; `grep -n "base_sha\|rev-parse" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md` returns no plan contract for immutable base capture.
- Current repo check confirms the immutable base is readily available: `git rev-parse --verify HEAD^{commit}` returned `3d77246d1c24388ac7362ceea8b90f14f0da2f10`.

**Issue:**
The plan uses the same user-provided `base_ref` string at two different times: once to create the detached worktree and later to compute the diff. That is stable only when the ref expression resolves to the worktree's own `HEAD` or an immutable SHA. If `--base main`, another branch, or a tag is used and that ref moves while the worker is running, `git diff <base_ref>` is computed against a different commit than the one used to create the worktree.

**Impact:**
The worker patch can include unrelated reverse changes, omit expected changes, or otherwise stop representing "worker changes from the dispatch base." Review, approval, and merge would then refer to a patch whose base was not the captured worktree base. This is separate from LO-006's argument-validation issue: a syntactically valid branch name can still move.

**Optimal Fix:**
Resolve and store an immutable base at dispatch/create time: `git -C <workspace_root> rev-parse --verify <base_ref>^{commit}` -> `base_sha`. Store both the requested `base_ref` and resolved `base_sha` in `WorkerTask`/`WorkerState`; create the worktree from `base_sha`; compute `git diff <base_sha>` and `diff --name-only <base_sha>`; include `base_sha` in worker events/approval display. Add a Task 6 test that moves a branch after worktree creation and proves `captureDiff` still diffs against the original `base_sha`.

**Why This Fix:**
It keeps the existing operator-facing `--base` affordance while making the worker artifact deterministic. Resolving once is cheaper and safer than trying to reason about moving refs at review or merge time.

**Fix Validated:**
YES — the current plan uses `base_ref` directly for both create and diff and defines no immutable base field. The exact code placement is implementation-time because `src/workers/` does not exist yet.

**Validation Command or Check:**
Task 6 test: create a temp repo branch, dispatch from that branch, advance the branch, then assert captured patch is still relative to the stored `base_sha`, not the moved branch ref.

**Test Changes:**
Add base-ref immutability coverage to `tests/workers/worktree.test.ts`; add a Task 10/orchestrator assertion that worker state persists `base_sha` and approval display includes it.

**Affected Tasks or Sections:**
WorkerTask schema; Worktree creation/output capture; Task 6; Task 10 state persistence/events; Task 11 `--base`; Task 14 clean-patch smoke.

---

#### MD-014: Optional worker branch mode has no git-ref lifecycle or cleanup contract

**Evidence:**
- The config includes `branch_prefix: "aisup/worker-"` (plan line 220).
- `WorkerState` includes `worktree_branch: string | null` (plan line 98).
- Worktree creation says "Optionally a throwaway branch `<branch_prefix><task-id>` if a ref name is required by the adapter; default detached" (plan line 160).
- Cleanup only says `git -C <workspace_root> worktree remove --force <path>` and validates the path under `worktree_dir` (plan lines 171, 438); it does not delete a created branch ref.
- The allowed automatic git verbs table lists `worktree add/remove`, `diff`, `status`, and `apply[ --check]`, but not branch create/delete (plan line 678).

**Issue:**
The plan introduces branch-mode config/state and an optional branch creation path, but never defines when it is enabled, how the branch name is validated, whether branch creation is allowed under the no-user-git-state policy, or how the throwaway branch is removed. `git worktree remove` removes the worktree; it does not by itself define the lifecycle of a separately-created local branch.

**Impact:**
A literal implementation can leave `aisup/worker-*` refs behind after cleanup, or invent a branch-deletion behavior late in the implementation. Either result conflicts with the plan's promise that workers do not leave uncontrolled git state in the user's repository.

**Optimal Fix:**
Preferred Phase 3 fix: remove branch mode from the plan and config for now. Keep workers detached-only, drop `branch_prefix`, and keep `worktree_branch` always `null` or remove it from the schema. If branch mode is truly required, add an explicit lifecycle: validate `branch_prefix`, create only namespaced `aisup/worker-<uuid>` refs, delete that exact branch after `worktree remove` according to retention, add branch verbs to the allowed-git list, and test that no branch remains after cleanup.

**Why This Fix:**
Detached worktrees are sufficient for the stated diff-only output path, so removing branch mode is the smallest correction. If future adapters really require a named branch, that should be a deliberate lifecycle feature with its own cleanup tests, not an optional sentence in Task 6.

**Fix Validated:**
YES — the current plan contains branch config/state and optional creation prose but no cleanup or allowed-verb contract for branch refs.

**Validation Command or Check:**
`grep -n "branch_prefix\|worktree_branch\|git branch\|worktree add" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`; after the fix, either no branch mode remains or every branch create/delete path is explicitly owned and tested.

**Test Changes:**
If detached-only: Task 2/Task 6 tests assert no branch config is accepted/used. If branch mode remains: Task 6 cleanup test asserts the namespaced worker branch is deleted and unrelated branches are never touched.

**Affected Tasks or Sections:**
Config Contract; WorkerState schema; Task 2 loader validation; Task 6 create/remove; Security & Isolation allowed git verbs; Task 14 no-orphan-worktree/state proof.

---

### LOW

#### LO-001: Default `forbidden_path_globs` omits the transcripts and tmux-capture paths the Security table promises

**Evidence:** Security & Isolation table (line 676) guarantees "Secrets / tokens / account paths / **transcripts** / **tmux captures** / `.claude/settings.local.json` never in artifacts," and Task 6 prose (line 170) lists "transcript `*.jsonl` under a config dir, tmux capture paths" as forbidden. But the default `security.forbidden_path_globs` (Config Contract, lines 229-232) is only `**/.claude/settings.local.json`, `**/*.pem`, `**/.env`.

**Issue:** The enforced default set doesn't cover transcripts (`*.jsonl`) or tmux captures, so the stated guarantee isn't backed by config.

**Impact:** A worker patch that adds a transcript `.jsonl` or tmux capture would pass the path sanitizer with defaults, contradicting the security table.

**Optimal Fix:** Add transcript/tmux glob patterns to the default `forbidden_path_globs` (e.g. `**/.claude/transcripts/**`, `**/*.jsonl` scoped to config/transcript dirs, the tmux capture path pattern), or narrow the Security table to exactly what the defaults enforce.

**Why This Fix:** Aligns the promised guarantee with the shipped default; either tighten the config or the claim.

**Fix Validated:** YES — `.gitignore:15` confirms `.claude/transcripts/` is a real sensitive dir; mismatch is between plan prose and plan config defaults.

**Validation Command or Check:** Task 6 sanitize test adds a transcript-path case.

**Test Changes:** One added sanitize case.

**Affected Tasks or Sections:** Config Contract (lines 226-232); Task 6; Security table (line 676).

---

#### LO-002: `security.env_allowlist` has no defined consumer

**Evidence:** Config Contract (line 227): `security.env_allowlist: ["PATH","HOME","LANG"]` with comment "global default; adapters may narrow/extend." Task 4 (line 396) builds the subprocess env solely from `adapter.env_allowlist`; no task composes the global `security.env_allowlist` into the effective allowlist. Each adapter ships its own `env_allowlist: ["PATH","HOME"]`.

**Issue:** The global field is dead config (never read) or has unspecified compose-with-adapter semantics — "narrow/extend" is asserted but not defined anywhere.

**Impact:** Confusing config surface; an operator setting `security.env_allowlist` expects effect and gets none.

**Optimal Fix:** Either drop `security.env_allowlist` (adapters carry their own), or specify in Task 4 that the effective allowlist = compose(`security.env_allowlist`, `adapter.env_allowlist`) with a stated precedence (e.g. union, then adapter overrides).

**Why This Fix:** Removes ambiguity; both options are one-line decisions.

**Fix Validated:** YES — Task 4 env construction (line 396) reads only `adapter.env_allowlist`.

**Validation Command or Check:** Re-read Task 4 after edit.

**Test Changes:** If composed, Task 4 env test asserts the merge; if dropped, remove the field from defaults/schema.

**Affected Tasks or Sections:** Config Contract (line 227); Task 4 (line 396).

---

#### LO-003: The mirrored CLI `daemonRequest` helper sends no request body, but `worker dispatch` needs one

**Evidence:** `src/cli/commands/gate.ts:22-32` — `daemonRequest(path, method)` issues `fetch(url, { method, headers: { authorization } })` with **no body and no content-type**. Task 11 (line 552) `dispatch` carries `--task-type`/`--prompt`/`--implementer`/`--reviewer`/`--base`/`--workspace` and posts to `POST /api/workers`, which parses `req.body`.

**Issue:** "Mirror `gate.ts` `daemonRequest`" is under-specified — the existing helper can't send the dispatch payload.

**Impact:** Minor; the implementer must extend the helper (add a JSON body + `content-type: application/json`) or write a small variant.

**Optimal Fix:** Note in Task 11 that the worker `daemonRequest` variant accepts an optional JSON body for POSTs (`POST /api/workers` and, if any carry fields, approve/deny/cancel).

**Why This Fix:** Pre-empts a trivial but easy-to-miss gap.

**Fix Validated:** YES — `daemonRequest` signature verified at `gate.ts:22`; `POST /api/failover` reads `req.body` (`server.ts:264`) so fastify body parsing is available.

**Validation Command or Check:** Task 11 CLI test exercises `dispatch --prompt @file` end-to-end against a stub.

**Test Changes:** None beyond Task 11's planned tests.

**Affected Tasks or Sections:** Task 11 (line 552).

---

#### LO-004: `WorkerTask.input_artifact_path` and `title` have no defined source or delivery mechanism

**Evidence:**
- `WorkerTask` (plan lines 83, 85): `title: string` (required) and `input_artifact_path: string | null` ("optional spec/plan file path passed to the worker").
- `grep -nE "input_artifact|title"` over the plan returns **only** the two type-definition lines — neither field is consumed anywhere in Tasks 4–10.
- `buildWorkerCommand` (Task 4, line 395) builds the prompt from `task.prompt` only; it never reads `input_artifact_path`.
- CLI `dispatch` flags (Task 11, line 552): `--task-type`, `--prompt`, `--implementer`, `--reviewer`, `--base`, `--workspace` — **no** `--title` and **no** `--input-artifact`. The API body shape (Task 12) is also unspecified.

**Issue:** Two required/optional `WorkerTask` fields are write-only schema with no producer and no consumer. (1) `title` is non-nullable but nothing populates it at dispatch (no flag, no documented default). (2) `input_artifact_path` is described as "passed to the worker," but no task says *how* — read-and-prepend to the prompt, pass its path as an arg, or copy it into the worktree are all materially different and the worker CLI sees nothing unless one is chosen.

**Impact:** An implementer must invent the `title` source (risking an empty-string violation of the non-null type) and either silently drop `input_artifact_path` (dead field, like LO-002) or guess a delivery mechanism. AC-relevant: a "bounded coding task" with a spec/plan attachment (the stated use case) won't actually receive the attachment.

**Optimal Fix:** In Task 11/Task 12, define `title`'s source (e.g. `--title`, defaulting to a truncated `--prompt`) and enumerate the dispatch request-body fields. In Task 4 or 5, define `input_artifact_path` delivery — simplest: read the file and append its content to the prompt under a labeled section (and sanitize it the same way the patch is), or drop the field if attachments are out of Phase 3 scope (YAGNI).

**Why This Fix:** Removes write-only schema; ties every `WorkerTask` field to a producer and a consumer, or deletes it.

**Fix Validated:** YES — grep confirms no consumer; CLI flag list confirms no producer.

**Validation Command or Check:** `grep -nE "input_artifact|\\btitle\\b" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md` (only type defs); re-read Task 4/11/12 after edit.

**Test Changes:** If `input_artifact_path` is kept, Task 4/5 test asserts the artifact reaches the prompt; if dropped, remove the field from `types.ts`.

**Affected Tasks or Sections:** `WorkerTask` schema (lines 83, 85); Task 4 (line 395); Task 11 (line 552); Task 12.

---

#### LO-005: The orchestrator dependency list omits the session-cwd resolver its own `workspace_root` tier-3 fallback requires

**Evidence:**
- Orchestrator deps (plan line 525): `{ store, config: WorkersConfig, journal, runnerFactory, worktreeOps, validateOutput, reviewOutput, mergeOutput, resolveRunnableAdapter }`. No `sessionManager` and no cwd-resolver callback.
- `workspace_root` resolution (lines 281, 526): tier 3 is "the active lead session's `cwd` (`sessionManager.getActiveSession()?.cwd`)".
- `SessionManager.getActiveSession(): SessionState | null` exists (`src/session/manager.ts:279`) and `SessionState.cwd` is present (`src/session/types.ts:48`) — the data is available, but only via a dependency the orchestrator isn't given.

**Issue:** The deps list is presented as the complete injectable surface ("inject the Task 4–9 functions so the orchestrator is unit-testable"), yet tier-3 of the documented `workspace_root` resolution cannot be implemented from it — there is no handle to the session manager or its `cwd`. A literal implementation either silently drops tier 3 (so dispatch with no `--workspace` and no `config.workers.workspace_root` always errors even when a lead session is active) or reaches into a global, defeating the unit-testability goal.

**Impact:** The most ergonomic dispatch path (no flags, inherit the lead session's cwd) is unimplementable as written, or the orchestrator becomes untestable. Caught immediately at wiring time, but it is a real inconsistency in the task's own contract.

**Optimal Fix:** Add a `resolveActiveSessionCwd: () => string | null` (or `sessionManager`) entry to the Task 10 deps list, wired in `src/daemon/index.ts` from `sessionManager.getActiveSession()?.cwd ?? null` (the same handle the daemon already uses at `index.ts:441` and for `runConfiguredGates` at `index.ts:82`). The orchestrator test injects a stub returning a temp dir.

**Why This Fix:** Keeps the orchestrator fully injectable (no global), and makes the documented tier-3 resolution actually reachable.

**Fix Validated:** YES — verified `getActiveSession()` + `SessionState.cwd` exist and are already consumed in `src/daemon/index.ts` for the gate-cwd default.

**Validation Command or Check:** Re-read Task 10 deps after edit; confirm tier-3 resolution has a corresponding injected dependency.

**Test Changes:** Orchestrator test (Task 10) injects the cwd-resolver stub and asserts tier-3 fallback resolves; existing "no resolvable workspace_root → rejected" DoD line (534/536) stays valid with the stub returning null.

**Affected Tasks or Sections:** Task 10 (lines 525, 526); `workspace_root` resolution rule (line 281).

---

#### LO-006: `base_ref` (and other task-derived git ref arguments) are not validated and no end-of-options (`--`) guard is specified

**Evidence:**
- `base_ref` is task-controlled (`WorkerTask.base_ref`, line 86; default `HEAD`) and operator-settable via `aisup worker dispatch --base` (line 552).
- It is passed positionally to `git -C <workspace_root> worktree add --detach <worktree_dir>/<task-id> <base_ref>` (line 160) and used in `git -C <worktree> diff <base_ref>` (line 163).
- The plan validates `worktree_dir` (relative, no `..`, no leading `/` — line 282), task ids (UUID regex — line 376), env var names, and adapter `command` (shell-free), but specifies **no** validation for `base_ref` and **no** `--` end-of-options separator on the git invocations.

**Issue:** Execution is shell-free (good — no shell injection), but `execFile('git', […])` is still subject to *argument* injection: a `base_ref` beginning with `-` (e.g. `--no-checkout`, `-f`, or an arbitrary git option) can be parsed by git as an option rather than a commit-ish, changing the command's behavior. The plan's otherwise-thorough input-validation posture conspicuously omits this one task-derived value.

**Impact:** Low under the stated threat model (trusted operator, accidental escape — line 49), but it is a real hardening gap in a security-sensitive path that the plan elsewhere holds to a high bar. An operator-typo or a programmatic dispatch could produce a confusing failure or an unintended git operation.

**Optimal Fix:** In Task 6 (and the loader/CLI where `--base` is accepted), validate `base_ref` against a conservative git-ref pattern (or at minimum reject a leading `-`), and/or insert `--` before positional ref/path arguments in the `git worktree add` invocation (`git worktree add --detach -- <path> <base_ref>` is not valid placement for the commit-ish; instead validate the ref). Prefer explicit validation: reject `base_ref` that fails `git check-ref-format` semantics or starts with `-`.

**Why This Fix:** Closes argument-injection on the one unvalidated task-derived git argument, matching the plan's existing validation discipline; cheap and local.

**Fix Validated:** YES (gap) — verified no `base_ref` validation or `--` guard in the plan; git option-parsing behavior for leading-`-` arguments is standard. `[FIX UNVALIDATED]` for the exact regex (no code yet).

**Validation Command or Check:** Task 6 test: a `base_ref` of `--help`/`-x` is rejected before any `git` call.

**Test Changes:** One added rejection case in `tests/workers/worktree.test.ts` (Task 6) or the loader test if validated at config/CLI layer.

**Affected Tasks or Sections:** Task 6 (lines 160, 163); Task 11 (`--base`, line 552); Config/loader validation (Task 2).

---

#### LO-007: `worker review <id>` and `worker logs <id>` are listed, but no behavior or API route supports them

**Evidence:**
- CLI surface lists `dispatch`, `list`, `status <id>`, `review <id>`, `approve <id>`, `deny <id>`, `cancel <id>`, and `logs <id>` (plan line 192).
- Task 11 repeats the worker CLI objective with `review` and `logs` (line 543), but its details define only dispatch flags, list/status read behavior, and pure status/list formatters (lines 551-555).
- Task 12 API routes include dispatch/list/status/approve/deny/cancel only (line 569), with no `/review` or `/logs` endpoint.

**Issue:**
Two advertised CLI subcommands have no defined semantics. `review <id>` might display the stored `ReviewVerdict`, rerun review, or show raw reviewer output; `logs <id>` might print `stdout_tail`/`stderr_tail`, read artifact files, or stream journal events. The API surface does not name either operation.

**Impact:**
Minor implementation ambiguity and potential user-facing command drift: a future implementer may invent behavior or omit the commands while the summary still promises them.

**Optimal Fix:**
Define both commands in Task 11 as read-only views backed by `GET /api/workers/:id` (e.g. `review` formats `state.review`, `logs` formats sanitized stdout/stderr tails and artifact paths), or remove them from the CLI surface until a later phase. If they need distinct data, add exact API routes and tests in Task 12.

**Why This Fix:**
It keeps the CLI list aligned with the API and avoids hidden rerun semantics for review. Read-only formatting is the smallest path if the commands are kept.

**Fix Validated:**
YES — plan grep shows the commands only in the surface list/objective and no API route for either.

**Validation Command or Check:**
`grep -n "review <id>\\|logs <id>\\|/api/workers" docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`; Task 11 CLI tests cover both kept commands or the command list no longer includes them.

**Test Changes:**
Add `tests/cli/worker.test.ts` formatter/command tests for `review` and `logs`, or remove them from help assertions.

**Affected Tasks or Sections:**
CLI/API/Slack Surfaces; Task 11; Task 12.

---

### INFO

#### IN-001: A `lint` npm script exists (eslint) though eslint isn't installed — the plan's "lint not configured" is slightly imprecise

**Evidence:** `package.json` `scripts.lint = "eslint src tests"`, but eslint is absent from `dependencies`/`devDependencies`. Plan Validation Strategy (line 663): "Lint is **not configured** in this repo (no eslint config/dep)."

**Issue:** A `lint` script is present; running `npm run lint` would error (eslint not installed). The substantive claim — typecheck + vitest are the gates — is correct.

**Optimal Fix:** Optional: reword to "an `npm run lint` script exists but eslint is not installed, so lint is not a working gate; typecheck + vitest are the gates."

**Fix Validated:** YES — verified in `package.json`.

**Affected Tasks or Sections:** Validation Strategy (line 663).

---

#### IN-002: Default presets deliver the prompt as a positional `arg`; embedding a full patch in the reviewer prompt as an argv element risks `E2BIG` for large diffs

**Evidence:** `codex`/`gemini` presets default `prompt_via: "arg"`, `prompt_arg_flag: null` (Config Contract, lines 237-239, 247-249). Task 8 (line 483) embeds the **patch** in the reviewer prompt, delivered via the reviewer adapter's `prompt_via`.

**Issue:** A large patch passed as a single CLI argument can exceed `ARG_MAX`. Operator-tunable (presets are placeholders), but the default `arg` mode is the riskiest for the review path specifically.

**Optimal Fix:** Optional: note in Task 8 / the runbook that reviewer adapters should prefer `prompt_via: stdin` or `file` for large patches, and consider defaulting the *review* path to stdin/file.

**Fix Validated:** YES — preset values verified in the Config Contract.

**Affected Tasks or Sections:** Task 8; Config Contract adapters; Task 15 runbook.

---

#### IN-003: Workers branch from the committed `base_ref`, not the working tree — uncommitted main-tree edits are invisible to the worker

**Evidence:** `createWorktree` uses `git worktree add --detach … <base_ref>` with `base_ref` default `HEAD` (lines 160, 218). A worktree from a commit does not include the main tree's uncommitted changes.

**Issue:** This is almost certainly intended (workers start from a clean ref), but it can surprise an operator who expects the worker to act on their current uncommitted edits.

**Optimal Fix:** Optional: one runbook line (Task 15) stating workers branch from the committed `base_ref` (default `HEAD`); uncommitted working-tree changes are not seen by the worker.

**Fix Validated:** YES — git worktree semantics.

**Affected Tasks or Sections:** Task 15 runbook; Worktree section.

---

#### IN-004: The orchestrator pipeline (Task 10) does not enumerate the boundary-audit and patch-sanitize checkpoints or their order

**Evidence:** Task 10's pipeline narration (line 527) lists `RUNNING → IMPLEMENTED → worker.completed → VALIDATING → REVIEWING → AWAITING_APPROVAL`, but never names *where* `auditBoundary` (Task 6) and `sanitizePatch` (Task 6) run within it. Their behavior is defined in the architecture/failure-mode sections (boundary violation → `FAILED`, line 168; sanitize hit → `REJECTED`, line 170) and the sanitize-before-review placement is fixed by Task 8 (line 483), but the orchestrator's own step list omits both.

**Issue:** An implementer must infer the security-checkpoint sequence from three other sections. The one genuinely load-bearing ordering — sanitize must precede sending the patch to the external reviewer CLI — is already pinned by Task 8, so the residual ambiguity (boundary-audit before vs. after validation) is low-impact (both block merge regardless), but pinning the sequence in one place removes guesswork.

**Optimal Fix:** Add one ordered line to Task 10: `IMPLEMENTED` capture → `auditBoundary` (fail → `FAILED`) → `VALIDATING` → `sanitizePatch` (fail → `REJECTED`) → `REVIEWING` → `AWAITING_APPROVAL`, with sanitize re-checked at merge per line 170.

**Fix Validated:** YES — checkpoints are defined elsewhere in the plan; only their placement in the orchestrator step list is missing.

**Affected Tasks or Sections:** Task 10 (line 527); Task 6 (lines 168, 170); Task 8 (line 483).

---

## Resolved or Superseded Findings (Prior Review History)

The prior review consolidated two agent rounds. Re-checked against the current plan + codebase; all remain genuinely resolved as originally scoped — **not re-opened**. Iteration 5 adds a separate boundary-content-change gap (HI-004) that was not covered by the original C1 fix.

| Prior ID | Finding | Verified resolved (evidence) |
|---|---|---|
| C1 (Codex, critical) | Boundary audit over-claimed AC4 | Reframed to structural diff-scoping + isolated temp HOME + ignored-aware `git status --porcelain --ignored` + symlink rejection; residual recorded (plan lines 49, 158-169, 437). `--ignored` necessity confirmed: `.claude/settings.local.json` gitignored at `.gitignore:14`. HI-004 is a new, narrower finding about modifications to already-existing ignored files/directories. |
| C2 (Codex, high) | Empty worker gates fail open | `validation.allow_no_validation` default false; loader + Task 7 fail closed (lines 280, 462). Confirmed `runGates` returns `passed:true` for `[]` at `src/gates/engine.ts:53-57`. |
| C3 (Codex, medium) | Gate events not attributable | Wrapping `JournalWriter` injects `worker_task_id` (Task 7, line 461). Confirmed engine has no injection hook (`src/gates/engine.ts:59-103`) and `JournalWriter` is `{ append(event) }` (`src/journal/types.ts:108-110`) — wrapper is trivial. |
| L1-L7 (Claude spec-review) | Task 1 verify-first; status-collision; `worker.running` dropped; MERGE_FAILED non-status; Slack approval doc; picomatch; host-agnostic tests | All present in plan. Spot-verified: `WorkerStatus`∩`SessionStatus`=∅ (`src/session/types.ts:1-8`); picomatch is a direct dep + `@types/picomatch` (`package.json`); `daemon.port` default `7394` (`src/config/defaults.ts:70`); Task 1 stale rows real at PRD 124/273/275/277/281. |

## Iteration 8 Methodology Addendum

**Files read or re-read:** current implementation plan (full); current review artifact (full); `src/gates/engine.ts`; `src/gates/types.ts`; `src/journal/writer.ts`; `src/journal/types.ts`; `src/config/schema.ts`; `src/config/defaults.ts`; `src/config/loader.ts`; `src/daemon/server.ts`; `src/daemon/index.ts`; `src/session/types.ts`; `src/session/manager.ts`; `src/failover/migrator.ts`; `src/slack/commands.ts`; `src/slack/service.ts`; `src/cli/commands/gate.ts`; `src/cli/index.ts`; `package.json`; `.gitignore`; `docs/prd/2026-04-29-ai-supervisor.md`; `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`; `docs/reviews/2026-06-02-phase2-spec-verify-findings.md`.

**Review actions:** Re-checked all 33 prior active finding IDs against the current plan text; confirmed 32 are now represented in the plan and MD-001 is still only partially applied. Re-ran source checks for gate `cwd` precedence and env behavior, journal secret scanning, Slack command collision, daemon API body parsing, CLI daemon-request precedent, session-cwd fallback, worktree symlink-check precedent, PRD stale-status rows, host-gated marker conventions, and package/dependency assumptions. Ran a temp-git probe showing `git worktree add --detach .aisup-workers/<id> HEAD` works inside the repo root pattern the plan specifies. Completed a final contradiction sweep for `!approve`/`!deny`, `base_sha`/moving refs, branch mode, arbitrary absolute-path residuals, `input_artifact_path`, removed review knobs, patch hashing, validation-gate env/cwd, and worker review/logs command semantics.

**Commands run in this pass:** `rtk git status --short --branch`; targeted `rg`/`grep`/`nl` reads; `npm run typecheck` (pass); `npx vitest run tests/gates/engine.test.ts tests/journal/writer.test.ts tests/config/loader.test.ts tests/daemon/server.test.ts tests/cli/gate.test.ts tests/slack/service.test.ts` (`PASS (84) FAIL (0)`); temp-git worktree probe (pass); `command -v codex` (present) and `command -v gemini` / `command -v ollama` (absent); package manager detection (`package-lock.json` -> npm).

**Skipped checks / residual risk:** No `src/workers/` implementation exists yet, so worker runtime behavior and the proposed new tests cannot be executed. Real Codex/Gemini/local worker runs remain host-gated implementation-time verification. The review artifact itself is untracked in the worktree, so this update treats it as the user-supplied output artifact and does not infer git history for it.

## Historical Review Methodology (Iterations 1-7)

**Files read (full or targeted):** plan (804 lines, full); prior review file; `src/gates/engine.ts` (full); `src/gates/types.ts` (full); `src/failover/migrator.ts` (130-189); `src/journal/writer.ts` (full); `src/journal/types.ts` (full); `src/session/types.ts` (full); `src/session/manager.ts` (40-130 + getActiveSession refs); `src/config/loader.ts` (full); `src/config/schema.ts` (full); `src/config/defaults.ts` (full); `src/daemon/server.ts` (full); `src/daemon/index.ts` (full — wiring, late-bound refs, gate-cwd, rehydration); `src/slack/commands.ts` (full); `src/slack/service.ts` (1-95, 300-429); `src/cli/commands/gate.ts` (full); `src/cli/index.ts` (gate group); `package.json`; `.gitignore`; `tests/integration/smoke.test.ts`; `tests/session/manager.test.ts`; `tests/gates/engine.test.ts`; `docs/prd/2026-04-29-ai-supervisor.md` (status rows + Phase 3 ACs); `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` header/status; `docs/reviews/2026-06-02-phase2-spec-verify-findings.md` Round 3 status.

**Searches/commands run (iteration 3/4/5/6/7 additions in bold):** git status/branch; src tree listing; `KNOWN_COMMANDS`/`ConfirmationStore`/`onPermission*` greps; engine test precedent grep; `package.json` deps + `.gitignore` dump; PRD stale-status grep; PRD AC block read; Phase 2 plan/review status checks; git history for Phase 2 remediation docs; **existence check of every test file the plan modifies (`tests/config/loader.test.ts`, `tests/journal/writer.test.ts`, `tests/daemon/rehydration.test.ts`, `tests/daemon/server.test.ts`, `tests/slack/service.test.ts`, `tests/gates/engine.test.ts` — all present; `tests/cli/` has a `gate.test.ts` precedent)**; **`gate` command-group precedent in `src/cli/index.ts:80-87`**; **exhaustive-`EventType`-switch / `: never` grep (none — adding `worker.*` is additive and safe)**; **`grep -rnE "AbortSignal|abort|\.kill\(|AbortController" src/gates/engine.ts src/runner/builder.ts` (empty — no abort precedent, basis for MD-006)**; **host-gated marker convention grep (`@requires_*` + `it.skip` pattern in `tests/integration/smoke.test.ts:58`, `tests/session/*`)**; **plan greps for `input_artifact`/`title`/`base_ref`/`cancel`/orchestrator-deps**; **worker validation `cwd` search against `src/gates/engine.ts:65-67` and Task 7**; **artifact persistence/sanitizer ordering grep for `patch_path`, `output.json`, `sanitizePatch`, `security_denied`**; **merge/rehydration grep for `MERGING`, `git apply`, and `worker.rehydrated_failed`**; **review config grep for `require_cross_model`/`parse_failure_verdict`**; **prompt-file and CLI review/logs command greps**; **temp git repo probe proving `git status --porcelain --ignored` output is unchanged after modifying pre-existing ignored files/directories**; **`command -v codex` / `gemini` / `ollama` host-adapter check (`codex` present, `gemini`/`ollama` absent on this host)**; **approval-state grep for `approval.granted` + `merge_failed`; routing grep for disabled `default_reviewer`; patch-integrity grep for `patch_path`/`patch.diff`; worktree-dir validation grep for `worktree_dir` rules**; **Iteration 6 residual-security grep for `arbitrary absolute`/`cannot observe`/`sandbox-exec`, reviewer-side-effect grep for reviewer runner/cwd/boundary wording, and automatic-git-policy grep for `git add -A -N` versus `No git add` claims**; **Iteration 7 git-ref lifecycle grep for `base_ref`/`baseRef`/`base_sha`/`rev-parse`/`branch_prefix`/`worktree_branch`/`git branch` plus `git rev-parse --verify HEAD^{commit}` to confirm immutable commit capture is locally available**; **finding-heading count/duplicate-ID awk checks (8/14/7/4, total 33, no duplicates)**; **fresh `npm run typecheck` (passed)**; **final no-new-findings pass after HI-007/HI-008/MD-012/MD-013/MD-014 found no additional supported blocker pattern**.

**Code claims verified accurate:** `GATE_OUTPUT_TAIL_LIMIT=2000` / `MAX_BUFFER` / `defaultGateRunner` shell-free / empty-list `passed:true` / fixed `gate.*` details (engine.ts:7,10,13-29,53-57,58-104); `defaultGateRunner` does **not** pass an `env` option, and `GateRunner` has no env parameter (engine.ts:13-29; gates/types.ts:27-32); `runGates(gates,{journal,defaultCwd})` signature and `gate.cwd ?? defaultCwd` precedence (engine.ts:65-67); migrator symlink/parent checks (149-166 + `validateTargetParentComponents`); `JournalWriter` shape `{append}` + secret-key scanner is **key-name** oriented and `SECRET_KEY_PATTERN` is **module-private** (writer.ts:5-25); `SessionStatus`/`WorkerStatus` disjoint (session/types.ts:1-8); `SessionState.cwd` + `getActiveSession()` (manager.ts:279) — **and confirmed already consumed in daemon/index.ts:82,441**; loader `mergeDeep` + `validateGates` + explicit return (86-107, 132-222); `daemon.port` 7394 (defaults.ts:70); server bearer-auth global `preHandler` (92), 503 pattern (236), `DaemonServerOptions` injection (21-46), `POST /api/failover` reads `req.body` (264 — fastify body parsing available for LO-003); `daemonRequest(path,method)` sends no body (gate.ts:22-32); `randomUUID` (server.ts:161); picomatch + `@types/picomatch` direct deps; `.gitignore:5-6` `.env`, `:14` settings.local.json, `:15` transcripts; `.aisup-workers/` not yet ignored (Task 6 adds it — correct); `lint` script present but eslint absent (IN-001); Phase 2 prerequisite artifacts match the plan (`Status: VERIFIED`, `Iterations: 5`, Round 3 CLEAN, 457 passed / 0 failed / 2 skipped recorded); AGENTS rules 7/8/9/10 (markers, shell-free, no-secrets, no-commit) consistent with the plan; all 7 PRD ACs (467-473) map to the Traceability Matrix.

**Skipped checks / residual risk:** (1) No `src/workers/` code exists yet (new subsystem) — MD-003's git-exclusion invocation, MD-006's chosen abort/cooperative-cancel mechanism, HI-002's exact redaction implementation, HI-003's exact rehydration reconciliation, HI-005's custom validation runner, HI-008's reviewer containment implementation, MD-009's hash implementation, MD-013's base-SHA field placement, MD-014's branch cleanup implementation, and LO-006's exact ref regex can't be executed against real code now (`[FIX UNVALIDATED]` where noted). (2) Real-CLI behavior of codex/gemini/local is host-gated and out of scope (plan's design — no invented signatures); only current PATH presence was checked. (3) The `git diff <base_ref>` → `git apply` round-trip for intent-to-add new files is exercised by Task 9/14 tests at implementation time, not statically here; this review did not run git apply/write commands against the aisup repo. (4) MD-005's non-npm ecosystem behavior (pnpm/Yarn-PnP/Python/Go) is described from general tooling knowledge, not run on this host. (5) The boundary audit's `git status --porcelain --ignored` cost/quiescence on a repo with large ignored trees (node_modules) is acknowledged by the plan's "quiescent main tree" caveat (line 169) and not re-litigated here; HI-004 is specifically about correctness for pre-existing ignored-file content changes. (6) HI-007 intentionally does not propose adding OS sandboxing in Phase 3; it corrects the plan's residual-security claim to match the accepted threat model.
