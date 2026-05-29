# Implementation Plan Review: Phase 2 aisup Supervisor Daemon

**Plan:** `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
**Reviewed:** 2026-05-29
**Review Iterations:** 3 (full read pass, code-evidence pass, second-order/dedup pass)
**Status:** ISSUES_FOUND

## Summary

| Severity | Current Findings | Description |
|---|---:|---|
| CRITICAL | 0 | Blocks implementation or causes incorrect behavior |
| HIGH | 2 | Significant gap likely to cause rework, failed validation, or integration confusion |
| MEDIUM | 5 | Quality issue that materially reduces clarity, coverage, or maintainability |
| LOW | 2 | Minor improvement |
| INFO | 1 | Observation |

**Total current findings:** 10
**Recommendation:** FIX_AND_RE_REVIEW

The Phase 1 Remediation Gate (R1–R13) was verified line-by-line against current source and is **genuinely pending** — the `feat: Phase 1 alignment scan` and `fix: complete all Phase 1 review issues` commits added several event *types* and scaffolding (status filtering, restart window constants, `tmuxSocket` deps, nonterminal soft-target handling) but did **not** implement the behavioral remediation R1–R13 describe. The gate is accurate, not stale. The two HIGH findings from `docs/reviews/2026-05-28-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md` (tmux-socket isolation, deny-keystroke contract) are confirmed **merged** into the current plan and are not re-raised.

The findings below are implementation-readiness gaps where a zero-context implementer could produce code that passes unit tests but does not satisfy the stated acceptance criteria. None invalidates the plan's architecture; all are bounded plan-text corrections.

## Findings

### HIGH

#### HI-001: R1 does not specify the score/state *refresh* mechanism, so selection can stay priority-only while "passing"

**Evidence:**
- `setScore()` (`src/accounts/registry.ts:40`), `scoreAccount()` (`src/accounts/scorer.ts:46`), `selectBestAccount()` (`src/accounts/scorer.ts:92`), and `applyTelemetry()` (`src/accounts/registry.ts:47`) are **all dead code** — no caller in `src/` (`grep -rn "setScore\|scoreAccount\|selectBestAccount\|applyTelemetry" src/` returns only their definitions).
- Registry constructs every account with `score: null` and `state: 'HEALTHY'` (`src/accounts/registry.ts:17-19`); nothing ever refreshes either from telemetry.
- Consequence today: `selectSwitchTarget`'s soft-threshold better-target check `eligible.find(a => typeof a.score === 'number' && a.score > currentScore)` (`src/failover/switcher.ts:70-71`) can **never** match — all candidate `.score` are `null` — so the soft path always reports no_target.
- Start admission (`src/daemon/server.ts:107`) and dry-run (`src/cli/commands/start.ts:69-71`) both sort by `priority` only and never compute a score; dry-run also runs in the CLI process, which has no in-memory `AccountRegistry`.
- R1 requirements (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:78-84`) say "refresh account scores from statusline telemetry and circuit-breaker state … use `selectBestAccount()` or the canonical selector" but name no refresh helper, no refresh call-site/tick, and do not mention refreshing account **state** (DEGRADED/UNAVAILABLE) — even though R1's own "exclude UNAVAILABLE and COOLDOWN" eligibility rule depends on `state` being maintained.

**Issue:**
R1 specifies the *selector* to call but not how account `.score` and `.state` get populated before selection. `applyTelemetry()` (the only code that sets DEGRADED/UNAVAILABLE from telemetry) is never invoked, and nothing calls `scoreAccount()/setScore()`. An implementer can wire `selectBestAccount()` into start/dry-run/failover and still operate on permanently-`null` scores and permanently-`HEALTHY` states — behaviourally identical to priority-only.

**Impact:**
R1's acceptance ("runtime account selection cannot bypass scoring, eligibility, or circuit-breaker state") can be reported as met while scoring is effectively inert. Soft-threshold failover and score-based target preference remain broken — the exact P1-CR-001 defect R1 exists to fix. Dry-run "reports the scored selection" cannot be satisfied at all without a CLI-side refresh path that reads persisted circuit-breaker state and per-account statusline files.

