# Implementation Plan Review: Phase 3 — Multi-LLM Worker Orchestration (Final Pre-Implementation Pass)

**Plan:** `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`
**Reviewed:** 2026-06-16
**Review Iterations:** 1 independent verification pass (this doc), layered on the prior 8-iteration review (`docs/reviews/2026-06-02-plan-review-phase3-multi-llm-worker-orchestration.md`)
**Status:** CLEAN — LO-101 + IN-101 merged into the plan 2026-06-16 (plan Task 8/9/10/14 + failure-modes & security tables)

> **Purpose of this pass.** The user requested a final, thorough pre-implementation review.
> The prior review (8 iterations, 33 findings) ended at 1 open MEDIUM (MD-001). Since that
> review, commit `3d77246` ("resolve Phase 2 spec-verify findings F1–F4") became HEAD, which
> could have shifted the many `file:line` anchors the plan cites. This pass (a) re-confirms
> MD-001 is now resolved in the plan, (b) **independently re-verifies every load-bearing
> codebase anchor against the current HEAD**, and (c) sweeps for new gaps. Result: the plan is
> implementation-ready. Two optional polish notes (1 LOW, 1 INFO) are recorded below; neither
> blocks implementation or requires a re-review.

## Summary

| Severity | Current Findings | Description |
|---|---:|---|
| CRITICAL | 0 | Blocks implementation or causes incorrect behavior |
| HIGH | 0 | Significant gap likely to cause rework, failed validation, or integration confusion |
| MEDIUM | 0 | Quality issue that materially reduces clarity, coverage, or maintainability |
| LOW | 1 | Minor improvement |
| INFO | 1 | Observation or optional alternative |

**Total current findings:** 2 (1 LOW, 1 INFO) — both optional, neither blocking.
**Recommendation:** APPROVE

The plan's architecture is sound, every prior HIGH/MEDIUM finding is represented in the plan,
MD-001 is fully resolved, and all integration anchors are verified accurate against the
current codebase. The two notes below can be folded into Task 8/Task 9 implementation inline.

## Verification Performed This Pass

### MD-001 (sole previously-open finding) — RESOLVED

The 2026-06-04 review left MD-001 PARTIAL: plan lines 323 and 619 still named top-level
`!approve`/`!deny`. The **current** plan no longer does:
- `:200`, `:323`, `:619`, `:627-633` all use `!worker status` / `!worker approve <id>` / `!worker deny <id>` subcommands.
- `grep -nE '!approve|!deny|!worker' docs/plans/2026-06-02-…md` returns **zero** top-level worker `!approve`/`!deny`; the only bare `!deny` references are the explicit instruction to preserve the existing permission command.
- Verified collision basis still real: `src/slack/commands.ts:1` → `KNOWN_COMMANDS = new Set([…'permit','deny','gate'])` (no `worker`/`approve`); `src/slack/service.ts:380` `case 'deny'` → `onPermissionDeny`; `:390` `case 'gate'` subcommand dispatch is the precedent the plan mirrors. The plan's cited lines (370/380/390) are exact — no drift.

### Codebase anchors re-verified against current HEAD (`3d77246`)

