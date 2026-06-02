# Phase 2 spec-verify — Fresh Verification Findings (2026-06-02)

Plan: `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
Trigger: fresh re-verification pass (plan was marked `Status: VERIFIED`, `Iterations: 4`).
Original verdict: **FAIL — must_fix issues remain.** Plan reverted VERIFIED → PENDING; after F1-F4 remediation and clean compliance re-audits, the plan is now `Status: VERIFIED`, `Iterations: 5`.

> **Compliance-audit status (2026-06-02, Round 3 — CLEAN):** Fresh re-audit of the
> current working tree found **zero open issues**. F1, F2, F3, and F4 remain
> **RESOLVED** with regression tests. Current validation: `npm run typecheck`,
> `npm run build`, focused F1-F4 suites (`PASS (74) FAIL (0)`), and full
> `npx vitest run` (`457 passed / 0 failed / 2 skipped` host-gated). Working-tree
> scope is limited to the F1-F4 remediation files, the plan verification-gap
> note, and this findings doc. See the **Compliance Audit Log** at the bottom
> for the per-round trace.

## Review setup (confirmed before running)

- `CLAUDE_CONFIG_DIR=/Users/alecbrock/.claude-account2`
- `PILOT_SPEC_REVIEW_ENABLED=true`, `PILOT_CHANGES_REVIEW_ENABLED=true`, `PILOT_CODEX_SPEC_REVIEW_ENABLED=true`, `PILOT_CODEX_CHANGES_REVIEW_ENABLED=true`
- Agents available: `changes-review` ✅, `spec-review` ✅, Codex changes-review path ✅ (companion v1.0.4 under active profile, `codex-cli 0.135.0` authenticated).

## Original mechanical gates (all green)

- Typecheck (`tsc --noEmit`): clean.
- Build (`tsup`): success.
- Original spec-verify full test suite (`vitest run` before F1-F4 regression tests): 449 passed / 2 skipped (host-gated integration) / 0 failed. Current Round 3 full suite: 457 passed / 2 skipped / 0 failed.
- Lint: no ESLint config present in repo — `npm run lint` cannot execute (pre-existing; not introduced by Phase 2).
- File lengths: max changed prod file 697 lines (`loop-manager.ts`), under the 800 guideline.
- Program execution: `aisup cost/gate/log --type` wired; cost aggregation output verified correct end-to-end (segment-aware reset scenario returned 8.00, rejecting naive sum=11.50 / last-value=3.00).

## Code review

- **Claude `changes-review`:** PASS (compliance high, quality high, goal achieved); 22/23 truths verified; 1 should_fix (host-gated permission validation doc) — resolved: `tests/integration/TELEMETRY_FIELDS.md` records the approval+denial validation as deferred-with-exact-reason and documents the full manual procedure.
- **Codex changes-review (adversarial):** **REJECT** — 3 findings, all confirmed against the code below. (First Codex job `task-mpwwgg35` hung 22m at "starting" and was cancelled; re-launched `task-mpwxev9s` completed healthily after a liveness smoke test confirmed the backend.)

## Confirmed findings (original spec-verify pass)

### F1 — CRITICAL / must_fix — EXHAUSTED relaunch terminates a missing source pane — ✅ RESOLVED
- **Where:** `src/failover/switcher.ts:251-255` → `src/session/manager.ts:226-245` (`terminateRunnerForSwitch`, `{ force: false }`) → `src/session/tmux.ts:110-112` (`sendInterrupt`).
- **Mechanism:** `performSwitch` unconditionally runs the "terminate source runner" phase before target creation. With `force:false`, `terminateRunnerForSwitch` calls `sendInterrupt`, which runs `tmux send-keys -t <name> C-c` with **no try/catch**; `tmuxWithTimeout` throws when the pane is missing. An EXHAUSTED session has no live runner (its source pane was destroyed before `EXHAUSTED` was persisted — per the plan's own Task 7 text), so `state.tmux_name` is dead.
- **Impact:** Both EXHAUSTED auto-resume (`src/recovery/exhausted.ts:151-165` → `performSwitch`) and post-restart manual failover throw at the termination phase before reaching `createSessionForTarget`. Task 7 / R8 auto-resume — a core Phase 2 DoD — is unreachable.
- **Resolution (verified):**
  - `src/failover/switcher.ts:256-263` — `sourceAlreadyGone = state.status === 'EXHAUSTED' || state.switch_tx?.source_destroyed === true`; the termination phase is **skipped** when the source is already gone, so the throwing op never runs on a resume-from-EXHAUSTED.
  - `src/session/manager.ts:235-244` — `terminateRunnerForSwitch` now wraps `sendInterrupt` in try/catch; a missing pane is treated as "nothing to interrupt." Downstream `stopPipePane`/`destroyTmuxSession` already swallow missing-session errors (`src/session/tmux.ts:89-95, 149-155`), so the full termination path is non-fatal.
  - `account.switch` `runner.terminated_for_switch` journal detail now records `source_already_gone`.
- **Regression test:** `tests/failover/switcher.test.ts` — "resumes an EXHAUSTED session without terminating the missing source pane" injects a `terminateRunnerForSwitch` that throws and asserts it is never called and the target still launches (`status: 'completed'`, `targetAccount: 'account2'`).

### F2 — HIGH / must_fix — Auto-resume target bypasses registry eligibility — ✅ RESOLVED
- **Where:** `src/recovery/exhausted.ts:80-86` (`findRunnableAccount`) and `src/failover/switcher.ts:337-340` (primary target).
- **Mechanism:** `findRunnableAccount` treated an account as runnable on circuit-breaker `CLOSED/HALF_OPEN` alone, ignoring registry `state`. The daemon refreshed scores/state only *after* this selection. `performSwitch` then pushed the explicit primary target into `targetOrder` **without** the `HEALTHY/DEGRADED` filter the retry list gets.
- **Impact:** Auto-resume could relaunch into an account the refreshed registry would exclude (rate-limited / unavailable), causing immediate re-failure / churn.
- **Resolution (verified):**
  - `src/recovery/exhausted.ts:88-96` — `findRunnableAccount` now also requires `acct.state === 'HEALTHY' || 'DEGRADED'` (the canonical eligibility filter) in addition to CB-runnable. Aligns with the merged Verification-Gaps F2 directive (plan L672); does not contradict Task 7 L514 (CB `getState` is still consulted for candidacy).
  - `src/recovery/exhausted.ts:101-104` + `src/daemon/index.ts:276,284` — `refreshAccounts()` is invoked before selection (in `pollOnce`) and again immediately before `resumeExhaustedSession` (in `onAccountAvailable`), and `accountRegistry.getAll()` is read **after** the refresh, so `performSwitch` sees fresh state.
  - `src/failover/switcher.ts:351-357` — the primary target is pushed only when `selectionMode === 'manual'` (operator override) or it passes `primaryEligible` (enabled + HEALTHY/DEGRADED). Automatic selection can no longer relaunch into an ineligible primary.
- **Regression tests:** `tests/recovery/exhausted.test.ts` — "skips a registry-UNAVAILABLE account even when its circuit breaker is runnable" and "refreshes account state before selecting a resume target" (asserts refresh ordering). `tests/failover/switcher.test.ts` — "skips an UNAVAILABLE primary target during automatic selection" and "launches a COOLDOWN primary target for a manual failover (operator override)".

### F3 — MEDIUM / should_fix — Slack reports permission success before the broker confirms — ⚠️ PARTIALLY RESOLVED (see F4)
- **Where:** `src/daemon/index.ts:98-99` and `src/slack/service.ts:373-374, 381-382`.
- **Mechanism (original):** The daemon's `onPermissionGrant`/`onPermissionDeny` discarded the `Promise<boolean>` from `resolveFromSlack`. Slack `!permit`/`!deny` awaited a void callback and then unconditionally replied "Permission granted/denied."
- **Resolution applied (verified):**
  - `src/daemon/index.ts:98-99` — callbacks now return `resolveFromSlack(...) ?? Promise.resolve(false)` instead of discarding the boolean.
  - `src/slack/service.ts:26-29, 373-386` — `onPermissionGrant`/`onPermissionDeny` typed `boolean | Promise<boolean>`; Slack reports success only when the callback resolves `true`, otherwise "No pending permission prompt … may have expired or already been resolved."
- **Residual gap:** The success boolean originates from `PermissionBroker.resolveFromSlack`, which returns `true` even when the keystroke was **not** sent. See **F4**.

## Compliance Audit Findings (post-fix iteration, 2026-06-02)

### F4 — MEDIUM / should_fix — `resolveFromSlack` reports success when no keystroke was sent — ✅ RESOLVED
- **Source of truth:** Plan L593 ("Do not emit `permission.denied`/`permission.auto_denied` until the denial keystroke has been sent after prompt freshness checks") and L594 ("re-scan recent output to confirm the prompt is still active … emit timeout or unconfirmed events"); Verification-Gaps F3 directive L673 ("report Slack success **only when the keystroke was actually sent**").
- **Implementation evidence:** `src/permissions/broker.ts:57-69` (`resolveFromSlack`) and `src/permissions/broker.ts:71-92` (`act`).
  - `act()` has two early-return paths that send **no** keystroke and emit `permission.keystroke_unconfirmed`: prompt no longer active (`!promptStillActive`, L79-82) and keystroke delivery failure (`!sendKeystroke`, L84-87). Both return `void`.
  - `resolveFromSlack` does `await this.act(...); return true;` (L67-68) — so it returns `true` regardless of whether `act` actually sent the keystroke. Only the no-pending (L59) and TTL-expired (L63-66) cases return `false`.
- **Issue:** When a Slack `!permit`/`!deny` arrives for a pending, non-expired prompt that is no longer on screen (operator already answered in the terminal, prompt scrolled off) or whose keystroke send fails, `resolveFromSlack` returns `true`, so `SlackService` replies "Permission granted/denied." even though no keystroke was delivered and only `permission.keystroke_unconfirmed` was journaled.
- **Impact:** Operators are told an approval/denial succeeded when it did not — the exact false-success failure mode F3 targets, surviving in the unconfirmed sub-case. Undermines the keystroke-confirmation contract.
- **Fix:** Make `PermissionBroker.act` return `Promise<boolean>` (`false` on both unconfirmed paths, `true` only after the grant/deny event is emitted). Have `resolveFromSlack` return that result (`return this.act(...)`). Update `onDetected`'s three `act` call sites to `await … ; return;` (they ignore the boolean) so the method keeps its `Promise<void>` signature.
- **Why this fix:** Smallest plan-aligned correction; reuses the existing `keystroke_unconfirmed` signal as the single source of "did not act"; no new state or contract. `onDetected` callers are unaffected.
- **Fix validation:** YES — after applying, `tsc --noEmit` clean, full `vitest run` green, plus a new broker test asserting `resolveFromSlack` returns `false` (and Slack reports failure) when `promptStillActive` is false at resolve time.
- **Validation:** `tests/permissions/broker.test.ts` (new: unconfirmed-at-resolve returns false); existing `tests/slack/service.test.ts` F3 cases remain green; `npx tsc --noEmit`; `npx vitest run`.
- **Affected requirements/tasks:** Task 10 (permission routing / `!permit`,`!deny`); Verification-Gaps F3.
- **Cascading side effects:** `act` is called by `onDetected` (auto-grant/deny/route) — those callers discard the return, so behavior is unchanged; only `resolveFromSlack`'s return value is corrected.
- **Resolution (verified):** `src/permissions/broker.ts:72-95` — `act` now returns `Promise<boolean>` (`false` on both `keystroke_unconfirmed` paths, `true` only after the grant/deny event emits). `src/permissions/broker.ts:69` — `resolveFromSlack` returns `this.act(...)`. `src/permissions/broker.ts:43-44,53` — `onDetected` `await`s `act` and returns void (boolean discarded). Regression tests `tests/permissions/broker.test.ts`: "returns false … when the prompt is no longer active at resolve time" and "returns false … when the keystroke fails to send" (both assert no success event emitted).

## Compliance Audit Log

- **Round 1 (2026-06-02):** Audited working-tree fixes for F1/F2/F3 against the plan. F1 RESOLVED, F2 RESOLVED, F3 PARTIALLY RESOLVED → opened **F4** (residual unconfirmed-keystroke false-success). Recommendation: FIX_AND_RE_AUDIT.
- **Round 2 (2026-06-02):** Applied the F4 fix (`broker.act` returns boolean; `resolveFromSlack` propagates it; new regression tests). Re-audited from scratch — re-read the full diff and all changed source against the plan. **Zero open issues.** All compliance passes (plan-to-delivery, delivery-to-plan, behavior, test-and-validation, cascading) produced no new supported finding. `npx vitest run`: 457 passed / 0 failed / 2 skipped. `git status`: only F1–F4 remediation files + this findings doc. Recommendation: **COMPLIANT**.
- **Round 3 (2026-06-02):** Fresh continuation audit from current working tree. Re-read the source plan, the existing findings doc, the latest diff, and changed implementation/tests for F1-F4. Re-checked call sites for `performSwitch`, `terminateRunnerForSwitch`, `ExhaustedRecovery`, `resumeExhaustedSession`, `resolveFromSlack`, and Slack permission callbacks. **Zero open issues.** Validation passed: `npm run typecheck`; `npm run build`; `npx vitest run tests/failover/switcher.test.ts tests/recovery/exhausted.test.ts tests/permissions/broker.test.ts tests/slack/service.test.ts` (`PASS (74) FAIL (0)`); `npx vitest run` (`457 passed / 0 failed / 2 skipped`). Recommendation: **COMPLIANT**.

## Decision

**Compliance audit CLEAN (Round 3).** The newest review pass says zero open issues remain. F1, F2, F3, and F4 are resolved with regression tests; typecheck, build, focused suites, and full suite are green. Working-tree scope is limited to the intended remediation files, plan verification-gap note, and this findings doc. The plan is currently marked `Status: VERIFIED`, `Iterations: 5`.