**Optimal Fix:**
Extend R1 with an explicit refresh contract: (1) a single helper that, for each configured account, reads its telemetry (`readTelemetryForAccount`/`scoreAccount`), calls `setScore()`, and calls `applyTelemetry()` (or an equivalent state refresh) using circuit-breaker `getState()`; (2) the exact call-sites — before start admission (`server.ts /api/sessions`), before each failover target selection (loop-manager soft/hard paths and `onSwitch`), and inside dry-run; (3) for dry-run, state that the CLI must load persisted `circuit-breaker-state.json` and statusline files itself (no daemon registry available), or route dry-run through the daemon. Name the canonical selector (see ME-001).

**Why This Fix:**
It closes the gap between "selector wired" and "selection actually scored/eligible," and makes the dry-run acceptance criterion achievable in the process where dry-run actually runs.

**Fix Validated:**
YES — verified `scoreAccount`/`setScore`/`applyTelemetry`/`selectBestAccount` have zero non-test callers and that `score`/`state` are never refreshed; verified the two priority-only selection sites.

**Validation Command or Check:** `grep -rn "setScore\|scoreAccount\|selectBestAccount\|applyTelemetry" src/ | grep -v test`

**Test Changes:** R1 tests should assert that a candidate with lower priority but higher *refreshed* score wins, and that dry-run output reflects the scored selection (not priority order) — both require the refresh to run, which today's tests would not force.

**Affected Tasks or Sections:** Phase 1 Remediation R1 (P1-CR-001/P1-FULL-001), R6, Task 6.

---

#### HI-002: Task 7 does not define the EXHAUSTED auto-resume *action* (`onAccountAvailable`), only the poller