| Plan claim | Evidence (current code) | Status |
|---|---|---|
| `runGates` accepts a custom shell-free runner (HI-005) | `GateEngineDeps.runner?: GateRunner` (`engine.ts:43`); `const runner = deps.runner ?? defaultGateRunner` (`:54`) | ✅ implementable with no engine change |
| `gate.cwd` overrides `defaultCwd` → must normalize to null (HI-001) | `runner(gate.command, gate.args, { cwd: gate.cwd ?? deps.defaultCwd, … })` (`engine.ts:65-66`) | ✅ exact |
| Default runner inherits daemon env (no `env` passed) → custom env via closure (HI-005) | `defaultGateRunner` passes `{ cwd, timeout, maxBuffer }` only (`engine.ts:18`); `GateRunner` opts = `{ cwd?, timeoutMs }`, no env (`types.ts:28-32`) | ✅ closure approach correct |
| Empty gate list → `passed:true` (fail-closed guard needed) | `runGates` inits `passed=true`, loop skips on `[]` (`engine.ts:56`) | ✅ |
| Engine has no per-event detail-injection hook → wrapping `JournalWriter` (Task 7) | Fixed `gate.*` details (`engine.ts:59-104`); `JournalWriter` = `{ append(event) }` (`journal/types.ts:108-109`) | ✅ wrapper is trivial |
| `GATE_OUTPUT_TAIL_LIMIT=2000`, `MAX_BUFFER=10MB`, `timedOut` semantics reused (Task 5) | `engine.ts:7,10,13-29` | ✅ |
| `SECRET_KEY_PATTERN` is module-private + `^…$` key-anchored (MD-004 — needs a content regex) | `writer.ts:5` (no `export`), tested against object keys at `:16` | ✅ MD-004 fix justified |
| Slack collision + `!gate status` subcommand precedent (MD-001) | `commands.ts:1`; `service.ts:380` (deny), `:390` (gate) | ✅ |
| CLI `daemonRequest` sends no body (LO-003) | `gate.ts:22` `daemonRequest(path, method)`; `:27` `fetch(url, { method, headers:{authorization} })` — no body/content-type | ✅ worker variant must add body |
| Atomic state store mirrors `SessionManager.writeState` (Task 3) | `manager.ts:65-71` — `mkdir 0o700`, `writeFile 0o600` to tmp, `renameSync` | ✅ exact pattern |
| Tier-3 workspace_root = active session cwd (LO-005) | `getActiveSession()` (`manager.ts:279`); `SessionState.cwd` (`session/types.ts:48`); already consumed at `daemon/index.ts:82-83` for gate cwd | ✅ data + handle available |
| Late-bound ref wiring pattern (Task 10) | `loopManagerRef`/`exhaustedRecoveryRef`/`permissionBrokerRef` declared `index.ts:146-148`, assigned `:301` | ✅ |
| `DaemonServerOptions` injection + bearer preHandler + 503 + `req.body` parsing (Task 12) | `server.ts:21` (options), `:43/45` (runGates/getLatestGateRun injected), `:92` (preHandler), `:236` (503), `:131/194/264` (`req.body`), `:161` (`randomUUID`) | ✅ |
| `WorkerStatus` ∩ `SessionStatus` = ∅ (Task 3 DoD) | `SessionStatus` (`session/types.ts:1`): CREATING/ACTIVE/SWITCH_PENDING_AT_IDLE/SWITCHING/STOPPING/STOPPED/EXHAUSTED — disjoint from the worker values | ✅ |
| `picomatch` is a direct dep (Task 6) | `package.json:23` `picomatch ^4.0.4`, `:29` `@types/picomatch ^4.0.3` | ✅ |
| Lint not a working gate (IN-001) | `package.json:15` `lint: eslint …`; eslint absent from deps | ✅ typecheck + vitest are the gates |
| `daemon.port` default 7394 (runbook claim) | `config/defaults.ts:70` | ✅ |
| `validateConfig` explicit-return pattern (Task 2 — typecheck fails if `workers` dropped) | `loader.ts:132` validateConfig, explicit returns `:155,:206` | ✅ |
| symlink/parent-component rejection to mirror (Task 6, MD-011) | `failover/migrator.ts` — `realpathSync` import, `validateTargetParentComponents` (`:65`), `isSymbolicLink()` checks (`:69,:109`) | ✅ mechanism present |
| `.aisup-workers/` not yet gitignored → Task 6 adds it | `.gitignore` has `.env`(5), `.claude/settings.local.json`(14), `.claude/transcripts/`(15), `.aisup/`(10); **no** `.aisup-workers/` | ✅ correct |
| Prereq: Phase 2 verified | `2026-05-11-phase2-…md` `Status: VERIFIED`, `Iterations: 5`, `Approved: Yes` | ✅ |
| Prereq: Phase 2 spec-verify clean | `2026-06-02-phase2-spec-verify-findings.md` Round 3 **CLEAN, zero open**, 457 passed/2 skipped/0 failed | ✅ |
| Task 1 targets: PRD stale rows real | PRD `:124` "Phase 2 scope (in progress)"; `:273/275/277/281` D₂/F/H₁/K "In progress" | ✅ |
| 7 Phase 3 ACs exist for the Traceability Matrix | PRD `:467-473` (Codex/Gemini worktree, seeded-bug review, boundary, failed-gate, approval, clean apply) | ✅ |
| Files to MODIFY all exist; files to CREATE all absent | `src/workers/`, `tests/workers/` absent; `tests/{config/loader,journal/writer,daemon/rehydration,daemon/server,slack/service,gates/engine,cli/gate}.test.ts` present; `docs/runbook.md` present | ✅ |

### Current-state health (fresh run, this pass)

- `npm run typecheck` → clean (tsc --noEmit, exit 0).
- `npx vitest run` → **PASS (457) FAIL (0) skipped (2)** — matches the plan's claimed baseline and the Phase 2 Round-3 count.

### New-gap sweep

Walked the full pipeline (dispatch → RUNNING → IMPLEMENTED → auditBoundary → sanitizePatch → persist → VALIDATING → REVIEWING → AWAITING_APPROVAL → MERGING → MERGED), the config contract, the event family, task ordering/dependencies (Task 1 doc → Task 2 contract baseline → Tasks 3-9 modules → Task 10 orchestrator/wiring → 11/12/13 surfaces → 14 integration → 15 docs; no cycles, contracts precede consumers), and the security/isolation table. No new CRITICAL/HIGH/MEDIUM gaps. Two minor completeness notes follow.

## Findings

### LOW

#### LO-101: Reviewer `reviewDir` location and cleanup owner are unspecified

**Evidence:**
- Task 8 (`:510`) takes `reviewDir` as an injected param and runs the reviewer in "a dedicated throwaway `reviewDir` (NOT the implementation worktree, NOT the main workspace)"; HI-008's read-only audit (`:512`, `:523`) asserts the reviewer wrote nothing outside `reviewDir`.
- Task 10 constructs the orchestrator and drives the pipeline (`:558-566`) but never states **where** `reviewDir` is created or **who removes it**. Cleanup prose (`:564`) covers worktrees per `retention` and GC of stale worktrees — not `reviewDir`.
- Task 14 DoD (`:662`) requires "No orphan worktrees or **state** remain after the suite; the real repo/`~/.aisup` are untouched."

**Issue:**
The reviewer subprocess writes into `reviewDir`, but the plan does not pin its path (e.g. `~/.aisup/workers/<id>/review/`) or assign removal to the orchestrator's terminal-state cleanup. A literal implementer could leave `reviewDir` on disk after terminal states, leaving orphan state that the Task 14 "no orphan state" DoD would then flag.

**Impact:**
Low. The HI-008 audit already forces `reviewDir` outside the worktree (a reviewDir inside the worktree would fail the "implementation worktree unchanged" assertion), so the *location* self-corrects. The unhandled part is *cleanup* — minor orphan-state risk, caught at Task 14 if not addressed.

**Optimal Fix:**
In Task 8/Task 10, state that `reviewDir` lives under the worker state dir (`~/.aisup/workers/<id>/review/`, outside both the worktree and the main workspace) and is removed by the orchestrator's terminal-state cleanup alongside the worktree, governed by `retention`. Add a Task 14 assertion that no `reviewDir` remains after the suite.

**Why This Fix:**
Ties the one remaining reviewer artifact to the same lifecycle owner as the worktree, satisfying the existing "no orphan state" DoD without new machinery.

**Fix Validated:**
NO — `[FIX UNVALIDATED]` — `src/workers/` does not exist yet. The gap is validated by the plan text: `reviewDir` has a consumer (Task 8) and an isolation rule (HI-008) but no location/cleanup contract.

**Validation Command or Check:**
Task 14 integration assertion: after a worker reaches a terminal state, `~/.aisup/workers/<id>/review/` is absent (or retained only per `keep_rejected`).

**Test Changes:**
One added assertion in `tests/integration/workers.smoke.test.ts` (no-orphan-state case) and/or `tests/workers/orchestrator.test.ts` cleanup coverage.

**Affected Tasks or Sections:**
Task 8 (`:510`); Task 10 cleanup (`:564`); Task 14 DoD (`:662`); Security & Isolation reviewer row (`:722`).

---

### INFO

#### IN-101: Merge handles `apply --check` conflict but not a `git apply` runtime error after a passing check

**Evidence:**
- Task 9 (`:535`): "`git apply --check <patchPath>`; on success `git apply <patchPath>` → `MERGED`." The failure path is defined only for `apply --check` failure (`apply_conflict`) (`:535-536`, failure-modes `:216`).
- Rehydration (HI-003, `:565`) handles a daemon crash *during* `MERGING`, but not a non-crash `git apply` error after the check passed in the same process.

**Issue:**
A `git apply` can, in rare cases, fail even after `apply --check` passed (e.g. a sub-second concurrent main-tree edit, or a filesystem error). The plan does not name the resulting transition.

**Impact:**
Negligible under the stated threat model (trusted single operator; `git apply` is atomic, so a failed apply changes nothing). An implementer would naturally `try/catch` the apply. Recorded only for completeness on this final pass.

**Optimal Fix (optional):**
Add one line to Task 9: a `git apply` that throws after a passing `apply --check` is treated like an apply conflict — emit `worker.merge_failed` (reason `apply_conflict` or a new `apply_error`), reset approval, stay `AWAITING_APPROVAL` (reuse the HI-006 reset path).

**Fix Validated:**
YES (gap is in plan text) — the exact reason-string is implementation-time. `git apply` atomicity is standard.