**Evidence:**
- Task 7 (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:463-496`) fully specifies the poller (`ExhaustedRecoveryDeps`, candidate logic via `getState()`, max-retries, start/stop triggers) but the resume *body* is only the callback signature `onAccountAvailable: (sessionId, account) => Promise<void>`. Nothing states what it must do.
- An EXHAUSTED session has no live runner (`performSwitch` set `EXHAUSTED` + cleared `switch_tx` after destroying the source pane — `src/failover/switcher.ts:294-329`), and its persisted `account`/`transcript_path` point at the account that exhausted.
- Resuming therefore requires the same work as a switch: migrate the transcript from the persisted (source) account to the now-available account and launch with the R3 resume/fresh decision — not merely flipping persisted state to `ACTIVE`.

**Issue:**
Without specifying the resume action, an implementer can wire `onAccountAvailable` to `patchState(..., {status:'ACTIVE'})` (or call the launch path without migration), producing a session marked ACTIVE with no runner, or a resume against an account that has no transcript.

**Impact:**
Auto-resume can pass poller-level unit tests (cooldown expiry, re-arm, max-retries) while never actually relaunching a working session — defeating the whole feature and the `auto_resume_exhausted` durability acceptance criterion.

**Optimal Fix:**
Specify that `onAccountAvailable` performs a `performSwitch`-style relaunch: `sourceAccount` = the EXHAUSTED session's persisted `account`, target = the available account, reusing the R3 migration-owns-resume decision, and emitting `recovery.exhausted_resumed` only after a successful target launch (and `recovery.exhausted_max_retries` when retries are exhausted). State that on launch failure the session stays EXHAUSTED and polling continues until `max_exhausted_retries`.

**Why This Fix:**
It reuses the canonical switch path (no parallel relaunch logic), keeps R3's safe resume/fresh decision authoritative, and ties the `recovery.exhausted_resumed` event to a real launch.

**Fix Validated:**
YES — verified `performSwitch` leaves no live runner on exhaustion and that EXHAUSTED state carries the source account/transcript needed to migrate on resume.

**Validation Command or Check:** Read `src/failover/switcher.ts:294-329` and `src/daemon/index.ts:172-243` (onSwitch wiring the poller would reuse).

**Test Changes:** Task 7 tests should assert that resume invokes the migration+launch path with the persisted source account, not a bare state flip.

**Affected Tasks or Sections:** Task 7, Phase 1 Remediation R3 (migration decision), R8.

---

### MEDIUM

#### ME-001: Two parallel account selectors violate the one-canonical rule

**Evidence:** `selectBestAccount()` (`src/accounts/scorer.ts:92`, alphabetical tiebreak, no soft-target logic, currently dead) and `selectSwitchTarget()` (`src/failover/switcher.ts:55`, soft-threshold better-target logic, priority tiebreak, actually used by loop-manager and `onSwitch`). R1 tells the implementer to "use `selectBestAccount()` or the canonical selector" (`docs/plans/...:80`) while failover already uses `selectSwitchTarget()`.

**Issue:** Wiring `selectBestAccount()` for start/dry-run while failover keeps `selectSwitchTarget()` creates two divergent selection semantics (tiebreak, soft-target). AGENTS.md rule 3 requires one canonical path.

**Impact:** Start admission and failover could pick different accounts for the same registry state; the soft-target rule would exist in only one of the two. Future changes must be made twice.

**Optimal Fix:** Designate one canonical selector (recommend `selectSwitchTarget`, since it already carries soft-target semantics and is wired) for start admission, dry-run, and failover; refactor or delete the other. State this in R1.

**Fix Validated:** YES — both functions read; only `selectSwitchTarget` has callers.

**Affected Tasks or Sections:** R1, R6, Task 6.

---

#### ME-002: `cost.snapshot` schema lacks segment identity required by Task 4 aggregation

**Evidence:** Task 3 names only `cost.total_cost_usd`, `model.id`, `context_window.context_window_size` as snapshot fields (`docs/plans/...:391-394`). Task 4 must compute "per aisup session cost = sum of final/max costs across Claude session segments" (`docs/plans/...:411`). A Claude `cost.total_cost_usd` resets to ~0 when a switch creates a new account/transcript segment, so segmentation requires `claude_session_id` (and `account`) on each event. The `$0.01` delta filter (`docs/plans/...:393`) suppresses emission of the reset itself (a negative delta), and a naïve running sum would double-count or under-count across segments.

**Issue:** Task 3 (producer) does not commit to emitting the keys Task 4 (consumer) needs to delineate and max-reduce segments, and neither task addresses the cost-reset-on-switch behaviour.

**Impact:** Aggregation either cannot segment (no `claude_session_id` on the event) or mis-sums across switches, yielding wrong `aisup cost` / `/api/cost` numbers.

**Optimal Fix:** Specify that `cost.snapshot` carries `claude_session_id` and `account` (both already available on the session in `rateLimitTick`, see `src/daemon/loop-manager.ts:134-139`), and that Task 4 aggregates by taking the max `total_cost_usd` per `claude_session_id` segment and summing segments per aisup session. Note explicitly that a downward delta (reset) is expected at segment boundaries and is not journaled as a snapshot.

**Fix Validated:** YES — `JournalEvent` supports top-level `claude_session_id`/`account` (`src/journal/types.ts:65-74`); session object exposes both.

**Affected Tasks or Sections:** Task 3, Task 4, Task 5.

---

#### ME-003: Task 3 lifecycle-snapshot wiring omits the stop and manual-failover paths (they live in `server.ts`/`slack`, not `daemon/index.ts`)

**Evidence:** Task 3 says "emit a final snapshot on session stop and before account switch **from `src/daemon/index.ts`**" and lists only `src/daemon/loop-manager.ts` + `src/daemon/index.ts` (`docs/plans/...:384-394`). But session stop executes in `src/daemon/server.ts:141-160` (DELETE `/api/sessions`) and Slack `!stop` in `src/slack/service.ts:219-235`; manual failover executes in `src/daemon/server.ts:180-245`. `daemon/index.ts` owns only the *automatic* `onSwitch` (`src/daemon/index.ts:172-243`) and daemon-process shutdown — not session stop or manual failover.

**Issue:** The "final snapshot on session stop / before switch" can only be hooked from `daemon/index.ts` for the automatic-switch path. Manual stop, Slack stop, and manual failover would not get a final snapshot.

**Impact:** Cost ledger misses the last segment of manually-stopped or manually-failed-over sessions, contradicting Task 3's acceptance.

**Optimal Fix:** Either add `src/daemon/server.ts` (and the `onSessionStop` boundary in `daemon/index.ts`) to Task 3 and hook the final snapshot in the canonical stop/failover paths, or explicitly scope lifecycle snapshots to the automatic `onSwitch` path and document that manual stop/failover rely on the last periodic snapshot.

**Fix Validated:** YES — verified stop/failover code paths are in `server.ts`/`slack`, not `daemon/index.ts`.

**Affected Tasks or Sections:** Task 3 (HI-003), Task 5.

---

#### ME-004: Rehydration → exhausted-poller startup handoff and ordering is unspecified

**Evidence:** Daemon startup runs `rehydrateSessions()` at `src/daemon/index.ts:93`, **before** `LoopManager` (line 110) and well before any `ExhaustedRecovery` service would be constructed. `rehydrateSessions()` returns only `{ rehydrated, orphans }` counts (`src/daemon/rehydration.ts:223`) — no session ids. R8/Task 2/Task 7 each reference re-arming EXHAUSTED polling from rehydration (`docs/plans/...:174-176, 374, 493`) but none define how rehydration hands the persisted-EXHAUSTED session set to a poller that does not yet exist at rehydration time.

**Issue:** "Start polling when daemon startup rehydrates a persisted EXHAUSTED session" cannot happen inside `rehydrateSessions` (deps absent) and the current return value cannot drive a later re-arm (no ids).

**Impact:** An implementer may attempt to start polling where the poller does not exist, or silently omit the restart re-arm, breaking the "durable across daemon restarts" acceptance.

**Optimal Fix:** Specify the handoff: `rehydrateSessions()` (or the new EXHAUSTED branch) records persisted-EXHAUSTED session ids (return them or set them via `setSessionState`), and after the daemon constructs `ExhaustedRecovery`, it re-arms polling for those ids. State that the EXHAUSTED branch must also restore API visibility (`setSessionState`) so manual failover/stop work post-restart (R8/R9).

**Fix Validated:** YES — verified startup ordering and the counts-only return signature.

**Affected Tasks or Sections:** Task 2, Task 7, R8, R9.

---

#### ME-005: `permissions.detection_patterns` defaults to `[]` but Task 8 assumes built-in default patterns

**Evidence:** C1 sets the config default `detection_patterns: []` (`docs/plans/...:293`). Task 8 says "Default patterns must match full prompt-like lines and avoid generic `Allow` false positives" and "Own `permissions.detection_patterns` here or rely on C1" (`docs/plans/...:518-520`). Task 9 also references defaults.

**Issue:** If the detector treats the config list as authoritative and the default is `[]`, an operator who sets `permissions.enabled: true` without listing patterns gets zero detection — yet Task 8's "default patterns" language implies a built-in set exists. The source of the "default patterns" is ambiguous.

**Impact:** Permission detection ships inert when enabled-with-empty-patterns; the false-positive tests Task 8 mandates have no patterns to run against unless built-ins exist.

**Optimal Fix:** State explicitly that the detector ships a built-in default pattern constant (in `src/permissions/detector.ts`) used when `permissions.detection_patterns` is empty, and that the config list overrides/extends it. Keep `enabled: false` as the safe default.

**Fix Validated:** N/A (plan-text clarity); consistent with the existing `detect429InOutput` module-level regex pattern Task 6 cites.

**Affected Tasks or Sections:** C1, Task 8, Task 9.

---

### LOW

#### LO-001: R3/R7 — migrator's `skipped_no_transcript` result is unreachable and the switcher drops `target_*` fields it already has

**Evidence:** `MigrationResult.status` includes `'skipped_no_transcript'` (`src/failover/migrator.ts:26`) but `migrateTranscript` never returns it (it throws on missing source). The null-transcript case is handled by the switcher *skipping the migration block entirely* (`src/failover/switcher.ts:162`) with no event. The switcher's `migration.completed` event logs `source_path`/`source_sha256` only (`src/failover/switcher.ts:183-189`) even though `migrationResult` already carries `targetPath`/`targetSha256` (`src/failover/migrator.ts:151,161,174`). `migration.invalid_path` emits raw `error: String(err)` (`src/failover/switcher.ts:196`) rather than the safe reason enums R7 lists.

**Issue:** R3's `migration.skipped_no_transcript` emit-point is the switcher's null-transcript branch (which currently silently skips); R7's `target_path`/`target_sha256`/`source_size`/collision metadata and safe-reason-enum work is mostly event-builder wiring in the switcher, not the migrator.

**Optimal Fix:** In R3, state that the switcher's `transcriptPath == null` branch emits `migration.skipped_no_transcript`. In R7, state that the switcher must propagate `migrationResult.targetPath`/`targetSha256` into the migration event and that `migration.invalid_path` must map exceptions to enums (`symlink_rejected`, `not_regular_file`, `wrong_extension`, `outside_source_dir`, `target_parent_symlink`, `basename_mismatch`) instead of raw text; have the migrator also return `sourceSize`.

**Fix Validated:** YES — verified migrator return shape, switcher event builders, and the silently-skipped null branch.

**Affected Tasks or Sections:** R3, R7.

---

#### LO-002: Task 6 network-error counter reset on "successful restart" depends on R13, which Task 6 does not list

**Evidence:** Task 6 resets the network-error counter on "non-error output, switch, stop, or successful restart" (`docs/plans/...:459`). "Successful restart" detection requires `onRestart` to report success — which R13 adds (`docs/plans/...:240-241`). Today `onRestart` returns `Promise<void>` (`src/daemon/loop-manager.ts:37`) and the restart counter increments per dead-tick. Task 6's dependency list (`docs/plans/...:443`) names R1, R11, C1 but not R13.

**Issue:** Without R13's success-aware `onRestart`, Task 6 cannot reset on "successful restart"; the restart counter (R13) and the network-error counter (Task 6) are two per-session maps with overlapping reset semantics that should share reset trigger points.

**Optimal Fix:** Add R13 to Task 6's dependencies and state that the restart and network-error counters reset at the same points (switch, stop, successful restart) using the success-aware `onRestart`.

**Fix Validated:** YES — verified `onRestart` signature and the dead-tick counter behaviour.

**Affected Tasks or Sections:** Task 6, R13.

---

### INFO

#### IN-001: Phase 1 Remediation Gate verified genuinely pending; several event *types* exist without emitting behaviour

**Evidence (positive confirmation):** R1 (scoring/eligibility dead code), R2 (pre-switch no-target does not persist EXHAUSTED — `src/daemon/index.ts:178-194` only emits the event), R3 (launch keys off `snapshot.claudeSessionId` not migration outcome), R4 (`migrating`/`creating`/`source_destroyed` only log `needs_manual_failover`; ACTIVE-without-tmux does not restart — `src/daemon/rehydration.ts:80-115,173-181`), R5 (idle still emits `session.stop`, no throttle — `src/daemon/index.ts:149-156`; `session.idle_detected` absent from the union), R6 (retry `others` includes COOLDOWN — `src/failover/switcher.ts:208-210`; `onSwitch` ignores reason/score — `src/daemon/index.ts:177`), R8 (no EXHAUSTED rehydration branch; persisted EXHAUSTED falls through every branch), R9 (`/api/status` returns in-memory `sessionState`; `aisup log` hardcodes the journal path — `src/cli/commands/log.ts:8`), R10 (`slack.channel_name_collision` emitted on the *non-collision* error branch — `src/slack/service.ts:93-101`; `!stop` bypasses `session.stop`/`onSessionStop`), R11 (no `hasSession()`; `isProcessDead` returns `true` on any error so an externally-killed session is misclassified as a dead pane), R12 (`scanTelemetryForActiveSession` accepts candidates with **missing** `cwd` — `src/statusline/store.ts:143`; no `workspace.project_dir`), R13 (per-dead-tick counter, no success-clear). Notably, `session.destroyed_externally` is emitted only from rehydration, not the live recovery tick; the `SessionMismatch` interface (`src/statusline/types.ts:28`) and `MigrationResult.skipped_no_transcript` are unused/unreachable. **R14 is correct: `docs/plans/2026-05-07-phase1-alignment-scan.md` is stale and must be reconciled after R1–R13.**

**Impact:** None on its own — this validates that the gate describes real work. Recorded so the implementer treats the gate as authoritative and does not assume the alignment-scan commits already covered behaviour.

**Affected Tasks or Sections:** Entire Phase 1 Remediation Gate; R14.

---

## Resolved or Superseded Findings

From `docs/reviews/2026-05-28-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md`:

- **Prior HI-001 (smoke test shares production tmux socket):** RESOLVED — merged into C1 (`session.tmux_socket` with default `aisup`, validated) and Task 1 (test socket `aisup-test-<pid>`, replace hardcoded socket in daemon/dry-run/attach/rehydration/loop-manager/Slack), confirmed in plan text `docs/plans/...:280-308, 345-350`.
- **Prior HI-002 (deny keystroke contract):** RESOLVED — merged into C1 (`permissions.denial_key` default `n`, control-input validation) and Task 10 (denial keystroke via `sendText`+`sendEnter`, freshness/TTL, host-gated approve+deny validation, fallback-to-`permission.expired` clause), confirmed at `docs/plans/...:278, 309, 562-564, 646, 661`.

## Review Methodology

**Files and docs read:** the full Phase 2 plan; `AGENTS.md`; prior reviews `2026-05-28-plan-review`, `2026-05-28-merged-phase2-plan-merge-audit`, `2026-05-06-phase1-full-implementation-review`, `2026-05-05-aisup-final-blocking-plan-review-v2` (heads); source: `src/journal/types.ts`, `src/session/types.ts`, `src/config/{schema,defaults,loader}.ts`, `src/daemon/{index,loop-manager,rehydration,server}.ts`, `src/failover/{switcher,migrator,types}.ts`, `src/accounts/{scorer,registry,circuit-breaker}.ts`, `src/statusline/{store,types}.ts`, `src/session/{manager,tmux}.ts`, `src/slack/{service,commands}.ts`, `src/cli/{index,pid}.ts`, `src/cli/commands/{start,log}.ts`, `src/journal/reader.ts`, `package.json`.
**Searches and commands run:** `git log/branch/status`; source tree enumeration; `grep` for `setScore|scoreAccount|selectBestAccount|applyTelemetry`, `selectSwitchTarget`, `getActiveSession`, `session.stop|idle_detected|lastIdleEmit`; lock-file detection (`package-lock.json` present → npm; Task 9's `picomatch` + lock edit valid).
**External contracts checked:** `strip-ansi` present (Task 6); `picomatch` absent (Task 9 adds it); `@slack/bolt`/`@slack/web-api`/`fastify` present. tmux behaviour of `#{pane_dead}` vs missing-session (R11) reasoned from `src/session/tmux.ts`.
**Skipped checks, missing context, and residual risk:** Did not execute the test suite or any tmux/Claude/Slack host-gated path (read-only review; no behavioural regression introduced by a review). The exact Claude permission-prompt approval/denial keystrokes (Task 10 / prior HI-002) remain unverifiable without the `AISUP_TEST_PERMISSIONS=1` host run — the plan already gates this with a documented fallback. The full 3,209-line `2026-05-12` review was consulted via the merge audit and current-plan traceability matrix rather than re-read in full; all 76 finding IDs are present in the plan matrix per the prior audit, which I did not re-run.