**Validation Command or Check:**
None required; if added, a Task 9 unit test where the injected git op throws on `apply` (not `apply --check`) asserts `worker.merge_failed` + approval reset.

**Affected Tasks or Sections:**
Task 9 (`:535`); Failure modes table (`:216`).

---

## Prior Review Reconciliation

All 33 findings from the 8-iteration prior review (`2026-06-02-plan-review-…md`) were re-checked
against the current plan + current HEAD:

- **HI-001…HI-008, MD-002…MD-014, LO-001…LO-007, IN-001…IN-004 (32 findings):** confirmed
  represented in the current plan, and their codebase bases re-verified against HEAD `3d77246`
  (see the anchor table above). No regressions; none re-opened.
- **MD-001:** previously PARTIAL — now **RESOLVED** in the current plan (verified above). This was
  the prior review's sole blocker for an APPROVE verdict.

No prior finding remains open.

## Review Methodology

**Files read or re-read (full or targeted):** Phase 3 plan (full, 864 lines); prior Phase 3
review (full, 1092 lines); `src/gates/engine.ts` (full); `src/gates/types.ts` (full);
`src/journal/writer.ts`; `src/journal/types.ts`; `src/session/manager.ts`; `src/session/types.ts`;
`src/daemon/server.ts`; `src/daemon/index.ts`; `src/slack/commands.ts`; `src/slack/service.ts`;
`src/cli/commands/gate.ts`; `src/cli/index.ts`; `src/config/defaults.ts`; `src/config/loader.ts`;
`src/failover/migrator.ts`; `package.json`; `.gitignore`; `AGENTS.md`; `docs/prd/2026-04-29-ai-supervisor.md`
(status rows + Phase 3 ACs); `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` (header);
`docs/reviews/2026-06-02-phase2-spec-verify-findings.md` (status).

**Commands run this pass:** `git status`/`git log` (HEAD `3d77246`, plan/review/prompt untracked);
`npm run typecheck` (clean); `npx vitest run` (**457 passed / 0 failed / 2 skipped**); targeted
`grep` for every cited anchor (slack KNOWN_COMMANDS + case dispatch, daemon server options/preHandler/503/req.body,
cli daemonRequest, journal SECRET_KEY_PATTERN, session writeState/getActiveSession/cwd, config
port + validateConfig return, migrator symlink checks, package.json picomatch/scripts, .gitignore,
PRD stale rows + ACs); existence checks for `src/workers`/`tests/workers` (absent), all modified
test files (present), and `docs/runbook.md` (present).

**External contracts checked:** none new — the plan invents no provider CLI signatures (codex/gemini/local
presets ship disabled; real invocation is host-gated). `git worktree add --detach`, `git apply [--check]`,
`git status --porcelain --ignored`, and `git rev-parse --verify <ref>^{commit}` are standard and used
within their documented semantics.

**Skipped checks / residual risk:**
1. `src/workers/` does not exist yet, so the new modules' runtime behavior and the proposed new
   tests cannot be executed now. Findings touching unwritten code (LO-101 fix, IN-101) are marked
   `[FIX UNVALIDATED]` where applicable; they are implementation-time verifications, not blockers.
2. Real Codex/Gemini/local worker runs remain host-gated (by design — no invented signatures).
   Only PATH presence was relevant; the plan's host-gate skip-not-fail policy (Task 14) handles
   absent adapters.
3. The `git diff <base_sha>` → `git apply` round-trip and the boundary/sanitize/merge git writes
   are exercised by Task 6/9/14 tests at implementation time; this review did not run git write
   commands against the aisup repo.
4. A few cited line ranges in `src/failover/migrator.ts` (plan/prior-review cite `:149-166`) may
   point to a slightly different span after Phase 2 edits; the symlink/parent-component **mechanism**
   to mirror is confirmed present in the file, so this is not a finding (the plan also names the
   function and behavior, not just a line range).

## Verdict

**APPROVE.** The plan is complete, internally consistent, and correctly integrated with the current
codebase. Testing and validation are detailed and falsifiable: each of the 7 PRD ACs maps to a
deterministic proof (Task 14 / TS-001…TS-005), every non-trivial module has a unit test with an
exact `npx vitest run` command, host-gated real-CLI tiers are explicit and skip-not-fail, and the
security guarantees are stated as testable mechanisms (structural diff-scoping, isolated temp HOME
with `.home/` patch-exclusion, ignored-aware + content-hash boundary audit, sanitize-before-persist,
`patch_sha256` integrity binding, reviewer read-only containment, forced approval). The two notes
above are optional polish that can be applied inline during Task 8/9 implementation; they do **not**
require a re-review. Implementation may begin at Task 1.
