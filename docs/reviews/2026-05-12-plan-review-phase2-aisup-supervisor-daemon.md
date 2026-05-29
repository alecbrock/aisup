# Implementation Plan Review: Phase 2 aisup Supervisor Daemon

**Plan:** docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
**Reviewed:** 2026-05-27
**Review Iterations:** 19
**Status:** ISSUES_FOUND

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 5 | Blocks implementation or causes incorrect behavior |
| HIGH | 14 | Significant gap that will cause rework |
| MEDIUM | 23 | Quality issue that reduces plan clarity or implementation quality |
| LOW | 8 | Minor improvement, unlikely to cause problems |
| INFO | 4 | Observation or suggestion, no action required |

**Total active findings:** 54
**Historical findings:** 56 (CR-005 superseded by CR-006; ME-019 rejected; not counted active)
**Recommendation:** FIX_AND_RE_REVIEW

**Phase 1 compliance addendum (2026-05-13):** 4 additional pre-Phase-2 gates were found while auditing Phase 1 implementation against `docs/plans/2026-04-29-aisup-supervisor-daemon.md` and the Phase 1 alignment scan at `docs/plans/2026-05-07-phase1-alignment-scan.md`. These are appended below and are not included in the Phase 2 plan-review totals above.

**Full Phase 1 compliance audit (2026-05-27, iteration 16 refresh):** Comprehensive re-audit of all Phase 1 tasks (1–14) against HEAD `297fb42` plus the current dirty docs worktree found the same 15 current Phase 1 compliance issues (3 CRITICAL, 8 HIGH, 4 MEDIUM). One prior finding, P1-FULL-007, remains REJECTED because the cited empty `accountConfigDir` field is not used for runner env construction. No new Phase 1 compliance issues were found. Phase 2 must not start until all CRITICAL and HIGH Phase 1 issues are resolved. See "Full Phase 1 Compliance Audit — 2026-05-26 (Refreshed 2026-05-27)" section at end of file.

**Iteration 19 refresh (2026-05-27):** Full cohesion and validation pass requested by the operator. Re-read the Phase 2 plan and this review completely, re-checked Phase 2 active findings and the Phase 1 compliance audit against current source at HEAD `297fb42`, and corrected stale review-internal contradictions left by earlier iterations. HI-005 now defers to HI-012's shell-free gate-command fix instead of recommending an unqualified shell boundary. IN-004 now reflects the current EXHAUSTED evidence: `performSwitch()` does persist/emit `session.exhausted`, while the pre-switch no-target branch in `daemon/index.ts` still does not. Historical Iteration 3/8/9/11 notes were annotated where CR-005 and ME-019 are superseded/rejected. Added four medium Phase 2 plan gaps found during this pass: missing `aisup log --type` task wiring, cost offline mode hardcoding the default journal path, missing exhausted max-retry config/event ownership, and unspecified glob-matching implementation/dependency. Active Phase 2 counts are now 54 findings: 5 critical, 14 high, 23 medium, 8 low, 4 info. Fresh typecheck passed; full Vitest passed with `273 passed`, `0 failed`, and `11 skipped` tmux-backed tests due local socket restriction.

**Iteration 18 refresh (2026-05-27):** Re-read the Phase 2 plan, prior review, PRD Phase 2 scope, Phase 1 alignment scan excerpts, handoff notes, and current source boundaries against HEAD `297fb42`. Corrected stale ME-019 evidence: `SessionManager.createSession()` does not use `accountConfigDir` when constructing the runner environment, and the existing daemon `onRestart` path already builds the command/env from `accountRegistry.get(state.account).configDir`, so the claimed `CLAUDE_CONFIG_DIR=''` failure is unsupported. ME-019 is now rejected and not counted active; HI-004 remains the active architectural blocker for rehydration recovery callbacks. Active Phase 2 counts are now 50 findings: 5 critical, 14 high, 19 medium, 8 low, 4 info. Typecheck passed; full Vitest suite passed with `273 passed`, `0 failed`, `11 skipped` tmux-backed tests due local socket restriction.

**Iteration 17 refresh (2026-05-27):** Re-read the Phase 2 plan, prior review, PRD Phase 2 scope, Phase 1 alignment scan excerpts, handoff notes, and current source boundaries. Corrected stale CR-005 evidence: `performSwitch()` now persists `EXHAUSTED` and emits `session.exhausted` in `src/failover/switcher.ts:311-327`, so the old "not persisted" claim is superseded. Added CR-006 for the remaining active Task 7 blocker: the plan starts `ExhaustedRecovery` only when the current daemon observes `performSwitch()` return `exhausted`; it does not specify re-arming polling from persisted `EXHAUSTED` state during daemon restart. Active Phase 2 counts remain unchanged at 51 findings because CR-005 was replaced by CR-006. Typecheck passed; focused daemon/config/Slack/failover/journal tests passed; full Vitest suite passed with `273 passed`, `0 failed`, `11 skipped` tmux-backed tests due local socket restriction.

**Iteration 16 refresh (2026-05-27, full Phase 1 compliance re-audit — sixth independent auditor session):** Sixth independent full Phase 1 compliance re-audit against HEAD `297fb42` plus dirty docs-only worktree. Re-verified all 15 current P1-FULL findings remain unfixed through targeted `rg` searches and source reads of daemon/index.ts, server.ts, loop-manager.ts, rehydration.ts, switcher.ts, session/manager.ts, statusline/store.ts/types.ts, slack/service.ts, cli commands, doctor, health/recovery loops, README, and runbook. No new Phase 1 compliance issues found. Typecheck passed. Full Vitest suite passed with `273 passed`, `0 failed`, `11 skipped` (tmux-backed tests skipped because the sandbox cannot connect to the tmux socket). Alignment scan implementation status remains partially implemented in code but its plan progress remains stale (`139` unchecked, `0` checked).

**Iteration 15 refresh (2026-05-26, full Phase 1 compliance re-audit — fifth independent auditor session):** Fifth independent full Phase 1 compliance re-audit by a separate auditor session against HEAD `297fb42`. Re-verified all 15 current P1-FULL findings remain unfixed through targeted `rg` searches and source reads of daemon/index.ts, server.ts, loop-manager.ts, rehydration.ts, switcher.ts, session/manager.ts, slack/service.ts, statusline/types.ts, and cli/commands/log.ts. No new Phase 1 compliance issues found. Test suite: `284 passed`, `0 failed`, `11 skipped` (tmux-backed). Typecheck passed. Alignment scan implementation status independently confirmed. The 15 remaining findings are deeper wiring/behavioral gaps that the alignment scan did not target or did not fully resolve.

**Iteration 14 refresh (2026-05-26, full Phase 1 compliance re-audit — separate auditor session):** Fourth independent full Phase 1 compliance re-audit by a separate auditor session against HEAD `297fb42`. Re-verified all 15 current P1-FULL findings remain unfixed through targeted `rg` searches and full/partial source reads of daemon/index.ts, server.ts, loop-manager.ts, rehydration.ts, switcher.ts, session/manager.ts, attach.ts, statusline/store.ts, slack/service.ts, and tmux.ts. No new Phase 1 compliance issues found. Test suite: `284 passed`, `0 failed`, `11 skipped` (tmux-backed). Typecheck passed. Alignment scan implementation status independently confirmed: switch_tx persistence, `buildResumeCommand`, `restartInPlace()`, attach `-L aisup` socket, output log rotation, doctor statusline/model/cost, offline status, Slack output relay, live 429 scanning, skill detection, `--json` status, `/api/events`, `--force` stop, Slack lifecycle wiring, circuit breaker construction, runner validation, daemon readiness — all correctly implemented. The 15 remaining findings are deeper wiring/behavioral gaps that the alignment scan did not target or did not fully resolve.

**Iteration 13 refresh (2026-05-26, independent full Phase 1 compliance re-audit):** Independent fresh re-audit of all Phase 1 tasks (1–14) against HEAD `297fb42` by a separate auditor session. Re-verified all 15 current P1-FULL findings remain unfixed through targeted `rg` searches and source reads. No new Phase 1 compliance issues found. Test suite: `284 passed`, `0 failed`, `11 skipped` (tmux-backed). Typecheck passed. Alignment scan implementation status independently confirmed: switch_tx persistence (6 `persistTx()` call sites), `buildResumeCommand` (3 daemon/server call sites), `restartInPlace()`, attach `-L aisup` socket, output log rotation, doctor statusline/model/cost, offline status, Slack output relay, live 429 scanning, skill detection, `--json` status, `/api/events`, `--force` stop, Slack lifecycle wiring, circuit breaker construction, runner validation, daemon readiness — all correctly implemented. The 15 remaining findings are deeper wiring/behavioral gaps that the alignment scan did not target or did not fully resolve.

**Iteration 12 refresh (2026-05-26, full Phase 1 compliance re-audit):** Re-audited all Phase 1 tasks (1–14) against HEAD `297fb42` plus dirty docs worktree. Verified all 15 current P1-FULL findings remain unfixed. Corrected summary table arithmetic: HIGH count 10→8, total 17→15 to match actual finding severities. Test suite: `284 passed`, `0 failed`, `11 skipped` (tmux-backed). Typecheck passed. No new Phase 1 compliance issues found. Many alignment scan items ARE implemented (switch_tx persistence, resume support, restartInPlace, attach socket, output rotation, doctor diagnostics, offline status, output relay, live 429 scanning, skill detection, `--json` status, `/api/events`, `--force` stop), but the 15 remaining findings represent deeper wiring/behavioral gaps.

**Iteration 11 refresh (2026-05-26):** Re-read the current plan, existing review, and current source boundaries on HEAD `297fb42`. No new material findings were found; all 5 CRITICAL and 14 HIGH Phase 2 findings remain valid. Verification passed with `npm run typecheck`, focused daemon/config/Slack tests, and the full Vitest suite (`273 passed`, `11 skipped` tmux-backed tests due sandbox tmux socket permission).

## Findings

### CRITICAL

#### CR-001: PHANTOM GAP — Pipe-pane restore already exists in rehydration

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 2 lists "restore pipe-pane via `startOutputLog()`" as new functionality to be implemented. This already exists in the codebase and is fully functional.

**Example:**
`src/daemon/rehydration.ts:183-193`:
```typescript
if (!isPipePaneActive(tmuxSocket, state.tmux_name)) {
  try {
    startOutputLog(tmuxSocket, state.tmux_name, state.output_log_path);
    await journal.append({ ... event_type: 'output_log.cursor_reset' ... });
  } catch { /* non-fatal */ }
}
```
This fires for every ACTIVE/SWITCH_PENDING_AT_IDLE session with a live tmux pane when the daemon restarts. Pipe-pane restore is complete.

**Optimal Fix:**
Remove "(c) restore pipe-pane via `startOutputLog()`" from Task 2's "What's new" section. Move it to "What already exists" with a note: "Pipe-pane restore on daemon restart (rehydration.ts:183-193) — no changes needed." Reduce Task 2 scope to only genuinely new functionality.

**Why This Fix:**
Re-implementing existing working code wastes implementation time, risks breaking the existing implementation, and adds test maintenance burden for duplicate coverage.

**Fix Validated:** YES — Read `src/daemon/rehydration.ts` in full. Lines 183-193 perform the exact pipe-pane restore described by the plan. The existing test `tests/daemon/rehydration.test.ts` covers this path.

**Validation Command:**
`grep -n 'startOutputLog\|isPipePaneActive' src/daemon/rehydration.ts`

**Test Changes:** None — existing tests in `tests/daemon/rehydration.test.ts` cover this.

**Affected Tasks:** Task 2

---

#### CR-002: PHANTOM GAP — Switch-tx recovery is NOT detection-only

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 2 states: "What already exists (detection-only): All detection + journal logging, no corrective action." This is false. The existing `recoverSwitchTx()` function already takes corrective actions for 3 of 6 switch phases.

**Example:**
`src/daemon/rehydration.ts` already performs corrective recovery:
- `snapshot` phase (line 49-57): Clears `switch_tx`, sets session ACTIVE → **corrective**
- `stopping` with source alive (line 62-68): Clears `switch_tx`, sets session ACTIVE → **corrective**
- `stopping` with source dead (line 69-77): Advances phase to `source_destroyed`, destroys stale source tmux → **partially corrective** (advances state, but still logs `needs_manual_failover`)
- `resuming` with target alive (line 96-111): Sets session ACTIVE on target account → **corrective**

Only these phases are genuinely detection-only:
- `source_destroyed` (line 80-85): Logs `needs_manual_failover`
- `migrating`/`creating` with dead target (line 112-114): Logs `needs_manual_failover`

**Optimal Fix:**
Rewrite Task 2's "What already exists" section to accurately describe current state:
```
- Switch-tx recovery for `snapshot`, `stopping` (source alive), and `resuming` (target alive) phases
  — already corrective, sets session ACTIVE
- `stopping` (source dead) — partially corrective: advances to source_destroyed, destroys stale tmux
- `source_destroyed`, `migrating`, `creating` (target dead) — detection-only, logs needs_manual_failover
- Pipe-pane restore — already corrective (see CR-001)
- State-without-tmux detection — detection-only, logs session.destroyed_externally
```

Scope Task 2's "What's new" to ONLY:
1. Complete the switch for `source_destroyed`/`migrating`/`creating` by invoking `onSwitch` callback
2. Restart state-without-tmux sessions via `restartInPlace()`
3. Optionally destroy orphan tmux sessions

**Why This Fix:**
Mischaracterizing existing code causes the implementer to either: (a) rewrite working code, introducing regressions, or (b) get confused when they read the actual source and find it already does most of what's listed as "new."

**Fix Validated:** YES — Read `src/daemon/rehydration.ts` in full (225 lines). Each switch phase has explicit corrective action or detection-only logging, clearly distinguishable.

**Validation Command:**
`grep -n 'recovery.success\|recovery.failed\|needs_manual_failover' src/daemon/rehydration.ts`

**Test Changes:** None — Task 2 test scope should shrink (fewer new behaviors to test).

**Affected Tasks:** Task 2

---

#### CR-003: Task 12 gate trigger logic is broken — `active_skill` never transitions to null

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 12 defines gate trigger condition: "A 'skill completion' = `previousSkill` was a tracked skill (non-null) AND `session.active_skill` is now null." This condition will NEVER fire because `active_skill` is never cleared to null during normal operation.

**Example:**
`src/daemon/loop-manager.ts:268-277` — skill detection in `recoveryTick()`:
```typescript
const detectedSkill = detectSkill(output, d.trackedSkills ?? []);
if (detectedSkill && detectedSkill !== session.active_skill) {
  d.sessionManager.patchState(session.aisup_session_id, { active_skill: detectedSkill });
  // ... journal event
}
```

`active_skill` is only updated when `detectedSkill` is truthy (non-null). When `detectSkill()` returns null (no skill pattern in recent output), `active_skill` retains its last value indefinitely. There is no code path that sets `active_skill` to null during normal session operation.

The `SkillTracker` class (`src/skills/tracker.ts:24-26`) has a `reset()` method that clears state, but it's not used anywhere in the loop manager — the loop manager calls `detectSkill()` directly.

**Optimal Fix:**
Redesign the gate trigger condition. Two viable approaches:

**Option A — Idle + non-null skill (simpler, recommended):**
Gate trigger fires when: (1) session is idle for `idle_delay_seconds`, AND (2) `session.active_skill` is non-null. After gate runs, clear `active_skill` via `patchState` to prevent re-triggering. This doesn't require detecting the *transition* — just the state of "was working on a skill, now idle."

**Option B — Explicit skill completion detection:**
Add skill completion detection to `recoveryTick()`. When `detectSkill()` returns null for N consecutive ticks AND `active_skill` is non-null, consider the skill "completed" and clear `active_skill`. Then the existing transition logic works.

Option A is recommended — simpler, fewer moving parts, same end result. The debounce already prevents re-triggering.

**Why This Fix:**
Without this fix, the entire validation gate feature (H₁) is non-functional. Gates would never trigger automatically, defeating the purpose of the feature.

**Fix Validated:** YES — Traced `active_skill` through all code paths in `loop-manager.ts`, `session/manager.ts`, and `session/types.ts`. Confirmed: `active_skill` is `string | null` in `SessionState`, only `patchState()` in `recoveryTick()` modifies it (when detected), and `restartInPlace()`/session creation don't clear it. No path sets it to null post-creation except explicit `patchState` calls.

**Validation Command:**
`grep -rn 'active_skill' src/` — shows all places this field is read/written.

**Test Changes:** Task 12 tests need to reflect the actual trigger mechanism chosen.

**Affected Tasks:** Task 12

---

#### CR-004: [NEW iter 3, AMENDED iter 4] Task 12 — `onIdle` callback and gate trigger design gap

**Status:** AMENDED — Iteration 4 discovered that `onIdle` does NOT actually stop the session (see amendment below). The design gap remains CRITICAL but the nature of the conflict is different from what iteration 3 described.

**Description:**
Task 12 proposes adding gate trigger logic to `idleTick()` so that idle + skill completion triggers gates. The existing `onIdle` callback in `daemon/index.ts:149-156` emits a `session.stop` journal event:
```typescript
onIdle: (sessionId) => {
  void journal.append({
    ts: new Date().toISOString(),
    event_type: 'session.stop',
    aisup_session_id: sessionId,
    details: { reason: 'idle_timeout' },
  });
},
```

**Iteration 4 Amendment — `onIdle` does NOT stop the session:**
The `onIdle` callback ONLY calls `journal.append()`. It does NOT call `sessionManager.stopSession()`, `sessionManager.patchState()`, or any other lifecycle method. The session continues running after `onIdle` fires. This means:
1. ~~"The session may have already been stopped by onIdle"~~ — **WRONG.** The session is never stopped by idle detection.
2. The `session.stop` journal event at idle is **misleading** — it records a stop that didn't happen. The session status remains ACTIVE in the state file.
3. There is **no functional conflict** between idle-as-stop and idle-as-gate-trigger, because idle doesn't stop anything.
4. **However**, the design gap remains: `idleTick()` fires `onIdle` on EVERY tick where the session is idle (not just the first time), and the plan needs to specify how gate triggers interact with this repeating callback.

**Example:**
`src/daemon/loop-manager.ts:227-233`:
```typescript
private idleTick(d: LoopManagerDeps): void {
  const session = d.sessionManager.getActiveSession();
  if (!session) return;
  if (isSessionIdle(session.output_log_path, d.idleBoundarySeconds)) {
    this.onIdle(session.aisup_session_id);
  }
}
```

`onIdle` fires on EVERY idle tick (every `idle_interval_s` seconds while idle), not just once. Without debounce, gate triggers would fire repeatedly. The plan's debounce logic (Task 12: `lastGateRun` map, 60s cooldown) addresses this, but doesn't address the `onIdle` callback also firing repeatedly with misleading `session.stop` events.

**Optimal Fix (revised):**
The plan must address three things:

1. **Fix the misleading `session.stop` event.** Either: (a) rename it to `session.idle_detected` (it's observability, not a lifecycle event), or (b) actually stop the session by adding `sessionManager.stopSession()` to `onIdle`. Option (a) is recommended — idle detection should be informational, and explicit session stop should be a separate action.

2. **Add gate trigger to `idleTick()`.** Since `onIdle` doesn't stop the session, gate triggers can be added alongside it. In `idleTick()`: if gates enabled AND `active_skill` is non-null → call `onGateTrigger`. The debounce (`lastGateRun` map) prevents re-triggering. This is simpler than the iteration 3 recommendation because there's no stop/gate conflict to resolve.

3. **Clarify idle-tick firing frequency.** `onIdle` fires every tick. Gate triggers fire at most once per 60s (debounce). But `session.stop` (or `session.idle_detected`) also fires every tick — this creates journal spam. Add a `lastIdleEmit` timestamp to skip redundant idle events.

**Why This Fix:**
Without clarifying that `onIdle` doesn't stop sessions, the implementer will either: (a) assume it does and build complex gate-before-stop logic that isn't needed, or (b) discover it doesn't and be confused about the `session.stop` event. Either wastes time.

**Fix Validated:** YES — Read `onIdle` at daemon/index.ts:149-156. Only `journal.append()` is called. No session lifecycle calls. Verified `session.stop` event type is emitted but session state file is not modified. `idleTick()` at loop-manager.ts:227-233 calls `onIdle` unconditionally on every tick while idle — no once-only guard.

**Validation Command:**
`grep -n 'stopSession\|patchState\|writeState' src/daemon/index.ts` — `onIdle` handler (lines 149-156) contains none of these.

**Test Changes:** Task 12 tests need to cover: gate trigger on idle + active_skill, debounce preventing re-trigger, no gate trigger when active_skill is null, idle event not spammed on every tick.

**Affected Tasks:** Task 12

---

#### CR-005: [SUPERSEDED iter 17] Task 7 — EXHAUSTED state NOT persisted to disk

**Status:** SUPERSEDED by CR-006. This historical finding is no longer counted as active.

**Original Issue:**
Iteration 3 claimed that when `performSwitch()` returns `status: 'exhausted'`, the daemon only updates in-memory Fastify status via `server.setSessionState()` and never persists `EXHAUSTED` to disk.

**Current Evidence:**
The current code contradicts that original claim. `src/failover/switcher.ts:311-327` emits `session.exhausted` and calls:

```typescript
sessionManager.patchState(snapshot.aisupSessionId, {
  status: 'EXHAUSTED',
  switch_tx: null,
});
```

`tests/failover/switcher.test.ts:173-209` covers the all-targets-fail path and expects the final patch to include `{ status: 'EXHAUSTED', switch_tx: null }`.

**Remaining Risk:**
The underlying restart durability concern still exists, but for a different reason: Task 7 does not specify how daemon startup re-arms `ExhaustedRecovery` for already-persisted `EXHAUSTED` sessions. That active blocker is tracked as CR-006.

**Why Superseded:**
Keeping CR-005 active would direct implementers to add duplicate persistence and duplicate `session.exhausted` emission around a path that `performSwitch()` already handles. The smallest correct review update is to retire this finding and replace it with the actual restart/re-arm gap.

**Validation Command:**
`rg -n "status: 'EXHAUSTED'|session\\.exhausted|patchState\\(snapshot\\.aisupSessionId" src/failover/switcher.ts tests/failover/switcher.test.ts`

**Affected Tasks:** Task 7

---

#### CR-006: [NEW iter 17] Task 7 — EXHAUSTED polling is not re-armed from persisted state after daemon restart

**Evidence:**
- Task 7 starts `ExhaustedRecovery` only in the live `performSwitch()` return path: "In `src/daemon/index.ts`, when `performSwitch` returns `status: 'exhausted'` and `config.recovery.auto_resume_exhausted` is true, start `ExhaustedRecovery`" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:500`).
- `performSwitch()` does persist exhausted state and clear `switch_tx` (`src/failover/switcher.ts:311-327`), so a daemon restart can see a durable `EXHAUSTED` session file.
- `rehydrateSessions()` has branches for `SWITCHING`, `CREATING`, `STOPPING`, `ACTIVE`, `SWITCH_PENDING_AT_IDLE`, and `STOPPED`, but no `EXHAUSTED` branch (`src/daemon/rehydration.ts:151-207`).
- `SessionManager.getActiveSession()` returns only `ACTIVE` and `SWITCH_PENDING_AT_IDLE` (`src/session/manager.ts:267-279`), so an exhausted session will not be found by normal loop ticks after restart.
- The Phase 1 plan requires daemon startup to reconcile persisted state and preserve/recover `EXHAUSTED` sessions rather than relying on arm-time snapshots (`docs/plans/2026-04-29-aisup-supervisor-daemon.md:1019-1020`).

**Issue:**
The plan covers starting the exhausted poller when the same daemon instance enters `EXHAUSTED`, but not when the daemon starts with an already-persisted `EXHAUSTED` session. After a restart during cooldown, no code path described by the plan discovers that persisted session and calls `ExhaustedRecovery.start(sessionId)`.

**Impact:**
`auto_resume_exhausted: true` becomes non-durable. A daemon restart during a long cooldown leaves the logical session blocked in persisted `EXHAUSTED` state with no polling, no eventual auto-resume, and potentially stale `/api/status` visibility. This violates the Phase 2 goal of automatic EXHAUSTED recovery and the project rule that long-running monitoring must rehydrate from durable supervisor state.

**Optimal Fix:**
Update Task 7 and Task 2 to add a startup re-arm path for persisted `EXHAUSTED` sessions. The smallest plan-level correction:

1. Add an `EXHAUSTED` branch to `rehydrateSessions()` or add a daemon-startup pass immediately after rehydration that scans persisted session state.
2. For each persisted `EXHAUSTED` session, call `server.setSessionState({ status: 'EXHAUSTED', aisup_session_id, hasTmux: false })`.
3. If `config.recovery.auto_resume_exhausted` is true, call `ExhaustedRecovery.start(sessionId)`; if false, emit/notify the manual recovery state without starting polling.
4. Add deterministic tests for daemon restart with a persisted `EXHAUSTED` state: rehydrates API visibility, starts polling when enabled, does not start polling when disabled, and does not rely on `getActiveSession()`.

**Why This Fix:**
It uses the existing persisted session state as the canonical lifecycle source and avoids adding a hidden in-memory status channel. It also keeps `EXHAUSTED` out of the normal active-session loops, which is consistent with the current state-machine split.

**Fix Validated:**
YES — Read `performSwitch()` persistence in `src/failover/switcher.ts:311-327`, `rehydrateSessions()` status handling in `src/daemon/rehydration.ts:151-207`, `getActiveSession()` in `src/session/manager.ts:267-279`, and Task 7 integration text in the plan. The proposed fix is implementable without changing the canonical event contract or adding a second state machine.

**Validation Command:**
`rg -n "EXHAUSTED|rehydrateSessions|getActiveSession|status: 'EXHAUSTED'|session\\.exhausted" src/daemon/rehydration.ts src/session/manager.ts src/failover/switcher.ts src/daemon/index.ts`

**Affected Tasks:** Task 7, Task 2

---

### HIGH

#### HI-001: Missing `src/config/defaults.ts` in Tasks 7, 9, 11

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Tasks 7, 9, and 11 each add new config sections (`RecoveryConfig`, `PermissionsConfig`, `GatesConfig`) to `AisupConfig` in `schema.ts`. They list modifying `schema.ts` and `loader.ts` but NOT `defaults.ts`. The `CONFIG_DEFAULTS` object is typed as `Omit<AisupConfig, 'accounts'>` — adding new required sections to `AisupConfig` without updating `CONFIG_DEFAULTS` causes a TypeScript compilation error immediately.

**Example:**
`src/config/defaults.ts:3`:
```typescript
export const CONFIG_DEFAULTS: Omit<AisupConfig, 'accounts'> = {
  runner: { ... },
  thresholds: { ... },
  // ... NO recovery, permissions, or gates sections
};
```

Adding `recovery: RecoveryConfig` to `AisupConfig` without adding `recovery: { ... }` to `CONFIG_DEFAULTS` → `Type '{ runner: ...; }' is missing the following properties from type 'Omit<AisupConfig, "accounts">': recovery, permissions, gates`.

**Optimal Fix:**
Add `src/config/defaults.ts` (modify) to the Files sections of Tasks 7, 9, and 11. Each task should add its defaults:
- Task 7: `recovery: { auto_resume_exhausted: true, exhausted_poll_interval_s: 60, network_error_threshold: 3 }`
- Task 9: `permissions: { enabled: false, detection_patterns: [], policy: { allowlist: [], denylist: [], default_action: 'deny' }, slack_routing: false, grant_ttl_seconds: 300 }`
- Task 11: `gates: { enabled: false, gates: [], trigger: 'idle_and_skill', idle_delay_seconds: 30 }`

**Why This Fix:**
Without defaults, the project won't compile after any of these tasks. `mergeDeep()` in `loader.ts` also uses `CONFIG_DEFAULTS` as the merge base — without defaults for new sections, user configs that omit the new sections will have `undefined` at runtime instead of safe defaults.

**Fix Validated:** YES — Confirmed `CONFIG_DEFAULTS` is typed `Omit<AisupConfig, 'accounts'>`. TypeScript will error if AisupConfig has a key that CONFIG_DEFAULTS doesn't.

**Validation Command:**
`npx tsc --noEmit` — will fail after adding to schema.ts without updating defaults.ts.

**Test Changes:** `tests/config/loader.test.ts` may need cases for new default sections.

**Affected Tasks:** Task 7, Task 9, Task 11

---

#### HI-002: Missing `src/failover/types.ts` in Task 6 Files section

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 6 Key Decisions states: "Add `AuthFailure` and `NetworkError` to `SwitchReason` enum in `src/failover/types.ts`." But the Files section only lists `src/recovery/patterns.ts` (create), `tests/recovery/patterns.test.ts` (create), `src/daemon/loop-manager.ts` (modify), `src/journal/types.ts` (modify). The file that needs the enum change is not listed.

**Example:**
Current `SwitchReason` enum in `src/failover/types.ts:1-10`:
```typescript
export enum SwitchReason {
  SoftThreshold = 'soft_threshold',
  HardThreshold = 'hard_threshold',
  RateLimit429 = '429',
  ProcessCrash = 'process_crash',
  RestartFailures = 'restart_failures',
  CircuitBreaker = 'circuit_breaker',
  Manual = 'manual',
  SourceDead = 'source_dead',
}
```
Missing: `AuthFailure = 'auth_failure'`, `NetworkError = 'network_error'`.

**Optimal Fix:**
Add `src/failover/types.ts` (modify) to Task 6's Files section with note: "Add `AuthFailure = 'auth_failure'` and `NetworkError = 'network_error'` to `SwitchReason` enum."

**Why This Fix:**
Zero-context implementer reads the Files section to know which files to touch. Missing files lead to incomplete implementations that fail at compile time when the new enum values are referenced.

**Fix Validated:** YES — Confirmed enum exists at the stated location and lacks these values.

**Validation Command:**
`grep -n 'AuthFailure\|NetworkError' src/failover/types.ts` — should match after implementation.

**Test Changes:** None beyond what Task 6 already specifies.

**Affected Tasks:** Task 6

---

#### HI-003: Missing `src/daemon/index.ts` in Task 3 Files section

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 3 Key Decisions states: "Session lifecycle snapshots: Also emit on session stop and account switch (in `onSwitch`/`onSessionStop` callbacks in `src/daemon/index.ts`)." But the Files section only lists `src/daemon/loop-manager.ts` (modify), `src/journal/types.ts` (modify), `tests/daemon/loops/loop-manager.test.ts` (modify). The lifecycle snapshot wiring location is not listed.

**Example:**
The cost snapshot on session stop should be emitted in `daemon/index.ts`:
```typescript
onSessionStop: (session) => slackService?.onSessionStop(session.aisup_session_id),
```
This needs to also emit a final cost snapshot. Similarly, `onSwitch` at line 172 needs a cost snapshot before switching.

**Optimal Fix:**
Add `src/daemon/index.ts` (modify) to Task 3's Files section with note: "Add final cost snapshot emission in `onSessionStop` and `onSwitch` callbacks."

**Why This Fix:**
Without lifecycle snapshots, the last cost reading before a session stop or account switch is lost. Aggregation in Task 4 would undercount costs for sessions that ended between rate-limit ticks.

**Fix Validated:** YES — Confirmed `onSessionStop` and `onSwitch` callbacks in daemon/index.ts. Both are wiring points where a final `cost.snapshot` event should be emitted.

**Validation Command:**
`grep -n 'onSessionStop\|onSwitch' src/daemon/index.ts`

**Test Changes:** Tests for lifecycle snapshots should be in a daemon/index integration test or the loop-manager test with mock deps.

**Affected Tasks:** Task 3

---

#### HI-004: Task 2 recovery via `onSwitch`/`onRestart` — architectural gap

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 2 says to "resume interrupted switch-tx via daemon's `onSwitch` callback" for the `source_destroyed`/`migrating`/`creating` phases. But `rehydrateSessions()` runs BEFORE `loopManager.startAll()` (daemon/index.ts:93 vs 289), and `RehydrationDeps` doesn't include `onSwitch` or `onRestart` callbacks. The rehydration function has no way to invoke these callbacks.

**Example:**
`src/daemon/rehydration.ts:12-18` — current `RehydrationDeps`:
```typescript
export interface RehydrationDeps {
  stateDir: string;
  tmuxSocket: string;
  liveSessions: Set<string>;
  setSessionState: (session: SessionInfo) => void;
  journal: JournalWriter;
}
```
Missing: `onSwitch`, `onRestart`, `accountRegistry`, `config`, `runner`.

`daemon/index.ts:93-99` — rehydration runs before loop manager exists:
```typescript
await rehydrateSessions({ stateDir, tmuxSocket, liveSessions, setSessionState, journal });
// ... 190 lines later ...
const loopManager = new LoopManager({ ... });
```

**Optimal Fix:**
Two approaches:

**Option A (recommended) — Extend RehydrationDeps:**
Add `onSwitch` and `onRestart` to `RehydrationDeps`. Move the `onSwitch` and `onRestart` callback implementations out of the LoopManager deps object into standalone functions in daemon/index.ts, then pass them to both rehydration and LoopManager.

**Option B — Deferred recovery:**
Keep rehydration detection-only for complex phases. After loop manager starts, run a "deferred recovery" pass that picks up any sessions still in `needs_manual_failover` state and invokes the switch.

Option A is cleaner — the switch logic is already in daemon/index.ts, just extract it.

**Why This Fix:**
Without this, the "resume interrupted switch" functionality described in Task 2 is architecturally impossible to implement as written. The implementer will hit this wall and need to restructure.

**Fix Validated:** YES — Read both files. RehydrationDeps has no access to switch/restart logic. The switch logic is inline in daemon/index.ts:172-243.

**Validation Command:**
`grep -n 'onSwitch\|onRestart' src/daemon/rehydration.ts` — should show 0 matches currently.

**Test Changes:** `tests/daemon/rehydration.test.ts` needs to mock `onSwitch`/`onRestart` callbacks.

**Affected Tasks:** Task 2

---

#### HI-005: Task 11 — `execFile` with command strings containing spaces will fail

**Status:** CONFIRMED (unchanged from iteration 1; see also HI-012 for AGENTS.md rule #8 tension)

**Description:**
Task 11 specifies using `child_process.execFile` to run gate commands, but the config example shows `command: "npx tsc --noEmit"`. `execFile` does NOT parse command strings — it treats the entire first argument as an executable file path. `execFile("npx tsc --noEmit", [])` will fail with ENOENT because there's no file literally named "npx tsc --noEmit".

**Example:**
Plan config:
```typescript
gates: Array<{
  command: string;  // e.g., "npx tsc --noEmit"
  args: string[];   // additional args
}>
```
Plan execution:
> "Runs each gate sequentially via `child_process.execFile`"

This is incompatible — `execFile` requires the first arg to be ONLY the executable name.

**Optimal Fix:**
Resolve this through HI-012's shell-free design: change the gate config so `command` is the executable only and `args` contains every argument, then execute with `execFile(gate.command, gate.args, ...)`.

```typescript
gates: [
  { name: 'typecheck', command: 'npx', args: ['tsc', '--noEmit'], ... }
]
```

If the project intentionally wants shell command strings instead, Task 11 must explicitly document the shell boundary and add tests for it, but that is the less-preferred path because AGENTS.md rule 8 requires shell-free subprocess execution by default.

**Why This Fix:**
As written, every gate execution using `execFile("npx tsc --noEmit", [])` will throw ENOENT at runtime. Splitting executable and arguments fixes that failure while staying aligned with the repository's existing runner config pattern and shell-free subprocess rule.

**Fix Validated:** YES — Node.js docs confirm `execFile` does not spawn a shell and does not parse command strings.

**Validation Command:**
N/A — this is a design-time fix.

**Test Changes:** Gate engine tests must use the corrected execution method.

**Affected Tasks:** Task 11, Task 12

---

#### HI-006: `validateConfig` return statement explicitly lists properties — new sections will be silently dropped

**Status:** CONFIRMED (from iteration 2)

**Description:**
The `validateConfig` function in `src/config/loader.ts:153-165` explicitly lists every property in its return object:
```typescript
return {
    accounts,
    runner: merged.runner,
    thresholds: merged.thresholds,
    failover: merged.failover,
    skills: merged.skills,
    monitoring: merged.monitoring,
    session: merged.session,
    slack: merged.slack,
    daemon: merged.daemon,
    statusline: { ...merged.statusline, directory: statuslineDirectory },
    journal: { path: journalPath },
  };
```

This is a **manual property list**, not a spread. Even if `mergeDeep` correctly merges new config sections from defaults + user config, the return statement discards any property not explicitly listed. Adding `recovery`, `permissions`, or `gates` to `AisupConfig` and `CONFIG_DEFAULTS` without ALSO adding them to this return statement means: TypeScript will error (return type doesn't match `AisupConfig`), or if cast, the new sections are silently dropped at runtime.

This is **separate from HI-001** (which covers `defaults.ts`). The plan mentions modifying `loader.ts` for "validation" but never mentions the return statement. Three places must be updated in lockstep: `schema.ts`, `defaults.ts`, AND `loader.ts` return.

**Optimal Fix:**
Add explicit instruction to Tasks 7, 9, and 11: "In `src/config/loader.ts`, add the new section to the `validateConfig` return statement (line 153-165). Example for Task 7: add `recovery: merged.recovery,` to the return object."

Alternatively, refactor the return to use spread: `return { ...merged, accounts, statusline: { ...merged.statusline, directory: statuslineDirectory }, journal: { path: journalPath } };` — this automatically includes new sections. But this is a bigger change and could mask validation issues.

**Why This Fix:**
Without this, new config sections exist in `AisupConfig` and `CONFIG_DEFAULTS` but are dropped by `validateConfig`. TypeScript catches this (return type mismatch), so the project won't compile — but the error message will be confusing ("missing property 'recovery'") and the implementer won't know where to look unless the plan says so.

**Fix Validated:** YES — Read `src/config/loader.ts:153-165`. The return is an explicit property list, not a spread of `merged`. Adding `recovery: merged.recovery` to the return is the correct fix pattern.

**Validation Command:**
`npx tsc --noEmit` — will fail if new sections are in schema but not in the return.

**Test Changes:** None — TypeScript catches this.

**Affected Tasks:** Task 7, Task 9, Task 11

---

#### HI-007: Task 4 cost aggregation has no dependency on `src/journal/reader.ts` and doesn't specify how it reads events

**Status:** CONFIRMED (from iteration 2)

**Description:**
Task 4 creates `src/cost/aggregator.ts` and describes reading `cost.snapshot` events from the journal, but:
1. The Files section lists only `src/cost/aggregator.ts` (create) and `tests/cost/aggregator.test.ts` (create) — no dependency on journal reader
2. The Key Decisions describe the interface (`aggregateCosts(journalPath, options)`) but never mention how events are actually read
3. `readEvents()` in `src/journal/reader.ts` already exists and supports filtering by `type` and `since` — this is the obvious tool, but the plan doesn't reference it

A zero-context implementer might reimplement JSONL parsing instead of reusing `readEvents()`.

**Optimal Fix:**
Add to Task 4 Key Decisions: "Uses `readEvents()` from `src/journal/reader.ts` to read `cost.snapshot` events. The `ReadEventsOptions.type` field accepts `EventType | string`, so filtering by `'cost.snapshot'` works even before the type is added to the `EventType` union (Task 3 adds it). Import pattern: `import { readEvents } from '../journal/reader.js';`"

**Why This Fix:**
Without this, the implementer either: (a) re-implements JSONL parsing (DRY violation, inconsistent behavior), or (b) wastes time discovering `readEvents()` exists. The plan should point to existing infrastructure.

**Fix Validated:** YES — Read `src/journal/reader.ts`. `readEvents()` accepts `ReadEventsOptions` with `type?: EventType | string`, `since?: string`, `limit?: number`. Exactly what the aggregator needs.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 4

---

#### HI-008: [NEW] Task 6 — `recoveryTick` only processes ACTIVE and SWITCH_PENDING_AT_IDLE sessions; plan doesn't mention this constraint

**Description:**
Task 6 integrates auth/network failure detection into `recoveryTick()`. But `recoveryTick()` starts with:
```typescript
private async recoveryTick(d: LoopManagerDeps): Promise<void> {
  const session = d.sessionManager.getActiveSession();
  if (!session) return;
  if (session.status !== 'ACTIVE' && session.status !== 'SWITCH_PENDING_AT_IDLE') return;
```

`getActiveSession()` (session/manager.ts:267-279) only returns sessions with status `ACTIVE` or `SWITCH_PENDING_AT_IDLE`. This means:
- EXHAUSTED sessions: auth/network failures won't be detected (no output scanning)
- SWITCHING sessions: no scanning (correct — already switching)
- CREATING sessions: no scanning (acceptable — session just starting)
- STOPPING sessions: no scanning (acceptable — session ending)

The plan's Task 6 Key Decisions say: "Integration into `recoveryTick()`: After the existing 429 check..." — this is correct and workable. But the plan doesn't document the status filter constraint. If the implementer doesn't understand this, they might expect auth failure detection to work for EXHAUSTED sessions too.

More importantly: when EXHAUSTED auto-recovery (Task 7) resumes a session and it immediately hits auth failure, the session transitions from EXHAUSTED → ACTIVE → auth failure detected → account switch. This is correct behavior BUT should be explicitly documented so the implementer doesn't add redundant EXHAUSTED auth checking.

**Optimal Fix:**
Add to Task 6 Key Decisions: "Note: `recoveryTick()` only processes ACTIVE and SWITCH_PENDING_AT_IDLE sessions (loop-manager.ts:239-240). Auth/network failure detection will NOT fire for EXHAUSTED, SWITCHING, CREATING, or STOPPING sessions. This is correct — auth failures are only detectable when the session has active output. After EXHAUSTED auto-recovery (Task 7), the resumed session becomes ACTIVE and will then be scanned normally."

**Why This Fix:**
Without this, the implementer may waste time trying to add auth detection to EXHAUSTED sessions, or file a false bug report when auth detection "doesn't work" for non-ACTIVE sessions.

**Fix Validated:** YES — Read `recoveryTick()` at loop-manager.ts:235-240. Status filter confirmed. Read `getActiveSession()` at session/manager.ts:267-279. Only ACTIVE/SWITCH_PENDING_AT_IDLE returned.

**Validation Command:** N/A

**Test Changes:** None — this is a documentation clarification.

**Affected Tasks:** Task 6

---

#### HI-009: [NEW] Task 7 — `CBState` type is not exported from circuit-breaker.ts; ExhaustedRecovery cannot type-check state comparisons

**Description:**
Task 7's `ExhaustedRecovery` needs to call `circuitBreaker.getState(account)` and compare the result to `'HALF_OPEN'` or `'CLOSED'`. The return type of `getState()` is `CBState`, which is defined at `src/accounts/circuit-breaker.ts:3`:
```typescript
type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
```

This type is NOT exported (no `export` keyword). In strict TypeScript, `ExhaustedRecovery` in `src/recovery/exhausted.ts` cannot import `CBState` to properly type its state comparisons. It can use string literal comparisons (`=== 'HALF_OPEN'`), but the type won't be available for function signatures or intermediate variables.

**Optimal Fix:**
Add `export` to the `CBState` type in `src/accounts/circuit-breaker.ts:3`:
```typescript
export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
```

Add `src/accounts/circuit-breaker.ts` (modify) to Task 7 Files section with note: "Export `CBState` type for use by `ExhaustedRecovery`."

**Why This Fix:**
Without the export, the implementer either: (a) duplicates the type literal in the recovery module (fragile — type changes in one place but not the other), or (b) uses `string` type (loses type safety), or (c) uses `ReturnType<typeof circuitBreaker.getState>` (awkward).

**Fix Validated:** YES — Confirmed `type CBState = ...` at line 3 without `export`. `getState()` at line 67 returns `CBState`. Any consumer outside the file cannot reference this type.

**Validation Command:**
`grep -n 'export.*CBState\|type CBState' src/accounts/circuit-breaker.ts`

**Test Changes:** None.

**Affected Tasks:** Task 7

---

#### HI-010: [NEW] Task 10 — `!permit`/`!deny` need `case` handlers in `dispatchCommand()`, not just KNOWN_COMMANDS entries

**Description:**
Task 10 says: "Add `'permit'` and `'deny'` to `KNOWN_COMMANDS` in `src/slack/commands.ts`." Adding to `KNOWN_COMMANDS` makes `parseCommand('!permit')` return `{name: 'permit', args: ''}` instead of `{name: 'unknown', args: ''}`. But this is only half the routing chain.

The Slack message handling flow is:
1. `handleMessage()` calls `parseCommand(text)` — returns `{name, args}` if `!`-prefixed and name is in KNOWN_COMMANDS
2. If `cmd.name !== 'unknown'`, calls `this.dispatchCommand(cmd.name, cmd.args, ...)` (service.ts:198)
3. `dispatchCommand()` has a `switch (name)` at service.ts:211 with cases: `interrupt`, `stop`, `confirm`, `status`, `cmd`, `relay`, `help`
4. Any unmatched name hits `default:` which sends "Unknown command: {name}" to Slack

Without `case 'permit':` and `case 'deny':` in `dispatchCommand()`, the commands are recognized by `parseCommand` but immediately hit the default "Unknown command" response. The feature is completely non-functional.

Note: `failover` has the same bug — it's in `KNOWN_COMMANDS` (commands.ts:1) but has no `case` in `dispatchCommand()`. This is a pre-existing issue, not introduced by this plan.

**Example:**
```typescript
// commands.ts:1 — KNOWN_COMMANDS recognition
const KNOWN_COMMANDS = new Set(['interrupt', 'stop', 'status', 'cmd', 'relay', 'help', 'confirm', 'failover']);

// service.ts:211-298 — dispatchCommand routing
switch (name) {
  case 'interrupt': { ... }
  case 'stop': { ... }
  case 'confirm': { ... }
  case 'status': { ... }
  case 'cmd': { ... }
  case 'relay': { ... }
  case 'help': { ... }
  default: await say(`Unknown command: ${name}`);
}
// No case for 'permit', 'deny', or 'failover'
```

**Optimal Fix:**
Add to Task 10 Key Decisions:
1. "Add `'permit'` and `'deny'` to `KNOWN_COMMANDS` in `src/slack/commands.ts`."
2. "Add `case 'permit':` and `case 'deny':` handlers in `SlackService.dispatchCommand()` (service.ts:211). The `permit` case: look up pending permission, verify prompt still active, send approval keystroke. The `deny` case: look up pending permission, send denial keystroke."
3. "Also requires extending `SlackServiceOpts` (service.ts:17-26) — add `permissionsConfig?: PermissionsConfig` for `grant_ttl_seconds` access, and add `onPermissionGrant?: (sessionId: string, tool: string) => void` callback for wiring to daemon/index.ts."

**Why This Fix:**
Without dispatch routing, `!permit` and `!deny` are dead commands — recognized but unhandled. The implementer would discover this at testing time and need to retrofit the handlers.

**Fix Validated:** YES — Read `dispatchCommand` switch at service.ts:211-298. Confirmed: 7 cases (interrupt, stop, confirm, status, cmd, relay, help) + default. No permit/deny/failover cases. `parseCommand` returns name from KNOWN_COMMANDS or 'unknown', but `dispatchCommand` has its own independent routing.

**Validation Command:**
`grep -n "case '" src/slack/service.ts` — shows all current switch cases.

**Test Changes:** `tests/slack/service.test.ts` needs: `!permit` routes to permission grant, `!deny` routes to permission denial, unknown commands still get error message.

**Affected Tasks:** Task 10

---

#### HI-011: [NEW iter 7] Task 9 — Auto-grant keystroke logic cannot be implemented in Task 9's listed files; tmux access only available in daemon/index.ts

**Description:**
Task 9's DoD includes: "Auto-granted permissions send approval keystroke to tmux pane with safety checks (prompt still active, 5s latency limit)." The keystroke safety rules in Task 9's Key Decisions describe re-scanning output, timing constraints, and calling `sendText()` from `src/session/tmux.ts`.

But Task 9's Files section lists only:
- Create: `src/permissions/policy.ts`
- Create: `tests/permissions/policy.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`

None of these files have access to the tmux socket, session state, or `sendText()`/`sendEnter()` imports. The policy module (`policy.ts`) is a pure evaluation function — it returns `{ action: 'grant' | 'deny' | 'ask' }`. The keystroke sending is a **side effect** that must happen in the daemon wiring layer (`daemon/index.ts`), inside the `onPermissionDetected` callback that:
1. Calls `evaluatePermission()` from the policy engine (Task 9)
2. If `action === 'grant'` → sends keystroke to tmux (needs `tmuxSocket`, `session.tmux_name`)
3. If `action === 'ask'` → routes to Slack (Task 10)

Task 9's Files section is missing `src/daemon/index.ts` (modify), which is where the keystroke logic must be wired. The implementer working on Task 9 alone cannot satisfy the keystroke-related DoD items.

**Optimal Fix:**
Two options:

**Option A (recommended) — Split Task 9 scope:**
Keep `src/permissions/policy.ts` as a pure evaluation module (input: PermissionRequest + policy config, output: PermissionDecision). Move ALL keystroke logic to Task 10 or a new Task 9.5 that handles the daemon-level permission broker wiring in `daemon/index.ts`. Task 9's DoD should be limited to: policy evaluation correctness, glob pattern matching, precedence rules, and config integration.

**Option B — Add daemon/index.ts to Task 9:**
Add `src/daemon/index.ts` (modify) to Task 9's Files section with note: "Wire keystroke sending in the `onPermissionDetected` callback: call `evaluatePermission()`, if grant → `sendText(tmuxSocket, session.tmux_name, config.permissions.approval_key)` + `sendEnter(...)` with the safety checks described in Key Decisions."

Option A is cleaner — policy evaluation and keystroke side effects are separate concerns. The policy module is testable in isolation; the keystroke wiring needs integration testing with tmux mocks.

**Why This Fix:**
Without this, the implementer either: (a) puts tmux keystroke logic in `policy.ts` (wrong — policy module becomes untestable side-effect machine), (b) discovers the gap at implementation time and retrofits daemon/index.ts (rework), or (c) defers keystroke logic entirely and the DoD is unsatisfied.

**Fix Validated:** YES — Read Task 9 Files section: no daemon/index.ts listed. Read daemon/index.ts: `onPermissionDetected` callback doesn't exist yet (ME-004 covers adding it to LoopManagerDeps). Confirmed `sendText`/`sendEnter` require `tmuxSocket` and `tmux_name` parameters that only daemon/index.ts has access to via its local variables.

**Validation Command:**
`grep -n 'sendText\|sendEnter\|tmuxSocket' src/permissions/policy.ts` — file doesn't exist yet, but when created per Task 9's scope, it should NOT contain these imports.

**Test Changes:** Task 9 tests should test pure policy evaluation only. Keystroke integration tests belong in daemon/index tests or a dedicated integration test.

**Affected Tasks:** Task 9, Task 10

---

#### HI-012: [NEW iter 8] Task 11 — `execFile` mandate in AGENTS.md conflicts with user-configured gate command strings; plan proposes no reconciliation

**Description:**
HI-005 (iteration 1) identified that `child_process.execFile` cannot parse command strings containing spaces like `"npx tsc --noEmit"`. The plan's config has `command: string` (e.g., `"npx tsc --noEmit"`) + `args: string[]`. Earlier review text suggested shell execution as a workaround, but that is not the recommended fix because AGENTS.md rule #8 requires shell-free subprocess execution by default.

But AGENTS.md rule #8 explicitly mandates: "Use shell-free subprocess execution by default (`execFile`/argument arrays). Shell boundaries must be explicitly justified and tested."

This creates a design conflict: the plan's gate config format (a single `command` string containing the executable + arguments) is incompatible with shell-free execution. Switching to a shell-enabled spawn call would violate AGENTS.md without explicit justification.

The conflict is deeper than HI-005 described. The correct resolution is to change the config format so `command` is just the executable and all arguments go in `args`. A shell boundary would require an explicit plan decision, test coverage, and justification, but that path is not optimal for this codebase.

**Example:**
Current config design (Task 11):
```typescript
gates: Array<{
  command: string;       // "npx tsc --noEmit" — contains spaces, can't be used with execFile
  args: string[];        // additional args — redundant if command already has args
}>
```

Corrected shell-free config:
```typescript
gates: Array<{
  command: string;       // "npx" — executable only
  args: string[];        // ["tsc", "--noEmit"] — all arguments here
}>
```

**Optimal Fix:**
Use the shell-free config. It aligns with AGENTS.md, matches the existing `runner.command` + `runner.args` pattern in `RunnerConfig` (schema.ts:8-14), and is the simpler solution. Change Task 11's config example:
```typescript
gates: Array<{
  command: string;       // "npx" (executable only)
  args: string[];        // ["tsc", "--noEmit"]
  // ...
}>
```
Then gate execution uses `execFile(gate.command, gate.args, { cwd, timeout })` — no shell needed.

**Why This Fix:**
Without resolving this conflict, the implementer will either: (a) use `execFile` and gates fail at runtime (HI-005), (b) add shell execution and create an AGENTS.md exception that the plan did not justify, or (c) split command+args at implementation time after discovering the gap. The plan should make the shell-free design decision up front.

**Fix Validated:** YES — Confirmed AGENTS.md rule #8 text. Confirmed `RunnerConfig` uses split `command`/`args` pattern (schema.ts:8-14). Confirmed existing codebase consistently uses `execFileSync` with argument arrays. The shell-free config format (Option 1) is tested by analogy with the runner pattern.

**Validation Command:**
`grep -n 'execFile\|execFileSync' src/` — shows consistent shell-free usage across codebase.

**Test Changes:** Gate engine tests must use the chosen execution method and config format.

**Affected Tasks:** Task 11, Task 12

---

#### HI-013: [NEW iter 10] Task 1 smoke test lacks isolated daemon home/config wiring and can touch live `~/.aisup`

**Evidence:**
- Task 1 says the integration smoke test uses "a temporary config file with the user's real account config dirs" and "a test-specific journal path and port" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:261`).
- The daemon hard-codes its state root to `join(homedir(), '.aisup')` and calls `loadConfig()` without a path override (`src/daemon/index.ts:20-23`, `src/daemon/index.ts:32`).
- The daemon CLI also hard-codes the daemon PID path under `join(homedir(), '.aisup')` (`src/cli/commands/daemon.ts:7-8`).
- The default config path is `join(homedir(), '.aisup', 'config.yaml')` (`src/config/loader.ts:8`).
- Local verification confirmed `HOME=/private/tmp/aisup-home-check node -e "console.log(require('node:os').homedir())"` resolves `homedir()` to the temp home on this host.

**Issue:**
As written, Task 1 does not explain how the real daemon subprocess will be pointed at the temporary config, journal, PID file, token file, and session state. A zero-context implementer running the CLI/daemon directly will use the operator's live `~/.aisup` state.

**Impact:**
The smoke test can collide with or stop a real daemon, overwrite live PID/token/log files, use the wrong config, and leave live tmux sessions behind. It also undermines the test-specific journal/port requirement because the daemon has no config-path argument in the current startup path.

**Optimal Fix:**
Update Task 1 to require an isolated daemon home for every subprocess in the smoke test. The smallest plan-level fix is: create a temp HOME, write `.aisup/config.yaml` there with test-specific journal path and port, spawn all `aisup`/daemon subprocesses with `env: { ...process.env, HOME: tmpHome }`, and clean up only the PID/tmux sessions created under that temp home. If relying on `HOME` is considered too implicit, add an explicit `AISUP_HOME` or config-path override before the smoke test and use it consistently.

**Why This Fix:**
It preserves the current daemon/config architecture while making the integration test reproducible and safe. It avoids mutating the user's live supervisor state and avoids adding a broader config refactor unless the project wants an explicit `AISUP_HOME` contract.

**Fix Validated:** YES — All current daemon/CLI paths resolve from `homedir()`, and local Node resolution honors a subprocess `HOME` override on this host. The fallback `AISUP_HOME` option is a plan-level alternative if cross-platform behavior needs to be explicit.

**Validation Command:**
`HOME=/private/tmp/aisup-home-check node -e "console.log(require('node:os').homedir())"` and `rg -n "loadConfig\\(\\)|join\\(homedir\\(\\), '\\.aisup'" src`

**Affected Tasks:** Task 1

---

#### HI-014: [NEW iter 10] Task 1 automated `aisup attach` verification will fail or hang because attach is intentionally interactive

**Evidence:**
- Task 1 says the smoke test should "verify: `aisup attach` connects via `-L aisup` socket" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:265`).
- `sessionAttach()` exits immediately when stdin/stdout are not TTYs (`src/cli/commands/attach.ts:9-13`).
- When a TTY is present, it executes `tmux -L aisup attach-session -t <tmuxName>` with inherited stdio (`src/cli/commands/attach.ts:38`), which attaches interactively and does not return until detached.

**Issue:**
A Vitest smoke test is normally non-interactive, so invoking `aisup attach` will hit `process.exit(1)`. If the test is run under an interactive TTY, it can block indefinitely inside tmux until a human detaches.

**Impact:**
The Task 1 smoke test can be flaky, hanging, or impossible to run unattended. Because Task 2 and multiple feature tasks depend on Task 1, this creates avoidable rework before Phase 2 implementation starts.

**Optimal Fix:**
Remove interactive `aisup attach` execution from the automated smoke test. Verify the socket/session boundary deterministically instead: either add a unit test that mocks `execFileSync` and proves `sessionAttach()` builds `['-L', 'aisup', 'attach-session', '-t', tmuxName]`, or in the tmux integration smoke use `tmux -L aisup has-session -t <tmuxName>` to prove the session exists on the correct socket. Keep a manual attach check only if explicitly marked as manual or pseudo-TTY-gated.

**Why This Fix:**
It validates the same contract without running an interactive terminal program from an automated test. It also respects the existing attach design, which correctly rejects non-TTY use.

**Fix Validated:** YES — The current attach code has an explicit non-TTY guard and an inherited-stdio `attach-session` call. A non-interactive deterministic check avoids both failure modes.

**Validation Command:**
`nl -ba src/cli/commands/attach.ts | sed -n '1,60p'`

**Affected Tasks:** Task 1

---

### MEDIUM

#### ME-001: Plan reference `loop-manager.ts:130-145` is incorrect for journal emission pattern

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Context for Implementer says: "Journal event emission: see `src/daemon/loop-manager.ts:130-145` for the pattern of appending journal events during tick callbacks."

Lines 130-145 are actually telemetry session mismatch logging and `claude_session_id` hydration — not a representative pattern for how to add journal events in ticks. The actual patterns are at lines 246-251 (`output_log.rotated`), 271-276 (`skill.detected`), and 281-286 (`failure.detected`).

**Optimal Fix:**
Change the reference to: "Journal event emission: see `src/daemon/loop-manager.ts:246-251` for the `output_log.rotated` pattern, or lines 271-286 for the skill/failure detection pattern (read output → detect condition → emit event)."

**Fix Validated:** YES — Read lines 109-145 and 235-310 of loop-manager.ts.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** All tasks that emit journal events from loop-manager

---

#### ME-002: Task 9 auto-grant keystroke — unspecified text to send

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 9 says "Use `sendText()` from `src/session/tmux.ts` to send the approval key" for auto-granting permissions. But it never specifies WHAT text to send. Claude Code's permission prompt format determines the correct response — "y"? "Y"? "Enter"? "a" (for "allow")? This is critical implementation detail left unspecified.

**Optimal Fix:**
Add to Task 9 Key Decisions: "Approval keystroke: send `'y'` via `sendText()` then `sendEnter()` (same pattern as the existing tmux text-entry paths in `src/session/manager.ts:204-206` and `src/slack/service.ts:185-187`). This matches Claude Code's permission prompt which accepts 'y' for yes. If Claude Code changes to a different accept key, update the `permissions.approval_key` config field (add this field to `PermissionsConfig`)."

Also add `approval_key: string` (default: `'y'`) to the PermissionsConfig interface. Note: `sendEnter()` is a separate function from `sendText()` — the plan should explicitly call for both.

**Fix Validated:** NO — `[FIX UNVALIDATED]` — Would need to test against a live Claude Code permission prompt to confirm "y" + Enter is the correct response. Claude Code's accept key may vary by version or context.

**Validation Command:** Manual test: trigger a Claude Code permission prompt and verify "y" + Enter approves it.

**Test Changes:** Tests should mock `sendText` and `sendEnter` and verify the correct key is sent.

**Affected Tasks:** Task 9, Task 10

---

#### ME-003: Task 1 cannot validate permission patterns in bypass mode — hollow dependency

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 8 lists Task 1 as a dependency: "validates permission prompt patterns in output." But Task 1's own notes say: "smoke test likely runs in bypass mode, so permission patterns may not appear." This makes the dependency relationship hollow — Task 1 explicitly cannot validate what Task 8 depends on.

**Optimal Fix:**
Remove Task 1 as a hard dependency for Task 8. Instead:
1. Task 8 should have no dependencies (it can use known Claude Code permission patterns from documentation)
2. Add a note to Task 8: "Initial patterns derived from Claude Code's documented permission prompts. Validation against live output deferred to integration testing with `AISUP_TEST_PERMISSIONS=1` and bypass mode disabled."
3. Task 1's assumption validation section should document: "Permission pattern validation: NOT TESTED (bypass mode). See Task 8 for pattern sources."

**Fix Validated:** YES — The contradiction is explicit in the plan text of Task 1.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 1, Task 8

---

#### ME-004: Task 8 — `onPermissionDetected` callback needs explicit interface modification

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 8 says "call a new `onPermissionDetected` callback on `LoopManagerDeps`" but doesn't explicitly note that `LoopManagerDeps` interface needs modification. The interface is at `src/daemon/loop-manager.ts:21-38` and currently has `onSwitch` and `onRestart` callbacks but no permission callback.

**Optimal Fix:**
Add to Task 8 Key Decisions: "Add `onPermissionDetected?: (sessionId: string, request: PermissionRequest) => void` to `LoopManagerDeps` interface at `src/daemon/loop-manager.ts:21`." Also note that `src/daemon/index.ts` needs to wire this callback (same pattern as `onSwitch` at line 172).

**Fix Validated:** YES — Read LoopManagerDeps interface. No permission-related fields exist.

**Validation Command:** `grep -n 'onPermission' src/daemon/loop-manager.ts` — 0 matches currently.

**Test Changes:** `tests/daemon/loops/loop-manager.test.ts` mock deps need the new callback.

**Affected Tasks:** Task 8

---

#### ME-005: Task 7 — `getCooldownEta()` returns null for HALF_OPEN accounts

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 7 says: "For each account: check `getCooldownEta()` — if in the past, check `getState()` — if `HALF_OPEN` or `CLOSED`, this account is a candidate." The logic is backwards. `getCooldownEta()` only returns non-null when state is OPEN (in cooldown). Once cooldown expires and state transitions to HALF_OPEN (which happens automatically inside `getState()`), `getCooldownEta()` returns null.

**Example:**
`src/accounts/circuit-breaker.ts:102-106`:
```typescript
getCooldownEta(name: string): Date | null {
  const rec = this.store[name];
  if (!rec || rec.state !== 'OPEN' || !rec.openedAt) return null;
  return new Date(new Date(rec.openedAt).getTime() + this.cooldownMs);
}
```

And `getState()` auto-transitions OPEN → HALF_OPEN on cooldown expiry (in `load()` at lines 37-44 and lazily via `getState()`).

**Optimal Fix:**
Correct the polling logic description: "For each account: call `getState(account)`. If result is `HALF_OPEN` or `CLOSED`, this account is a recovery candidate. (`getState()` automatically transitions OPEN → HALF_OPEN when cooldown expires, so a single call is sufficient.) `getCooldownEta()` is only needed for the Slack notification ETA — call it BEFORE entering polling to show the user when recovery will be attempted."

**Fix Validated:** YES — Read `src/accounts/circuit-breaker.ts` in full. `getState()` at line 67+ performs the transition check. `getCooldownEta()` at line 102 only returns non-null for OPEN state.

**Validation Command:** N/A

**Test Changes:** None — the logic is already correct in the circuit breaker; only the plan description needs fixing.

**Affected Tasks:** Task 7

---

#### ME-006: Task 7 — `ExhaustedRecovery` constructor parameters unspecified

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 7 describes `ExhaustedRecovery` with `start(sessionId)` and `stop()` but doesn't specify what dependencies it needs. The implementer needs to know what to inject.

**Optimal Fix:**
Add to Task 7 Key Decisions:
```typescript
// Constructor dependencies
interface ExhaustedRecoveryDeps {
  circuitBreaker: CircuitBreaker;
  accountRegistry: AccountRegistry;
  config: RecoveryConfig;
  journal: JournalWriter;
  onAccountAvailable: (sessionId: string, account: string) => Promise<void>;
}
```
Where `onAccountAvailable` calls `restartInPlace()` with the recovered account.

**Fix Validated:** YES — Traced all data needed: circuit breaker for state checks, account registry for candidate list, config for poll interval, journal for events, restart callback for recovery action.

**Validation Command:** N/A

**Test Changes:** Tests need to mock all these dependencies.

**Affected Tasks:** Task 7

---

#### ME-007: Task 5 and Task 12 API endpoints need `DaemonServerOptions` extension but plan doesn't mention it

**Status:** CONFIRMED (from iteration 2)

**Description:**
Task 5 adds `GET /api/cost` and Task 12 adds `GET /api/gates` + `POST /api/gates/run`. New routes need access to data (cost aggregator, gate engine). The existing `DaemonServerOptions` interface in `src/daemon/server.ts` accepts specific dependencies:
```typescript
interface DaemonServerOptions {
  tokenPath: string;
  host: string;
  port: number;
  sessionManager?: SessionManager;
  accountRegistry?: AccountRegistry;
  journal?: JournalWriter;
  journalPath?: string;
  runnerConfig?: ...;
  runner?: RunnerConfig;
  onSessionStart?: ...;
  onSessionStop?: ...;
}
```

For `GET /api/cost`, the route needs either `journalPath` (already available) to call `aggregateCosts()` inline, or a pre-built aggregator. For `GET /api/gates` and `POST /api/gates/run`, the route needs access to the gate engine and latest run summary.

Neither task mentions extending `DaemonServerOptions` or how the route accesses the needed data.

**Optimal Fix:**
- Task 5: Add note: "Cost endpoint can use existing `opts.journalPath` to call `aggregateCosts()` inline — no `DaemonServerOptions` change needed."
- Task 12: Add note: "Add `gateEngine?: GateEngine` and `latestGateRun?: GateRunSummary` (or a getter callback) to `DaemonServerOptions`. The `POST /api/gates/run` endpoint needs access to the gate engine to trigger manual runs."
- Both tasks should list `src/daemon/server.ts` in their Files sections with the nature of the change (new route vs interface extension).

**Why This Fix:**
A zero-context implementer adding routes needs to know how to connect them to data. The existing pattern (inject via `DaemonServerOptions`) is not obvious without reading the full server file.

**Fix Validated:** YES — Read `DaemonServerOptions` and existing route patterns. The cost endpoint can reuse `journalPath`. The gate endpoint needs new deps.

**Validation Command:** N/A

**Test Changes:** `tests/daemon/server.test.ts` needs mock gate engine for gate route tests.

**Affected Tasks:** Task 5, Task 12

---

#### ME-008: Task 6 should reference existing `RATE_LIMIT_PATTERNS` and `detect429InOutput()` as the pattern to follow

**Status:** CONFIRMED (from iteration 2)

**Description:**
Task 6 creates new auth/network failure detection patterns in `src/recovery/patterns.ts`. It says: "Follows same structure as existing `detect429InOutput()` in `src/daemon/loops/recovery-handler.ts`." But this is only in the body text — the actual implementation approach should be explicit about:
1. Using `strip-ansi` (already used by `detect429InOutput()`)
2. Following the `RATE_LIMIT_PATTERNS` → `somePatternTest()` structure
3. Using the same `readLogTail()` function for output scanning

The existing recovery-handler pattern (recovery-handler.ts:1-12) is:
```typescript
import stripAnsi from 'strip-ansi';
const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, ...];
export function detect429InOutput(text: string): boolean {
  const clean = stripAnsi(text);
  return RATE_LIMIT_PATTERNS.some((p) => p.test(clean));
}
```

**Optimal Fix:**
Add to Task 6 Key Decisions: "Follow the exact pattern from `src/daemon/loops/recovery-handler.ts:1-12`: import `strip-ansi`, define pattern arrays as module-level constants, export detector functions that strip ANSI before matching. Use `readLogTail()` from the same file for output reading (already used by `recoveryTick`)."

**Why This Fix:**
Ensures consistency with existing codebase patterns. Without this, the implementer might skip ANSI stripping (causing false negatives on terminal output) or implement a different scanning approach.

**Fix Validated:** YES — Read `src/daemon/loops/recovery-handler.ts`. The pattern is clear and reusable.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 6

---

#### ME-009: Task 8 permission detection patterns may produce high false positive rates without word-boundary matching

**Status:** CONFIRMED (from iteration 2)

**Description:**
Task 8 lists detection patterns: `"Allow [tool_name]"`, `"Allow Read"`, `"Allow Bash(command)"`. The word "Allow" appears frequently in normal Claude Code output (e.g., "Allow me to...", "This will allow...", documentation text). Without word-boundary anchoring or multiline context analysis, these patterns will fire on non-permission output.

The existing `RATE_LIMIT_PATTERNS` in recovery-handler.ts use simple regex without word boundaries, but those patterns (`/rate limit/i`, `/429/`, `/usage cap/i`) are much more specific and rarely appear in normal output. "Allow" is orders of magnitude more common.

**Optimal Fix:**
Add to Task 8 Key Decisions: "Default detection patterns must be specific enough to avoid false positives. Recommended approach: scan for the FULL permission prompt line format, not just 'Allow'. Claude Code permission prompts follow a structured format with tool name in backticks and a question mark. Example patterns:
```typescript
const PERMISSION_PATTERNS = [
  /Allow\s+\w+\s*\?/,              // 'Allow Read?' 'Allow Bash?'
  /Allow\s+\w+\([^)]*\)\s*\?/,     // 'Allow Bash(git status)?'
  /Permission requested/i,           // Alternative phrasing
];
```
Also: scan only NEW output (delta since last cursor, same as 429 detection), not the full log — this naturally limits the window and reduces false positive accumulation."

**Why This Fix:**
False positive permission detections trigger the policy engine, produce noisy journal events, and may send spurious Slack messages. The plan acknowledges this risk ("Permission detection false positives — Medium") but doesn't specify the mitigation in the pattern design.

**Fix Validated:** NO — `[FIX UNVALIDATED]` — The exact format of Claude Code's permission prompts depends on the Claude Code version. The regex patterns above are based on observed output but may need tuning.

**Validation Command:** Manual test with live Claude Code output.

**Test Changes:** Task 8 tests should include false positive cases: "Allow me to explain", "This will allow access", etc.

**Affected Tasks:** Task 8

---

#### ME-010: [NEW] Task 3 — `rateLimitTick` does NOT access `cost?.total_cost_usd` at the stated location

**Description:**
Task 3 says: "Where: In `rateLimitTick()` at `src/daemon/loop-manager.ts:109`, after reading telemetry via `readTelemetryForActiveSession()`. The telemetry object already has `cost?.total_cost_usd`."

The telemetry is indeed read at line 116-121:
```typescript
const telemetryResult = readTelemetryForActiveSession(session, account.configDir, d.statuslineDir, d.statuslineFreshnessWindowS);
const telemetry = telemetryResult.telemetry;
```

And `StatuslineTelemetry` does have `cost?: { total_cost_usd?: number }` (statusline/types.ts:16). However, `rateLimitTick` currently exits early at line 141 when `!telemetry?.rate_limits` — BEFORE any cost-related code could run. If rate limits are not present but cost data is, the tick exits and the cost snapshot is never captured.

**Optimal Fix:**
Add to Task 3 Key Decisions: "Cost snapshot extraction must happen BEFORE the `if (!telemetry?.rate_limits) return;` guard at line 141, because cost data may be present even when rate limit data is absent. Insert the cost snapshot logic after the `claude_session_id` hydration block (line 134-139) and before the rate limit check."

**Why This Fix:**
Without this positioning, cost snapshots are only captured when rate limit data is also present. During early session startup or when the statusline tap script provides partial data, cost snapshots would be silently dropped.

**Fix Validated:** YES — Read `rateLimitTick()` at loop-manager.ts:109-141. The early return at line 141 would skip any cost extraction placed after it. Cost extraction must be placed at line ~140, before the guard.

**Validation Command:** N/A

**Test Changes:** Task 3 tests should include: cost data present but rate limits absent → snapshot still captured.

**Affected Tasks:** Task 3

---

#### ME-011: [NEW] Task 10 — SlackService already has tmux keystroke pattern for non-command messages; plan should reference it

**Description:**
Task 10 describes sending approval/denial keystrokes to tmux via `!permit`/`!deny` commands. The existing `SlackService` already has a pattern for forwarding text to tmux at `service.ts:185-187`:
```typescript
if (session && this.opts.config.relay_output_enabled && this.relayEnabled.get(channelId)) {
  sendText(this.opts.tmuxSocket, session.tmux_name, text);
  sendEnter(this.opts.tmuxSocket, session.tmux_name);
}
```

This shows the exact `sendText` + `sendEnter` pattern that `!permit` should follow, using `this.opts.tmuxSocket` and `session.tmux_name`. The plan's Task 10 doesn't reference this existing pattern, leaving the implementer to discover it independently.

**Optimal Fix:**
Add to Task 10 Key Decisions: "Use the existing tmux keystroke pattern from `SlackService.handleMessage()` at service.ts:185-187: `sendText(this.opts.tmuxSocket, session.tmux_name, key)` followed by `sendEnter(...)`. The `tmuxSocket` and `session.tmux_name` are already available via `this.opts` and `getActiveSession()`."

**Why This Fix:**
Pointing to the existing pattern ensures consistency and prevents the implementer from constructing a different (potentially incorrect) tmux interaction path.

**Fix Validated:** YES — Read `src/slack/service.ts:185-187`. The `sendText`/`sendEnter` pattern is already used for relaying user messages to tmux.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 10

---

#### ME-012: [NEW] Task 10 — `SlackServiceOpts` needs extension for permission state and config

**Description:**
Task 10 adds pending permission tracking and TTL-based expiry to `SlackService`. But `SlackServiceOpts` (service.ts:17-26) currently only provides:
```typescript
export interface SlackServiceOpts {
  config: SlackConfig;
  sessionManager: {
    getActiveSession(): SessionState | null;
    stopSession(tmuxName: string, sessionId: string, opts: { force?: boolean }): Promise<void>;
  };
  tmuxSocket: string;
  journal: JournalWriter;
  channelMapPath: string;
}
```

Task 10 needs:
1. `PermissionsConfig.grant_ttl_seconds` to set TTL on pending permissions — not accessible via `SlackConfig`
2. `PermissionRequest` type from `src/permissions/types.ts` — cross-module type dependency
3. A callback like `onPermissionGrant(sessionId, tool)` / `onPermissionDeny(sessionId, tool)` to wire the grant/deny action back to daemon/index.ts (for journal events and keystroke sending)

Without extending `SlackServiceOpts`, the implementer will need to figure out how to get permissions config into SlackService. The pattern for extending opts is established but the plan doesn't mention this interface change.

**Optimal Fix:**
Add to Task 10 Key Decisions: "Extend `SlackServiceOpts` in `src/slack/service.ts:17` with:
```typescript
permissionsConfig?: PermissionsConfig;
onPermissionGrant?: (sessionId: string, request: PermissionRequest) => void;
onPermissionDeny?: (sessionId: string, request: PermissionRequest) => void;
```
Wire these in `daemon/index.ts` where `SlackService` is constructed (line ~259). The `onPermissionGrant` callback sends the approval keystroke and emits `permission.granted` journal event. Both callbacks are optional — permissions feature is opt-in."

**Why This Fix:**
Without explicit interface guidance, the implementer will either: (a) hardcode the TTL, (b) add an ad-hoc property, or (c) restructure the opts incorrectly. The interface contract should be specified upfront.

**Fix Validated:** YES — Read `SlackServiceOpts` at service.ts:17-26. No permissions-related fields exist. Confirmed SlackService is constructed in daemon/index.ts:56-65 where opts are passed.

**Validation Command:** N/A

**Test Changes:** `tests/slack/service.test.ts` mock opts need the new optional fields.

**Affected Tasks:** Task 10

---

#### ME-013: [NEW] `!gate` Slack command assigned in File Structure but no task implements it

**Description:**
The plan's File Structure section (line 191) says:
> `src/slack/commands.ts` (modify) — add `!permit`, `!deny`, `!gate` to `KNOWN_COMMANDS`

The Conventions section (line 72) says:
> Slack commands prefixed with `!` — e.g., `!permit`, `!deny`, `!gate`

Task 10 handles `!permit` and `!deny` (adds to KNOWN_COMMANDS, modifies service.ts). But `!gate` is not handled by any task:
- Task 12 modifies `src/slack/service.ts` for gate result **notifications** (posting results to channel)
- Task 12 does NOT list `src/slack/commands.ts` in its Files section
- Task 12's Key Decisions mention `aisup gate` CLI and `POST /api/gates/run` for manual trigger, but never mention `!gate` as a Slack command
- No task adds `case 'gate':` to `dispatchCommand()`

The `!gate` command falls through the cracks — mentioned in plan infrastructure docs but unassigned to any implementation task.

**Optimal Fix:**
Add to Task 12 Key Decisions: "Add `'gate'` to `KNOWN_COMMANDS` in `src/slack/commands.ts`. Add `case 'gate':` to `dispatchCommand()` in `src/slack/service.ts`: `!gate` triggers manual gate run (same as `POST /api/gates/run`), `!gate status` shows latest results in Slack."

Add `src/slack/commands.ts` (modify) to Task 12's Files section.

**Why This Fix:**
Without this, `!gate` appears in plan documentation but is never implemented. Users expecting Slack-based gate control (consistent with `!permit`/`!deny` pattern) will find it missing.

**Fix Validated:** YES — Searched Task 12 Key Decisions for "!gate", "KNOWN_COMMANDS", and "slack/commands" — zero matches. File Structure line 191 clearly assigns `!gate` to `src/slack/commands.ts` modification.

**Validation Command:** N/A

**Test Changes:** Task 12 tests should include Slack `!gate` command dispatch.

**Affected Tasks:** Task 12

---

#### ME-014: [NEW iter 5] Task 12 — `onGateTrigger` callback placement unspecified; should be on `LoopManagerDeps` not `LoopManagerOpts`

**Description:**
Task 12 says gate triggers should call `onGateTrigger(sessionId, completedSkill)` from `idleTick()`. But the plan doesn't specify which interface should receive this callback. `LoopManager` has two callback interfaces with distinct purposes:

- `LoopManagerOpts` (line 40-49): **event/notification callbacks** — `onThresholdBreach`, `onCrashDetected`, `onHealthResult`, `onIdle`. These are set at construction time and stored as instance fields.
- `LoopManagerDeps` (line 21-38): **action callbacks** — `onSwitch`, `onRestart`. These are passed via the `deps` property and accessed through the `d` parameter in tick methods.

Gate triggering is an **action** (runs shell commands, modifies session state, posts Slack results) — not a notification. It should be on `LoopManagerDeps`, alongside `onSwitch` and `onRestart`.

However, `idleTick()` currently accesses the deps parameter as `d: LoopManagerDeps`:
```typescript
private idleTick(d: LoopManagerDeps): void {
  const session = d.sessionManager.getActiveSession();
  if (!session) return;
  if (isSessionIdle(...)) { this.onIdle(session.aisup_session_id); }
}
```

Note that `onIdle` is accessed as `this.onIdle` (from Opts, stored on instance), while `onSwitch`/`onRestart` in `recoveryTick` are accessed as `d.onSwitch` (from Deps, passed per-tick). Task 12's `onGateTrigger` must follow the `d.onGateTrigger` pattern to be consistent with its action-callback nature.

This is separate from ME-004 (which covers `onPermissionDetected` on `LoopManagerDeps` for Task 8). Task 12 has a distinct callback with a different signature and purpose.

**Optimal Fix:**
Add to Task 12 Key Decisions: "Add `onGateTrigger?: (sessionId: string, completedSkill: string) => Promise<void>` to `LoopManagerDeps` interface (not `LoopManagerOpts`). Access as `d.onGateTrigger?.(sessionId, skill)` inside `idleTick()`. Wire in `daemon/index.ts` via the deps object, same as `onSwitch`/`onRestart`. The gate trigger callback should: run gates via the gate engine, emit journal events, post Slack notifications, and clear `active_skill` on completion."

**Why This Fix:**
Placing the callback on the wrong interface causes inconsistency with the existing pattern and makes the `idleTick()` method a mix of `this.*` and `d.*` callback styles for similar purposes.

**Fix Validated:** YES — Read `LoopManagerOpts` (L40-49) and `LoopManagerDeps` (L21-38). Confirmed the event/action split. Verified `idleTick()` receives `d: LoopManagerDeps` parameter and `onIdle` is on `this` (Opts pattern). Action callbacks (`onSwitch`, `onRestart`) are consistently on `Deps`.

**Validation Command:** N/A

**Test Changes:** `tests/daemon/loops/loop-manager.test.ts` mock deps need `onGateTrigger` callback.

**Affected Tasks:** Task 12

---

#### ME-015: [NEW iter 6] PRD scope gap — "remote-control reconnect" silently omitted from plan

**Description:**
The PRD lists Feature D₂ as "Reactive Recovery — full (auth failure, exhausted, network, RC reconnect)" (line 249) and the Phase 2 In Scope section repeats: "remote-control reconnect" (line 78). The Phase 2 plan's In Scope lists D₂ as "auth failure detection, both-exhausted sleep-until-reset, network retry" — omitting "RC reconnect" entirely. It's not in any task, not in Out of Scope, and not in Deferred Ideas.

This is a silent PRD scope omission. The plan implements three of the four D₂ sub-features and drops the fourth without acknowledging the gap.

"Remote-control reconnect" likely refers to Claude Code's remote-control session reconnection after account switches — the `remote_control_prefix` field in `RunnerConfig` (config/schema.ts:7) and the `--remote-control-session-name-prefix` flag in `buildArgs()` (runner/builder.ts:13-15). If the supervisor switches accounts, the remote-control session on the new account may need to be re-established or the session name prefix may need updating.

**Optimal Fix:**
Two options:

**Option A (recommended) — Explicit deferral:** Add to Out of Scope or Deferred Ideas: "Remote-control reconnect (D₂ sub-feature): deferred — requires investigation of Claude Code's remote-control session behavior after account switches. The `remote_control_prefix` config exists but no reconnect logic is needed in Phase 2 if the prefix is static across accounts."

**Option B — Add a task:** If RC reconnect is genuinely needed for D₂ completeness, add a task between 7 and 8 (or extend Task 7) to handle remote-control session prefix management during account switches.

Option A is recommended — this is likely a non-issue for single-user aisup (the remote-control prefix is account-independent), and adding a task for speculative RC reconnect adds complexity without clear value.

**Why This Fix:**
Silent scope omissions create ambiguity about whether the feature was intentionally dropped or accidentally missed. Explicit deferral with rationale prevents future reviewers from re-discovering this gap.

**Fix Validated:** YES — Searched plan for "RC reconnect", "remote-control reconnect", "remote control reconnect" — zero matches. Confirmed PRD mentions at lines 78 and 249. Confirmed `remote_control_prefix` exists in config and runner builder.

**Validation Command:**
`grep -n 'RC reconnect\|remote.control reconnect' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` — returns 0 matches.

**Test Changes:** None if deferred. If implemented, test RC reconnect after account switch.

**Affected Tasks:** Plan scope section, potentially Task 7

---

#### ME-016: [NEW iter 6] Task 8 `detection_patterns` config ownership mismatch — described in Task 8, config files modified in Task 9

**Description:**
Task 8 line 550 says: "Configurable patterns: Add `permissions.detection_patterns` to config as an optional string array. Default patterns built into the detector, config overrides for future-proofing."

But Task 8's Files section lists only:
- Create: `src/permissions/detector.ts`, `src/permissions/types.ts`, `tests/permissions/detector.test.ts`
- Modify: `src/daemon/loop-manager.ts`, `src/journal/types.ts`

Task 8 does NOT list `src/config/schema.ts` or `src/config/loader.ts` — these are only listed in Task 9's Files section. Task 9's `PermissionsConfig` interface includes `detection_patterns: string[]`.

This creates a dependency inversion: Task 8's DoD item "configurable patterns" can't be fully satisfied without Task 9's config schema changes. But Task 9 depends on Task 8 (`Dependencies: Task 8`). So:
- Task 8 needs detection patterns from config → requires config changes
- Config changes are in Task 9 → which depends on Task 8
- Circular: Task 8 can't read configurable patterns until Task 9 defines them

**Optimal Fix:**
Move `detection_patterns` config to Task 8's scope:
1. Add `src/config/schema.ts` (modify) and `src/config/loader.ts` (modify) and `src/config/defaults.ts` (modify) to Task 8's Files section.
2. Task 8 defines a minimal config section for just `detection_patterns`:
   ```typescript
   interface PermissionsConfig {
     enabled: boolean;
     detection_patterns: string[];
   }
   ```
3. Task 9 extends this interface with policy, slack_routing, grant_ttl_seconds fields.

Alternative: Keep Task 8 hardcoded patterns only (no config) and make configurable patterns a Task 9 deliverable. Simpler, removes the circular dependency, but means Task 8's "configurable patterns" DoD is deferred.

**Why This Fix:**
A zero-context implementer working Task 8 will try to implement "configurable patterns" per the Key Decisions, discover the config files aren't in their Files section, and either skip it (incomplete implementation) or modify files not assigned to their task (potential conflicts with Task 9).

**Fix Validated:** YES — Confirmed Task 8 Files section has no config files. Confirmed Task 9 Files has `schema.ts` and `loader.ts`. Confirmed `detection_patterns` appears in Task 8 text (line 550) and Task 9's PermissionsConfig (line 585).

**Validation Command:** N/A

**Test Changes:** If config moves to Task 8, add config validation tests for `detection_patterns` field.

**Affected Tasks:** Task 8, Task 9

---

#### ME-017: [NEW iter 7] Tasks 6/8 — Output scanning insertion point in `recoveryTick()` is inside a cursor-guarded block; plan doesn't specify ordering relative to existing 429 check

**Description:**
Tasks 6 (auth/network detection) and 8 (permission detection) say to add scanning to `recoveryTick()` "after the existing 429 check." But the output text and scanning logic in `recoveryTick()` has a specific structure that constrains where new detection can be inserted:

```typescript
// loop-manager.ts:257-305 (simplified)
if (paneAlive) {
  let cursor = this.recoveryHandler.getCursor(sessionId);
  if (cursor) {                                           // line 263
    const output = readLogTail(logPath, cursor.offset);   // line 266
    if (output) {
      const detectedSkill = detectSkill(output, ...);     // line 268 — skill detection
      // ... skill state update ...
      if (detect429InOutput(output)) {                    // line 279 — 429 detection
        cursor.advance(currentSize);                      // line 280
        // ... journal event, circuit breaker ...
        await d.onSwitch(...);                            // line 298 — RETURNS after this
        return;                                           // line 301
      }
    }
    cursor.advance(currentSize);                          // line 304
  }
}
```

**Critical constraints:**
1. The `output` variable is only available inside the `if (cursor)` block at line 263. New detection functions can only access it here.
2. If `detect429InOutput()` returns true (line 279), the method calls `onSwitch` and **returns** (line 301). Any detection added AFTER the 429 check will be **completely skipped** whenever a 429 is present.
3. Skill detection at line 268 runs BEFORE the 429 check. Auth/network/permission detection must also run before the 429 check, or they'll be skipped on 429 output.

The plan's phrase "after the existing 429 check" would place new detection at ~line 303, which is after the 429 return — meaning the detection would never fire when 429 is found. If the session outputs both an auth failure and a 429 (plausible during account issues), the auth failure would be silently missed.

**Optimal Fix:**
Add to Task 6 and Task 8 Key Decisions: "Insert new detection in `recoveryTick()` at line ~278, BETWEEN skill detection (line 268) and 429 detection (line 279). The scan order must be: skill detection → auth failure detection → network error detection → permission detection → 429 detection. If auth failure is detected, skip the 429 check and call `onSwitch` with `SwitchReason.AuthFailure` instead. Network error and permission detection are non-exclusive with 429 — they should log but not prevent the 429 path from executing."

Alternatively, restructure to: read output → run ALL detectors → collect results → act on highest-priority result (auth failure > 429 > network error > permission). This is cleaner but a bigger refactor.

**Why This Fix:**
Without explicit ordering, the implementer will add detection "after the 429 check" as the plan says, placing it at ~line 303. Auth failures during rate-limit events will be missed, and the implementer will waste time debugging why detection doesn't fire for certain output.

**Fix Validated:** YES — Read `recoveryTick()` at loop-manager.ts:235-310. Confirmed the `return` at line 301 after `onSwitch`. Confirmed `output` is scoped inside `if (cursor)`. Confirmed the scan order: skill (268) → 429 (279) → return (301) → cursor advance (304). Any code at line 303 only runs when NO 429 is detected.

**Validation Command:** N/A

**Test Changes:** Task 6 and Task 8 tests should include: output containing both auth failure AND 429 patterns → auth failure detection fires (not masked by 429).

**Affected Tasks:** Task 6, Task 8

---

#### ME-018: [NEW iter 7] Task 6 — Network error consecutive counter needs explicit state tracking on LoopManager

**Description:**
Task 6 says: "If 3+ consecutive network errors, trigger session restart." But the Key Decisions don't specify where the consecutive counter lives. The counter must:
1. Persist across ticks (not local to a single `recoveryTick()` invocation)
2. Be per-session (different sessions have independent counters)
3. Reset when the session produces non-error output, switches accounts, or stops
4. Be accessible in `recoveryTick()` where the detection runs

The natural location is a `Map<string, number>` on `LoopManager`, following the same pattern the plan uses for `lastCostSnapshot` (Task 3) and `previousSkill` / `lastGateRun` (Task 12). But the plan doesn't specify this.

The `network_error_threshold` value comes from `RecoveryConfig` (Task 7, `config.recovery.network_error_threshold: 3`), but the counter tracking itself is in the loop manager layer. Without specifying this, the implementer may create the counter in the wrong module (e.g., inside `src/recovery/patterns.ts` which is stateless) or forget to reset it on recovery events.

**Optimal Fix:**
Add to Task 6 Key Decisions: "Track network error count per session on LoopManager: `private networkErrorCount: Map<string, number> = new Map()`. Increment on each network error detection. Reset to 0 when: (a) non-error output is detected (skill detection or normal output without errors), (b) session stops or switches, (c) session restart triggered. The threshold value comes from `config.recovery.network_error_threshold` (Task 7's RecoveryConfig, default 3). Until Task 7 is implemented, hardcode the threshold to 3."

**Why This Fix:**
Without explicit state tracking guidance, the implementer will need to independently discover the Map-on-LoopManager pattern and the reset conditions. The reset conditions are particularly important — without them, a single network blip followed by recovery would leave the counter elevated, causing a premature restart on the next (potentially unrelated) network error.

**Fix Validated:** YES — Confirmed LoopManager uses instance-level Maps for per-session state in other plan tasks (Task 3: `lastCostSnapshot`, Task 12: `previousSkill`, `lastGateRun`). No existing network error tracking exists in the codebase. `RecoveryConfig.network_error_threshold` is defined only in Task 7's plan text, not yet in code.

**Validation Command:** N/A

**Test Changes:** Task 6 tests should include: 2 consecutive network errors → no restart, 3 consecutive → restart, network error + normal output + network error → counter resets (no restart at 2 total).

**Affected Tasks:** Task 6, Task 7

---

#### ME-019: [REJECTED iter 18] Task 2 — `restartInPlace()` empty `accountConfigDir` does not set `CLAUDE_CONFIG_DIR=''`

**Status:** REJECTED. This historical finding is no longer counted active.

**Original Issue:**
Iteration 8 claimed Task 2's state-without-tmux recovery would call `restartInPlace()`, hit the missing-tmux fallback, pass `accountConfigDir: ''` to `createSession()`, and therefore launch Claude/Pilot with `CLAUDE_CONFIG_DIR=''`.

**Current Evidence:**
- `src/session/manager.ts:84-118` — `createSession()` destructures `aisupSessionId`, `account`, `command`, `args`, `env`, and `cwd`; it does not read `accountConfigDir`.
- `src/session/manager.ts:187-198` — the missing-tmux fallback passes `accountConfigDir: ''`, but also passes through the caller-provided `command`, `args`, and `env`.
- `src/session/tmux.ts:67-72` — tmux environment variables come from the `env` argument, not from `accountConfigDir`.
- `src/daemon/index.ts:244-261` — the existing `onRestart` callback resolves `accountRegistry.get(state.account)`, builds the command/env through `buildResumeCommand()` or `buildLaunchCommand()`, and then calls `restartInPlace()`.

**Issue:**
The prior `CLAUDE_CONFIG_DIR=''` claim is unsupported. The empty `accountConfigDir` field is a dead argument in the current `createSession()` implementation and does not influence the tmux environment. The real Task 2 risk is already covered by HI-004: rehydration lacks an `onRestart` callback or equivalent registry-aware recovery boundary to construct the correct command/env before calling `restartInPlace()`.

**Impact:**
Keeping this as an active finding would send implementers toward a non-bug and duplicate the broader HI-004 architecture fix.

**Optimal Fix:**
Do not add a separate Task 2 requirement around `restartInPlace()`'s `accountConfigDir: ''` unless `createSession()` is later changed to use that field. Fix HI-004 instead: rehydration recovery must go through a daemon-level callback that resolves the account and runner command/env before restart.

**Why This Fix:**
It removes an unsupported blocker while preserving the valid recovery wiring concern in a single canonical finding.

**Fix Validated:** YES — Read `createSession()`, `restartInPlace()`, `createTmuxSession()`, and daemon `onRestart`. This matches the rejected P1-FULL-007 conclusion at the bottom of this review.

**Validation Command:**
`rg -n "accountConfigDir|createSession\\(|createTmuxSession\\(|buildResumeCommand|buildLaunchCommand" src/session/manager.ts src/session/tmux.ts src/daemon/index.ts`

**Test Changes:** None for this rejected finding. HI-004 still needs Task 2 rehydration tests for registry-aware restart callback wiring.

**Affected Tasks:** Historical only; active concern remains HI-004.

---

#### ME-020: [NEW iter 10] Task 1 integration smoke test is env-gated but lacks explicit host markers

**Evidence:**
- AGENTS.md rule 7 requires host-gated tests to use explicit markers: `requires_tmux`, `requires_slack`, and `requires_claude` (`AGENTS.md:9`).
- Task 1 only specifies `AISUP_INTEGRATION=1` gating for `tests/integration/smoke.test.ts` (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:262`, `:269`, `:276`).
- Existing host-gated tests already mark tmux requirements with file comments such as `@requires_tmux` (`tests/session/tmux.test.ts:2`, `tests/session/manager.test.ts:2`).

**Issue:**
The planned smoke test exercises real daemon/tmux lifecycle and may start Pilot/Claude depending on how the test runner is configured, but the plan does not require the explicit markers that separate host-gated integration tests from pure logic tests.

**Impact:**
Future maintainers and CI jobs cannot classify the test boundary from the file itself. The test may be skipped by env guard, but it still violates the repository's marker convention and makes it unclear whether the test requires tmux only or also real Claude credentials.

**Optimal Fix:**
Update Task 1 to require a file-level marker comment for `tests/integration/smoke.test.ts`: at minimum `@requires_tmux`. If the test launches real Pilot/Claude or reads real Claude account state instead of a fake runner, also mark `@requires_claude`. If any Slack path is included later, mark `@requires_slack`. Keep the `AISUP_INTEGRATION=1` guard as the runtime skip mechanism.

**Why This Fix:**
It follows the existing local test convention while preserving the env guard. The marker documents the boundary; the guard controls execution.

**Fix Validated:** YES — Existing tmux tests use marker comments and skip guards; Task 1 currently names only the env guard.

**Validation Command:**
`rg -n "requires_tmux|requires_slack|requires_claude|AISUP_INTEGRATION" tests docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md AGENTS.md`

**Affected Tasks:** Task 1

---

#### ME-021: [NEW iter 19] Goal Verification uses `aisup log --type cost.snapshot`, but no task adds `log --type`

**Evidence:**
- Goal Verification truth #3 says: "Cost snapshots appear in journal (`aisup log --type cost.snapshot`)" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:136`).
- The current CLI registers `aisup log` with only `--limit` and calls `showLog({ limit })` (`src/cli/index.ts:60-63`).
- `showLog()` reads the last N lines from the journal and has no type filter option (`src/cli/commands/log.ts:6-29`).
- The Phase 2 plan does not list `src/cli/commands/log.ts` as modified in Task 3, Task 4, or Task 5.

**Issue:**
The plan's own verification command is not implementable as written. Cost snapshots can be written to the journal, and `/api/events` already supports a `type` query, but no task extends the user-facing `aisup log` command with `--type`.

**Impact:**
A zero-context implementer can complete the cost tasks and still fail the plan's stated verification command. Reviewers will either run a nonexistent CLI flag or accept a weaker manual journal inspection.

**Optimal Fix:**
Add `src/cli/commands/log.ts` (modify) and `src/cli/index.ts` (modify) to Task 5, or change Goal Verification truth #3 to a command the plan actually implements. Recommended fix: add `aisup log --type <event_type>` by wiring the flag to `/api/events?type=...` online and `readEvents(config.journal.path, { type })` offline.

**Why This Fix:**
It uses the existing `/api/events` and `readEvents()` filtering contract instead of adding another journal reader or changing the cost feature surface.

**Fix Validated:** YES — Read `src/cli/index.ts`, `src/cli/commands/log.ts`, and `src/daemon/server.ts` `/api/events`. The server and journal reader already support type filtering; the CLI is the missing link.

**Validation Command:**
`rg -n "command\\('log'|showLog|type" src/cli src/daemon/server.ts src/journal/reader.ts`

**Affected Tasks:** Task 5, Goal Verification

---

#### ME-022: [NEW iter 19] Task 5 offline cost mode hardcodes `~/.aisup/journal.jsonl` instead of configured `journal.path`

**Evidence:**
- Task 5 says offline mode should "Read journal directly from `~/.aisup/journal.jsonl` when daemon is not running" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:418`).
- Config supports a configurable journal path (`src/config/schema.ts:64-65`), defaults it in `CONFIG_DEFAULTS` (`src/config/defaults.ts:51-53`), expands it in `validateConfig()` (`src/config/loader.ts:140-164`), and passes it to the daemon server as `journalPath` (`src/daemon/index.ts:74-75`).
- The current `aisup log` command already has the same Phase 1 bug: it hardcodes `~/.aisup/journal.jsonl` (`src/cli/commands/log.ts:8`), and P1-FULL-012 tracks that as a current Phase 1 observability gap.

**Issue:**
Task 5 would reproduce an already-known observability defect in the new `aisup cost` command. Users with a non-default `journal.path` would see empty or stale cost data in offline mode even though the daemon wrote cost snapshots to the configured path.

**Impact:**
`aisup cost` can disagree between online and offline modes and can underreport spending. That is especially bad for cost tracking, where stale or missing data looks like a real low-cost result.

**Optimal Fix:**
Change Task 5 offline mode to: load config with `loadConfig()`, use `config.journal.path`, and pass that path to `aggregateCosts()`. Add tests for a non-default `journal.path` so the bug cannot recur.

**Why This Fix:**
It uses the existing config contract and avoids creating a second journal-path convention.

**Fix Validated:** YES — Read config schema/defaults/loader and current hardcoded log command. The configured path is already available to CLI code through `loadConfig()`.

**Validation Command:**
`rg -n "journal\\.path|~/.aisup/journal\\.jsonl|showLog|aggregateCosts" src docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

**Affected Tasks:** Task 5

---

#### ME-023: [NEW iter 19] Task 7 max-retry limit is described but not owned by config or event-type task text

**Evidence:**
- Task 7 defines `RecoveryConfig` with `auto_resume_exhausted`, `exhausted_poll_interval_s`, and `network_error_threshold` only (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:484-490`).
- The same task later says: "Add a max retry counter (default: 5) to prevent infinite loops; after max retries, stop polling and log `'recovery.exhausted_max_retries'`" (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:501`).
- Task 7's "New event types" list omits `recovery.exhausted_max_retries` (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:502`).
- HI-001 already requires config defaults for new config sections, but it cannot cover a retry field that the plan never puts in `RecoveryConfig`.

**Issue:**
The plan promises a configurable-looking max retry default and an event name, but does not assign the config field, default, validation, or event union ownership to any task.

**Impact:**
Implementers may hardcode the retry count, omit the max-retry event from `EventType`, or miss tests for the stop-after-max behavior. That weakens the safety mechanism that prevents infinite EXHAUSTED auto-resume loops.

**Optimal Fix:**
Add `max_exhausted_retries: number` to `RecoveryConfig` with default `5`, validation in `loader.ts`, defaults in `defaults.ts`, and tests in `tests/config/loader.test.ts` and `tests/recovery/exhausted.test.ts`. Add `recovery.exhausted_max_retries` to Task 7's new event types and to the consolidated event-type update from LO-004.

**Why This Fix:**
It keeps the retry policy operator-visible, testable, and consistent with the rest of Task 7's recovery config instead of hiding an important lifecycle limit in code.

**Fix Validated:** YES — The current plan text contains the max-retry behavior but no corresponding config or event-type ownership. The proposed fix follows the same schema/defaults/loader pattern already required by HI-001 and HI-006.

**Validation Command:**
`rg -n "max retry|max_exhausted|exhausted_max_retries|RecoveryConfig|recovery\\.exhausted" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md src`

**Affected Tasks:** Task 7, LO-004

---

#### ME-024: [NEW iter 19] Task 9 glob policy matching has no implementation strategy or direct dependency

**Evidence:**
- Task 9 requires allowlist/denylist "glob patterns" such as `"Read:*"`, `"Bash:git *"`, and `"Edit:src/**"` (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:585-596`).
- `package.json` has no direct glob-matching dependency such as `minimatch`, `micromatch`, or `picomatch`. `picomatch` appears only transitively in `package-lock.json`, which should not be imported as an undeclared dependency.
- The plan's Task 9 Files section does not list `package.json` or `package-lock.json`, nor does it specify a small local matcher.

**Issue:**
The plan specifies glob semantics but does not say how to implement them. JavaScript has no standard glob matcher, and the examples include `**`, which is easy to get subtly wrong with ad hoc regex conversion.

**Impact:**
Different implementers can produce incompatible policy behavior, or use a transitive dependency that may disappear when unrelated packages update. Permission policy behavior is security-sensitive enough that matching semantics need to be explicit and tested.

**Optimal Fix:**
Pick one implementation path in Task 9:

1. Add a direct dependency such as `picomatch` or `minimatch`, list `package.json` and `package-lock.json` in Task 9, and test the exact `<tool>:<detail>` matching examples; or
2. Add a local `src/permissions/glob.ts` matcher with intentionally limited semantics (`*` and `**` only), document those semantics, and test them exhaustively.

Option 1 is recommended unless the project wants to avoid new runtime dependencies.

**Why This Fix:**
It makes policy matching deterministic and reviewable instead of burying security-sensitive behavior in an implicit implementation choice.

**Fix Validated:** YES — `package.json` lacks a direct glob matcher, and Task 9's file list does not include dependency updates or a dedicated matcher module.

**Validation Command:**
`rg -n "minimatch|micromatch|picomatch|glob patterns|allowlist|denylist" package.json package-lock.json docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

**Affected Tasks:** Task 9

---

### LOW

#### LO-001: `tests/integration/` directory doesn't exist

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 1 creates `tests/integration/smoke.test.ts` but the `tests/integration/` directory doesn't exist yet. Minor — the implementer will create it. But for zero-context clarity, note it.

**Optimal Fix:**
Add a note to Task 1: "Create `tests/integration/` directory."

**Fix Validated:** YES — `ls tests/integration/` returns "No such file or directory".

**Validation Command:** `ls -d tests/integration/ 2>/dev/null || echo "needs creation"`

**Test Changes:** N/A

**Affected Tasks:** Task 1

---

#### LO-002: Task 10 — `ConfirmationStore` TTL pattern available for reuse

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
Task 10 says to "Add a `pendingPermissions: Map<string, PermissionRequest>` to `SlackService`" with TTL expiry. The existing `ConfirmationStore` class in `src/slack/commands.ts:25-56` already implements a TTL-based store with `set()`/`get()` and automatic expiry. This could be reused instead of building new TTL logic.

**Optimal Fix:**
Add a note to Task 10: "Consider reusing `ConfirmationStore` from `src/slack/commands.ts` for pending permission tracking, or extract a generic `TtlStore<T>` from it."

**Fix Validated:** YES — Read ConfirmationStore implementation. It stores payloads with expiry and auto-clears on get.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 10

---

#### LO-003: Multiple new directories need creation — plan doesn't mention any

**Status:** CONFIRMED (from iteration 2)

**Description:**
9 new directories must be created for the plan's new files:
- `src/cost/`, `src/recovery/`, `src/permissions/`, `src/gates/`
- `tests/cost/`, `tests/recovery/`, `tests/permissions/`, `tests/gates/`
- `tests/integration/`

None of these exist. While implementers usually create directories implicitly, listing them in the relevant task's Files section (e.g., "Create directory: `src/cost/`") provides explicit guidance and avoids any confusion.

**Optimal Fix:**
Add a note to the first task that creates files in each new directory: "Create `src/cost/` directory." This is Task 1 for `tests/integration/`, Task 4 for `src/cost/` and `tests/cost/`, Task 6 for `src/recovery/` and `tests/recovery/`, Task 8 for `src/permissions/` and `tests/permissions/`, Task 11 for `src/gates/` and `tests/gates/`.

**Fix Validated:** YES — Verified all 9 directories don't exist.

**Validation Command:** `ls -d src/cost src/recovery src/permissions src/gates tests/cost tests/recovery tests/permissions tests/gates tests/integration 2>&1`

**Test Changes:** N/A

**Affected Tasks:** Tasks 1, 4, 6, 8, 11

---

#### LO-004: 21 new event types proposed — plan should consolidate the `EventType` union update into a single task

**Status:** AMENDED (iteration 7) — 8 previously-missing event types now added to union; consolidation recommendation still stands

**Description:**
The plan proposes 21 new event types across Tasks 3, 6, 7, 8, 9, 11, and 12. Each task says "Modify: `src/journal/types.ts`" independently. This means `journal/types.ts` is modified 6+ times, each time adding a few event types to the `EventType` union.

While this works, it creates merge conflicts if tasks are parallelized and makes it harder to audit the complete set of new events. Since `ReadEventsOptions.type` accepts `EventType | string`, new event type strings work even before being added to the union — the union is primarily for autocomplete and type safety.

**Iteration 5 Amendment — Pre-existing EventType union drift:**
~~The `EventType` union is ALREADY out of sync with production code. 8 event types are used in `src/` but missing from the union.~~

**Iteration 7 Amendment — 8 missing types now fixed:**
The 8 event types that were missing from the `EventType` union (identified in iteration 5) have been added in commit `297fb42` (Phase 1 alignment scan). The union now includes `output_log.cursor_reset`, `output_log.rotated`, `slack.channel_created`, `slack.channel_name_collision`, `slack.connection_error`, `slack.message_ignored`, `slack.queue_dropped`, and `tmux.command_timeout`.

The 17 unused union members remain (e.g., `session.attach`, `runner.respawn_failed`, `circuit_breaker.reset`, `skill.transition`, and 13 migration/failover/telemetry types). Some may be emitted by code paths not yet verified; others appear to be forward declarations or dead entries. The "partial drift resolved" status doesn't eliminate the value of a consolidation task — adding 21 new Phase 2 types without auditing the 17 unused entries deepens the problem.

**Optimal Fix:**
Add a note to Task 0 or create a lightweight "Task 0.5" to:
1. ~~Add the 8 missing existing event types to the union~~ [RESOLVED — already done]
2. Add ALL 21 new Phase 2 event types at once:
```typescript
// Existing but missing from union
| 'output_log.cursor_reset' | 'output_log.rotated'
| 'slack.channel_created' | 'slack.channel_name_collision' | 'slack.connection_error'
| 'slack.message_ignored' | 'slack.queue_dropped'
| 'tmux.command_timeout'
// Phase 2: Cost
| 'cost.snapshot'
// Phase 2: Recovery
| 'failure.auth_detected' | 'failure.network_detected'
| 'recovery.exhausted_polling_started' | 'recovery.exhausted_resumed' | 'recovery.exhausted_polling_stopped' | 'recovery.exhausted_max_retries'
// Phase 2: Permission
| 'permission.detected' | 'permission.granted' | 'permission.denied' | 'permission.expired'
| 'permission.auto_granted' | 'permission.auto_denied' | 'permission.routed_to_slack'
| 'permission.keystroke_timeout' | 'permission.keystroke_unconfirmed'
// Phase 2: Gate
| 'gate.started' | 'gate.passed' | 'gate.failed' | 'gate.timeout' | 'gate.run_completed'
```
3. Optionally audit the 17 unused union members — remove or annotate as forward declarations

Then remove `src/journal/types.ts` from individual task File sections after the consolidated event-union task owns that edit. This is a LOW because event types work as strings even without the union, but centralizing improves DX and prevents Phase 2 tasks from repeatedly editing the same type union.

**Fix Validated:** YES — Iteration 7 re-verified: `EventType` union in `src/journal/types.ts` now includes all production event types (8 previously-missing types added in commit `297fb42`). 17 union members still absent from `grep -rn "event_type:" src/` results. Consolidation recommendation remains valid for the 21 new Phase 2 types.

**Validation Command:**
```bash
grep -rn "event_type:" src/ | grep -oP "event_type: '[^']+'" | sort -u
```

**Test Changes:** None.

**Affected Tasks:** All tasks that modify journal/types.ts

---

#### LO-005: [NEW] Task 3 — `LoopManager` has no `currentTelemetryScore` import but plan implies use in cost snapshot

**Description:**
Task 3's cost snapshot payload includes `details: { model_id, context_window_size }`. These values come from `telemetry.model?.id` and `telemetry.context_window?.context_window_size`. The `rateLimitTick` already has the `telemetry` object in scope after `readTelemetryForActiveSession()`, so these values are accessible. But the plan's `Context for Implementer` section references `currentTelemetryScore()` (used at line 170) — this is the rate-limit scoring function, NOT a cost function.

Minor confusion: a zero-context implementer might look for a cost-specific telemetry reader. The plan should clarify that cost data comes from the same `telemetry` object already read in `rateLimitTick()`, not from a separate function.

**Optimal Fix:**
Add to Task 3 Key Decisions: "Cost data (`cost.total_cost_usd`, `model.id`, `context_window.context_window_size`) comes from the same `StatuslineTelemetry` object already read by `rateLimitTick()` via `readTelemetryForActiveSession()` at line 116-122. No new telemetry reader is needed."

**Fix Validated:** YES — Confirmed `StatuslineTelemetry` has all three fields.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 3

---

#### LO-006: [NEW] Task 7 — `ExhaustedRecovery` polling cleanup not wired to daemon shutdown

**Description:**
Task 7's `ExhaustedRecovery` class uses `start(sessionId)` to begin polling (via `setInterval`) and `stop()` to end it. But the plan doesn't mention adding `exhaustedRecovery.stop()` to the daemon shutdown sequence in `daemon/index.ts`.

The daemon's graceful shutdown handler (daemon/index.ts, SIGINT/SIGTERM handler at ~line 310-331) currently calls `loopManager.stopAll()`, `slackService.stop()`, `sessionManager.stopSession()`, and `removePidFile()`. If `ExhaustedRecovery` is polling when the daemon shuts down, the interval continues running, preventing clean process exit (Node.js keeps the event loop alive for active intervals).

**Optimal Fix:**
Add to Task 7 Key Decisions: "Wire `exhaustedRecovery.stop()` into the daemon shutdown handler in `daemon/index.ts` (alongside `loopManager.stopAll()`). Store the `ExhaustedRecovery` instance in a variable accessible to the shutdown handler (same pattern as `loopManager` and `slackService`)."

**Why This Fix:**
Without shutdown cleanup, the daemon process hangs on SIGTERM when ExhaustedRecovery is polling. This is a common Node.js interval leak pattern.

**Fix Validated:** YES — Confirmed `ExhaustedRecovery` uses `start()`/`stop()` pattern implying interval. Confirmed daemon shutdown handler at daemon/index.ts doesn't reference any ExhaustedRecovery cleanup.

**Validation Command:** N/A

**Test Changes:** None — this is a wiring note.

**Affected Tasks:** Task 7

---

#### LO-007: [NEW iter 6] PRD acceptance criterion #6 says "daily/weekly" — plan uses `today/last_7d/last_30d` time windows

**Description:**
PRD acceptance criterion #6 (line 436) says: "`aisup cost` shows session/daily/weekly token and cost breakdown." The plan's `CostSummary.time_windows` (Task 4, line 377) uses `{ today: number; last_7d: number; last_30d: number }` — these are rolling windows, not calendar-based "daily/weekly" breakdowns.

Rolling windows are arguably more useful than calendar-based breakdowns for a supervisor tool (you want "how much did I spend in the last 7 days" not "cost per week starting Monday"). But the PRD says "daily/weekly" which could mean per-day/per-week itemized summaries.

The plan also defers "Daily/weekly Slack cost summaries" (line 39, 772) — these are Slack-posted summaries, which is a different feature from the `aisup cost` time windows. The plan partially satisfies the PRD criterion via time windows but doesn't exactly match the "daily/weekly" language.

**Optimal Fix:**
Add a note to Task 4 Key Decisions: "PRD acceptance criterion #6 asks for 'daily/weekly' breakdown. Implemented as rolling time windows (`today`, `last_7d`, `last_30d`) which provide equivalent cost visibility. Per-day and per-week itemized breakdowns deferred — same data can be computed from `cost.snapshot` journal events if needed."

This acknowledges the PRD language, explains the design choice, and documents the path to exact compliance if wanted later.

**Fix Validated:** YES — Confirmed PRD line 436 says "session/daily/weekly token and cost breakdown". Confirmed plan's CostSummary has `time_windows: { today, last_7d, last_30d }`.

**Validation Command:** N/A

**Test Changes:** None.

**Affected Tasks:** Task 4, Task 5

---

#### LO-008: [NEW iter 10] Task 1 telemetry documentation artifact is in DoD but missing from the Files section

**Evidence:**
- Task 1 Files lists only `tests/integration/smoke.test.ts` as a created file (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:254-256`).
- Task 1 Definition of Done requires telemetry fields to be documented in `tests/integration/TELEMETRY_FIELDS.md` (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:271`).

**Issue:**
The plan requires a second artifact but does not list it in Task 1's Files section.

**Impact:**
A zero-context implementer can complete the listed file changes and still miss a Definition of Done artifact that records whether `cost.total_cost_usd` and permission prompt assumptions were validated.

**Optimal Fix:**
Add `tests/integration/TELEMETRY_FIELDS.md` (create) to Task 1's Files section with a note that it records observed statusline fields, whether `cost.total_cost_usd` was present, and whether permission prompt output was validated or explicitly not tested due bypass mode.

**Why This Fix:**
It aligns the task's artifact list with its Definition of Done and keeps assumption evidence close to the integration test.

**Fix Validated:** YES — The mismatch is explicit in the plan text.

**Validation Command:**
`rg -n "TELEMETRY_FIELDS|tests/integration/smoke.test.ts" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

**Affected Tasks:** Task 1

---

### INFO

#### IN-001: `SkillTracker` class exists but is unused — potential reuse for Task 12

**Status:** CONFIRMED (unchanged from iteration 1)

**Description:**
`src/skills/tracker.ts` exports a `SkillTracker` class with `processOutput()`, `activeSkill` property, and `onTransition` callback — and importantly, a `reset()` method that clears `activeSkill` to null. The loop manager currently uses `detectSkill()` directly instead of `SkillTracker`. If Task 12 adopts Option A from CR-003 (clear active_skill after gate run), the `SkillTracker` class with its transition callback could provide the infrastructure.

**Affected Tasks:** Task 12

---

#### IN-002: Phase 2 plan scope mostly matches PRD + adds justified extras

**Status:** AMENDED (iteration 6) — "correctly matches" downgraded to "mostly matches" due to ME-015 (RC reconnect omission)

**Description:**
The plan covers most PRD Phase 2 features (D₂, F, H₁, K) and adds:
- Approval routing (Slack approve/deny) — listed in PRD under Feature F description, correctly scoped
- Rehydration automatic recovery — gap identified between Phase 1 detection-only and Phase 2 needs
- PRD reconciliation (Task 0) — necessary maintenance

All additions are justified and within the spirit of Phase 2. One D₂ sub-feature ("remote-control reconnect") is silently omitted — see ME-015.

**Affected Tasks:** All

---

#### IN-003: [NEW iter 5] `readEvents()` reads entire journal file into memory — scaling consideration for Phase 2

**Description:**
`src/journal/reader.ts:8-25` reads the full journal file into memory (`readFile(journalPath, 'utf8')`), splits by newlines, parses every line as JSON, then filters. Phase 2 adds `cost.snapshot` events every ~5 minutes per active session (up to 288/day per session). Combined with existing event types, journal files will grow faster in Phase 2.

Current behavior is fine for small journals, but Task 4's cost aggregation (`aggregateCosts()`) will call `readEvents()` on potentially large files — especially for `--since <date>` queries spanning days or weeks of accumulated data.

This is NOT a plan bug — it's a pre-existing architectural limitation that Phase 2's increased event volume makes more relevant. No action required for this plan; worth noting for future optimization (streaming reader, index, or journal rotation).

**Affected Tasks:** Task 4, Task 5

---

#### IN-004: [NEW iter 6] Phase 1 compliance addendum issues remain unfixed in codebase

**Description:**
The 4 Phase 1 compliance findings (P1-CR-001, P1-CR-002, P1-CR-003, P1-HI-001) from the 2026-05-13 addendum are still present in the current codebase:

- Account scorer (`scoreAccount`/`selectBestAccount`) is not wired into daemon server session start or failover target selection (P1-CR-001 confirmed).
- The pre-switch no-target branch in `daemon/index.ts` does not persist `EXHAUSTED`, does not clear `switch_tx`, and does not emit `session.exhausted` (P1-CR-002 confirmed). Current evidence also shows the separate post-switch all-targets-failed path in `performSwitch()` already persists `EXHAUSTED` and emits `session.exhausted`, so the required fix is only for the pre-switch no-target branch.
- Failed transcript migration still passes `claudeSessionId` to target creation (P1-CR-003 confirmed).
- Mid-switch rehydration still lacks switch/restart callbacks and remains manual for `source_destroyed`, `migrating`, and `creating` phases (P1-HI-001 confirmed).

The Phase 1 compliance addendum states "Phase 2 should not start until these Phase 1 blockers are fixed and re-reviewed." This gate condition remains unmet. Phase 2 implementation on top of these unfixed Phase 1 issues will compound the problems — especially Task 7 (EXHAUSTED auto-recovery) which directly depends on P1-CR-002's fix.

This is informational — the addendum and full Phase 1 audit below document the required fixes. This note was refreshed on 2026-05-27 to avoid the stale blanket claim about `session.exhausted` emission.

**Affected Tasks:** All Phase 2 tasks (blocked by Phase 1 gate)

---

## Phase 1 Compliance Addendum - 2026-05-13

**Source of truth:** `docs/plans/2026-04-29-aisup-supervisor-daemon.md`
**Phase 1 alignment context:** `docs/plans/2026-05-07-phase1-alignment-scan.md`
**Status:** ISSUES_FOUND
**Gate:** Phase 2 should not start until these Phase 1 blockers are fixed and re-reviewed.

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 3 | Phase 1 behavior violates the source implementation plan or can launch incorrect runtime state |
| HIGH | 1 | Crash-recovery gap that can leave sessions requiring manual repair |

### Phase 1 Findings

#### P1-CR-001: Account scoring and eligibility are not wired into daemon account selection

**Description:**
The source plan requires account selection to read statusline usage, score accounts by remaining headroom, and choose the highest-scoring eligible account. Phase 1 implementation added scoring helpers, but the daemon does not use them for session admission or failover target refresh.

**Evidence:**
- `src/daemon/server.ts:106-108` selects the start account by `priority` and only excludes `UNAVAILABLE`; it does not call `scoreAccount()` or `selectBestAccount()`, and it can select a `COOLDOWN` account.
- `src/accounts/scorer.ts` defines `scoreAccount()` and `selectBestAccount()`, and `src/accounts/registry.ts` defines `setScore()` / `applyTelemetry()`, but repository search shows those update paths are not used by production daemon selection code.
- `src/daemon/loop-manager.ts:168` and `src/daemon/loop-manager.ts:197` pass registry account scores into `selectSwitchTarget()`, but the registry scores are initialized as `null` and are not refreshed from each account's telemetry before soft-threshold target selection.
- `src/failover/switcher.ts:207-210` adds automatic retry targets with `a.enabled && a.state !== 'UNAVAILABLE'`, which includes `COOLDOWN` accounts even though automatic selection should only use runnable eligible accounts.

**Impact:**
`aisup start` can choose a lower-headroom priority account, soft-threshold failover can miss a better target because target scores are stale/null, and automatic failover retry can launch into a cooldown account. This violates the Phase 1 account registry/scoring contract and can produce the wrong runtime account before Phase 2 begins.

**Required Fix Before Phase 2:**
Add a single account scoring/eligibility refresh path and use it for start admission, `/api/sessions` start, rate-limit failover decisions, and automatic target retry. Refresh registry account scores/states from telemetry and circuit-breaker state, use the canonical scorer/selector for runnable accounts, and ensure `COOLDOWN` requires explicit manual override instead of automatic selection.

**Validation Required:**
Add tests proving that a lower-priority account with a better score is selected, stale/null target scores are refreshed before soft failover, `COOLDOWN` is not selected automatically, and restored circuit-breaker state affects eligibility.

**Affected Phase 1 Tasks:** Source plan Task 5, Task 7, Task 8; alignment scan Tasks 1, 8, 13, 15

---

#### P1-CR-002: Hard-threshold/no-target failover path does not persist EXHAUSTED state

**Description:**
The source plan requires hard threshold, live 429, or destroyed-source failover with no runnable target to emit `session.exhausted`, write terminal `failover.no_target_available`, set the session state to `EXHAUSTED`, and preserve the logical session. The daemon callback path that runs before `performSwitch()` does not do this.

**Evidence:**
- `src/daemon/index.ts:177-194` handles the no-target case in `onSwitch()` by appending a terminal `failover.no_target_available` event and returning.
- That branch does not call `sessionManager.patchState(..., { status: 'EXHAUSTED' })`, does not clear `switch_tx`, and does not emit `session.exhausted`.
- `src/failover/switcher.ts:294-329` does persist `EXHAUSTED`, but only after `performSwitch()` has already started and all target attempts fail. It does not cover the pre-switch no-target branch in `daemon/index.ts`.

**Impact:**
A hard limit, live 429, source-dead recovery, or circuit-breaker failover with no eligible target can leave the session recorded as active while also writing a terminal no-target event. The daemon can keep retrying the same impossible failover and operators do not get the planned preserved `EXHAUSTED` session state.

**Required Fix Before Phase 2:**
In `daemon/index.ts` no-target handling, distinguish soft-threshold no-better-target from terminal failover reasons. For hard threshold, live 429, source destroyed, restart-required, and circuit-breaker reasons, patch the session to `EXHAUSTED`, clear `switch_tx`, emit `session.exhausted`, update in-memory server state, and notify Slack if configured. Keep soft-threshold no-better-target nonterminal.

**Validation Required:**
Add deterministic daemon/loop tests for hard-threshold no target and live-429 no target producing `EXHAUSTED` plus both journal events, and a separate soft-threshold no-better-target test proving the session remains active.

**Affected Phase 1 Tasks:** Source plan Task 7, Task 8; alignment scan Tasks 2, 6, 8, 10

---

#### P1-CR-003: Failed transcript migration can still launch target with `--resume`

**Description:**
The source plan requires resume mode only when `claude_session_id` is non-null and the transcript file was successfully migrated to the target account. If the transcript is missing, invalid, or fails integrity checks, the target must launch fresh and record fresh launch mode. The current switch path catches migration failure but still passes the original `claudeSessionId` to target creation callbacks.

**Evidence:**
- `src/failover/switcher.ts:161-199` catches `migrateTranscript()` failures and logs `migration.invalid_path`, but it does not clear `snapshot.claudeSessionId` or otherwise communicate that resume is unsafe.
- `src/daemon/index.ts:212-215` and `src/daemon/server.ts:219-223` decide whether to use `buildResumeCommand()` solely from `snapshot.claudeSessionId`.
- A one-off reproduction with `performSwitch()` and a missing transcript path showed the target creation callback still received the original Claude session id after migration failed.

**Impact:**
Failover can launch Claude with `--resume <id>` in a target account that does not have the migrated transcript. That can fail, resume the wrong state, or create misleading session continuity after Phase 1 claims a preserved switch.

**Required Fix Before Phase 2:**
Make transcript migration produce an explicit launch decision. Permit resume only when `claudeSessionId` exists and migration succeeded or was already valid in the target account. For null, missing, invalid, or integrity-failed transcripts, log the appropriate migration event and invoke target creation in fresh mode, with `launch_mode: fresh` recorded in switch/journal details.

**Validation Required:**
Add a failover test where the source snapshot has `claudeSessionId` plus a missing transcript path and assert that target creation receives no resume id / uses fresh launch mode. Add a second test proving successful migration still resumes.

**Affected Phase 1 Tasks:** Source plan Task 7; alignment scan Tasks 6, 10

---

#### P1-HI-001: Switch transaction rehydration still requires manual recovery for mid-switch phases

**Description:**
The source plan requires durable switch transaction recovery after daemon restart, including continuing or completing recovery from `source_destroyed`, `migrating`, `creating`, and `resuming` phases. The current rehydration path remains manual/detection-only for several of the dangerous phases.

**Evidence:**
- `src/daemon/rehydration.ts:12-18` defines `RehydrationDeps` without switch/restart callbacks, so rehydration has no way to continue target creation or restart work for incomplete phases.
- `src/daemon/rehydration.ts:80-85` handles `source_destroyed` by destroying stale source tmux and logging `recovery.failed` / `needs_manual_failover`; it does not continue migration or create the target.
- `src/daemon/rehydration.ts:88-115` can mark `resuming` successful when the target tmux is alive, but `migrating`/`creating` with a dead or missing target logs `needs_manual_failover` instead of retrying, advancing, or exhausting deterministically.

**Impact:**
A daemon restart after source teardown but before target creation can leave a logical session in a partially switched state that requires manual repair. That violates the Phase 1 durability requirement and risks making Phase 2 features depend on inconsistent session state.

**Required Fix Before Phase 2:**
Extend rehydration to perform corrective recovery for every persisted switch phase. Either inject switch/restart callbacks into rehydration or extract a shared recovery action that can continue from `source_destroyed`, validate/retry `migrating`, retry/verify `creating`, and finalize or exhaust `resuming`. Recovery must write canonical journal events and clear or advance `switch_tx` deterministically.

**Validation Required:**
Add rehydration tests for `source_destroyed`, `migrating`, `creating`, and `resuming` states, covering both recoverable target creation and no-target exhaustion.

**Affected Phase 1 Tasks:** Source plan Task 7, Task 8; alignment scan Tasks 1, 6, 9, 10

### Phase 1 Audit Methodology

**Approach:** Audited the Phase 1 implementation against the original supervisor daemon source plan and the Phase 1 alignment scan, using the current repository state as implementation evidence. Existing Phase 2 review content was preserved; this addendum only adds Phase 1 gates that must be fixed before Phase 2 starts.

**Files and areas inspected:**
- `docs/plans/2026-04-29-aisup-supervisor-daemon.md`
- `docs/plans/2026-05-07-phase1-alignment-scan.md`
- `docs/handoff/handoff-2026-05-12T17-41-31.md`
- `src/daemon/index.ts`
- `src/daemon/server.ts`
- `src/daemon/loop-manager.ts`
- `src/daemon/rehydration.ts`
- `src/failover/switcher.ts`
- `src/accounts/scorer.ts`
- `src/accounts/registry.ts`
- `src/accounts/circuit-breaker.ts`
- `src/statusline/store.ts`
- `src/slack/service.ts`
- focused tests under `tests/failover/`, `tests/daemon/loops/`, `tests/statusline/`, `tests/slack/`, and `tests/cli/`

**Automated checks run:**
- `npm run typecheck` -> passed
- `npx vitest run tests/failover/ tests/daemon/loops/ tests/statusline/ tests/daemon/server.test.ts tests/slack/ tests/cli/` -> passed, 164 tests
- `npm test` -> passed, 273 tests passed and 11 skipped; tmux-backed session tests were skipped by the test harness because the sandbox could not connect to the tmux socket
- Repository search for account scorer usage showed scoring helpers and registry score mutation are not wired into production daemon account selection
- A targeted `performSwitch()` reproduction with a missing transcript confirmed the target creation callback still receives the original Claude session id after migration failure

## Review Methodology

### Iteration 19 (this review — cohesion and full validation refresh)

**Approach:** Nineteenth pass performed after an operator request for a full implementation-plan/review validation. Re-read the Phase 2 implementation plan and this review artifact completely. Re-checked active Phase 2 findings, representative source-plan line references, the Phase 1 compliance audit, and the stale/superseded finding history against current source at HEAD `297fb42`. Focused specifically on document cohesion after many prior LLM iterations: active counts, stale claims, conflicting fixes, missing task ownership, and old historical text that could mislead a future implementer.

**New findings discovered:** 4 (ME-021, ME-022, ME-023, ME-024)
**Amendments to prior findings:** 5 (HI-005 fix aligned with HI-012; ME-002/ME-012 line references refreshed; LO-003/LO-004 wording corrected; IN-004 EXHAUSTED evidence corrected)
**Prior findings re-verified:** Active Phase 2 CRITICAL/HIGH findings and the full Phase 1 compliance finding set remain supported by current source evidence.

**Key confirmations in iteration 19:**
- CR-005 remains correctly superseded: `performSwitch()` persists `EXHAUSTED` and emits `session.exhausted`; CR-006 is the active restart/re-arm gap.
- ME-019 remains correctly rejected: `createSession()` ignores `accountConfigDir`; the real recovery risk remains HI-004/P1-FULL-004 callback/env construction.
- HI-005 and HI-012 no longer conflict: shell-free gate execution with split executable/args is the recommended fix.
- The Phase 1 addendum and full Phase 1 audit now use the same EXHAUSTED framing: pre-switch no-target path is broken; post-switch all-targets-failed path is already implemented in `performSwitch()`.
- The Phase 2 plan has four additional medium gaps: `aisup log --type` is referenced but unassigned; cost offline mode hardcodes the default journal path; exhausted max retry config/event ownership is missing; permission glob matching lacks a direct dependency or local matcher contract.

**Verification performed:**
- Full reads of the Phase 2 implementation plan and review artifact.
- Targeted source reads of `src/daemon/rehydration.ts`, `src/daemon/loop-manager.ts`, `src/daemon/index.ts`, `src/daemon/server.ts`, `src/config/*`, `src/slack/*`, `src/failover/*`, `src/session/*`, `src/statusline/*`, `src/journal/*`, `src/cli/commands/{log,start,attach}.ts`, and `src/accounts/*`.
- Source-plan checks against `docs/plans/2026-04-29-aisup-supervisor-daemon.md`, `docs/plans/2026-05-07-phase1-alignment-scan.md`, and `docs/handoff/handoff-2026-05-12T17-41-31.md`.
- `rg` checks for Phase 2 artifact paths, CLI log/type support, configured journal-path usage, glob dependencies, EXHAUSTED persistence/rehydration, Slack dispatch handlers, config defaults/loader return sections, and host-gated markers.
- `npm run typecheck` — passed.
- `npm test` — passed: 273 tests passed, 11 tmux-backed tests skipped because the sandbox could not connect to the tmux socket, 0 failed.

**Conclusion:** The review document is now internally cohesive after correcting stale historical contradictions and adding the missing medium findings. The implementation plan remains `FIX_AND_RE_REVIEW`. Phase 2 should not begin until the 5 CRITICAL and 14 HIGH Phase 2 findings are corrected and the Phase 1 CRITICAL/HIGH compliance gates are resolved or explicitly deferred by the owner.

### Iteration 18 (prior — Phase 2 plan refresh and stale medium correction)

**Approach:** Eighteenth pass against HEAD `297fb42` and the current dirty worktree. Re-read the Phase 2 plan, existing review artifact, PRD Phase 2 scope, Phase 1 alignment scan excerpts, handoff notes, and current source boundaries for daemon rehydration, loop-manager scanning, failover, config/defaults, Slack command dispatch, statusline telemetry, session restart/tmux environment construction, CLI attach, and test gating. Re-checked all active CRITICAL and HIGH Phase 2 findings and representative medium/low findings. Performed a targeted stale-finding audit for the empty `accountConfigDir` claim after noticing it conflicted with P1-FULL-007.

**Key source evidence refreshed:**
- `src/daemon/rehydration.ts` — pipe-pane restore, switch-tx recovery phases, no EXHAUSTED recovery/re-arm
- `src/daemon/loop-manager.ts` — active-session filtering, sticky `active_skill`, idle callback, output scan cursor ordering, restart counters
- `src/daemon/index.ts` — rehydration before loop startup, `onIdle` journal-only handler, `onSwitch`/`onRestart` callbacks, shutdown cleanup
- `src/daemon/server.ts` — route registration and `DaemonServerOptions` shape
- `src/session/manager.ts` and `src/session/tmux.ts` — `restartInPlace()` fallback and actual env propagation
- `src/config/schema.ts`, `src/config/loader.ts`, `src/config/defaults.ts` — explicit returned config sections and defaults typing
- `src/accounts/circuit-breaker.ts` — non-exported `CBState`, `getState()`/`getCooldownEta()` behavior
- `src/slack/commands.ts` and `src/slack/service.ts` — `KNOWN_COMMANDS`, `dispatchCommand()` cases, tmux keystroke patterns
- `src/statusline/store.ts` and `src/statusline/types.ts` — telemetry cost fields and identity checks
- `src/journal/types.ts` and `src/journal/reader.ts` — event union and journal filtering
- `src/cli/commands/attach.ts`, `src/cli/index.ts`, and tests under `tests/session`, `tests/slack`, `tests/daemon`, `tests/statusline`

**Commands run:**
- `git status --short`
- `git rev-parse --short HEAD`
- `git diff --stat`
- `rg --files`
- `rg -n '^#### |^### |^## |^\\*\\*Recommendation|^\\*\\*Total active|Iteration 17|Review Methodology|Phase 1 compliance' docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
- `rg -n "requires_tmux|requires_slack|requires_claude|AISUP_INTEGRATION|describe\\.skip|it\\.skip|test\\.skip|tmux" tests vitest.config.ts package.json`
- `rg -n "cost\\.snapshot|permission\\.|gate\\.|ExhaustedRecovery|AuthFailure|NetworkError|recovery\\.exhausted|auto_resume_exhausted|PermissionsConfig|GatesConfig|aggregateCosts|src/cost|src/gates|src/permissions|src/recovery" src tests docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
- `rg -n "Phase 2|Feature D|Feature F|Feature H|Feature K|Approval|node-pty|events\\.jsonl|sleep until|installs its own hook|Slack Remote Control|Event Journal|daily|weekly|reconnect|Remote" docs/prd/2026-04-29-ai-supervisor.md`
- `rg -n "accountConfigDir|createSession\\(|createTmuxSession\\(|buildResumeCommand|buildLaunchCommand" src/session/manager.ts src/session/tmux.ts src/daemon/index.ts`
- Targeted `sed`/`nl -ba` reads of all files listed in the key source evidence above
- `npm run typecheck` — passed
- `npm test` — passed: 273 tests passed, 11 tmux-backed tests skipped, 0 failed

**Findings result:** No new Phase 2 findings were added. ME-019 was rejected as unsupported because `createSession()` does not use `accountConfigDir` to derive the tmux env; active concern remains HI-004. Active count changed from 51 to 50.

**Conclusion:** The plan remains `FIX_AND_RE_REVIEW`: implementation should not start until the 5 CRITICAL and 14 HIGH Phase 2 findings are corrected, and the Phase 1 compliance gates are resolved or explicitly deferred with owner approval.

### Iteration 17 (prior — Phase 2 plan refresh and stale finding correction)

**Approach:** Seventeenth pass focused on refreshing the Phase 2 plan review against the current workspace. Re-read the full Phase 2 implementation plan, the existing review artifact, relevant PRD Phase 2 scope lines, Phase 1 alignment-scan recovery/exhaustion context, and the handoff notes that call out prior plan-review blockers. Re-read the source boundaries most affected by the critical/high findings: daemon startup, rehydration, loop-manager ticks, switcher exhaustion, session state filtering, config defaults/loading, circuit breaker state, Slack command routing, daemon API routes, journal event types, statusline telemetry, CLI attach/start registration, and test harness markers.

**New active findings discovered:** 1 (CR-006)
**Findings superseded:** 1 (CR-005)
**Net active finding count change:** 0

**Key confirmations in iteration 17:**
- `performSwitch()` now persists `EXHAUSTED` and emits `session.exhausted` in `src/failover/switcher.ts:311-327`; the old CR-005 persistence claim is stale.
- The restart durability issue remains active because Task 7 only starts `ExhaustedRecovery` when the current daemon observes `performSwitch()` returning `exhausted`, while `rehydrateSessions()` has no `EXHAUSTED` branch and `getActiveSession()` excludes exhausted sessions.
- CR-001 through CR-004 and all HIGH findings remain supported by current plan text and source evidence.
- The PRD still lists D2 recovery, permission broker, approval routing, validation gates, and cost tracking as Phase 2 scope, and still lists RC reconnect in the D2 feature line; ME-015 remains valid.

**Verification performed:**
- `git status --short --branch` -> `main...origin/main [ahead 3]`, dirty `.gitignore`, Phase 1 alignment scan doc, untracked Phase 2 plan/review/handoff artifacts.
- `npm run typecheck` -> passed.
- `npx vitest run tests/daemon/rehydration.test.ts tests/daemon/loops/loop-manager.test.ts tests/failover/switcher.test.ts tests/config/loader.test.ts tests/slack/commands.test.ts tests/slack/service.test.ts tests/daemon/server.test.ts tests/journal/reader.test.ts` -> passed, 83 tests.
- `npx vitest run` -> passed, 273 tests passed, 11 skipped, 0 failed; tmux-backed session tests skipped after local socket "Operation not permitted".
- Targeted `rg` searches over the Phase 2 plan, PRD, Phase 1 plan/alignment scan, handoff, and source files for EXHAUSTED persistence/rehydration, recovery callbacks, gate trigger state, Slack dispatch cases, config/defaults return wiring, cost snapshot fields, integration-test gating, and attach behavior.

**Limits:** No live daemon, Claude, Slack, or tmux integration run was performed. The tmux-backed unit integration tests were attempted by the full suite but skipped by their harness because this sandbox cannot connect to the tmux socket.

---

### Iteration 16 (prior — full Phase 1 compliance re-audit, sixth independent auditor session)

**Approach:** Sixteenth pass — sixth independent full Phase 1 compliance re-audit against HEAD `297fb42` and the current dirty docs-only worktree. Re-read the source plan, the Phase 1 alignment scan, the current P1-FULL audit section, AGENTS.md rules, and the source/test boundaries that implement daemon startup, account selection, failover, rehydration, telemetry binding, Slack, CLI observability, doctor checks, and runbook/operator behavior. Built a fresh private trace of the material Phase 1 requirements and validated existing findings before retaining them.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** All 15 current P1-FULL findings remain valid and unfixed against HEAD `297fb42`

**Key confirmations in iteration 16:**

- **P1-FULL-001 (scoring wiring):** `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon src/failover src/cli src/accounts` shows scoring helpers only in `src/accounts/*`; daemon/server/failover/CLI production paths still do not call them. `src/daemon/server.ts:106-108` and `src/cli/commands/start.ts:69-71` still select by priority.
- **P1-FULL-002 (EXHAUSTED persistence):** `src/daemon/index.ts:177-194` still returns after a no-target event without `patchState(..., { status: 'EXHAUSTED' })` or `session.exhausted`, and still hardcodes `terminal: true` for all no-target reasons including soft-threshold.
- **P1-FULL-003 (resume after failed migration):** `src/failover/switcher.ts:191-198` still catches migration errors without clearing `snapshot.claudeSessionId`; target launch callbacks in `src/daemon/index.ts:213-215` and `src/daemon/server.ts:221-223` still choose resume solely from `snapshot.claudeSessionId`.
- **P1-FULL-004 (rehydration callbacks):** `src/daemon/rehydration.ts:12-18` still has no `onSwitch`, `onRestart`, account registry, config, or runner deps. `source_destroyed`, `migrating`, and `creating` recovery paths still log `needs_manual_failover`.
- **P1-FULL-005 (idle session.stop):** `src/daemon/index.ts:149-156` still emits `session.stop` for idle detection without stopping the session, and `src/daemon/loop-manager.ts:227-233` still calls it on every idle tick.
- **P1-FULL-006 (alignment scan progress):** Alignment scan progress remains stale: `rg -n "^- \\[[ x]\\]"` counts `139` task checkboxes, all unchecked; the header still says `Completed: 0 | Remaining: 16`.
- **P1-FULL-008 (COOLDOWN retry):** `src/failover/switcher.ts:207-210` still admits automatic retry targets with `a.state !== 'UNAVAILABLE'`, allowing `COOLDOWN`.
- **P1-FULL-009 (onSwitch soft-threshold bypass):** `src/daemon/index.ts:177` still calls `selectSwitchTarget(accounts, state.account, [])` without `reason` or `currentScore`, bypassing the soft-threshold "better target" guard.
- **P1-FULL-010 (journal detail contract):** Migration events in `src/failover/switcher.ts:181-196` still omit required target path/size/hash fields and safe reason enums. `src/statusline/store.ts` still parses invalid JSON to `null` without emitting `telemetry.invalid_json`.
- **P1-FULL-011 (EXHAUSTED rehydration):** `src/daemon/rehydration.ts:153-206` still has no persisted `EXHAUSTED` branch, while `/api/status`, `/api/failover`, and DELETE `/api/sessions` still depend on in-memory `sessionState`.
- **P1-FULL-012 (stale observability):** `/api/status` still returns cached `sessionState`, `aisup log` still hardcodes `~/.aisup/journal.jsonl`, and online `/api/accounts` still omits required usage/model/cooldown/health visibility.
- **P1-FULL-013 (Slack edge contracts):** `src/slack/service.ts:88-101` still does not emit `slack.channel_name_collision` on actual `name_taken`; relay still has no Slack 429 `Retry-After`/`slack.rate_limited` path; `!stop` still bypasses canonical `session.stop` event emission and `onSessionStop()`.
- **P1-FULL-014 (live recovery):** `src/daemon/loop-manager.ts:254` still calls only `isProcessDead()`; no `tmux has-session`/missing-session distinction exists before dead-pane handling.
- **P1-FULL-015 (telemetry identity):** `src/statusline/types.ts` still has no `workspace.project_dir`; `src/statusline/store.ts:108-113` and `130-147` still accept candidates with no cwd identity.
- **P1-FULL-016 (restart counter):** `src/daemon/loop-manager.ts:344-366` still checks the restart threshold before incrementing the current failure and never clears restart counters after successful restart.

**Compliant areas re-checked (no new issues found):**
- Alignment scan fixes still present: switch_tx persistence, `buildResumeCommand`, `restartInPlace()`, attach `-L aisup`, output log rotation, doctor statusline/model/cost diagnostics, offline status, Slack output relay, live 429 scanning, skill detection, `status --json`, `/api/events`, `stop --force`, Slack lifecycle wiring, circuit breaker construction, runner validation, daemon readiness after loop registration.
- Source-plan basics still present: `crypto.randomUUID()` session identity, shell-free tmux subprocess calls through `execFileSync` argument arrays, configured `runner.config_dir_env`, recursive journal secret-key rejection, and `session.stop` absence from failover switcher paths.

**Verification performed:**
- `git rev-parse --short HEAD` → `297fb42`
- `git diff --stat` → dirty files before this update were only `.gitignore` and `docs/plans/2026-05-07-phase1-alignment-scan.md`
- `git diff --stat -- src tests package.json` → no implementation source/test/package changes
- `npm run typecheck` → passed
- `npm test` → passed: `273 passed`, `11 skipped`, `0 failed` (`tests/session/tmux.test.ts` and `tests/session/manager.test.ts` skipped after tmux socket "Operation not permitted")
- Targeted `rg` searches documented in the Full Phase 1 audit methodology were re-run for all 15 current P1-FULL findings

**Conclusion:** All 15 Phase 1 compliance issues remain unfixed. No new Phase 1 compliance issues were found. The Phase 1 compliance gate remains: Phase 2 must not start until all 3 CRITICAL and 8 HIGH issues are resolved. Recommendation: FIX_AND_RE_AUDIT.

---

### Iteration 15 (prior — full Phase 1 compliance re-audit, fifth independent auditor session)

**Approach:** Fifteenth pass — fifth independent full Phase 1 compliance re-audit by a separate auditor session against HEAD `297fb42`. Read the full source plan (Tasks 1–14, 1143 lines), the alignment scan plan (16 tasks, 766 lines), and the existing review artifact (all P1-FULL findings). Built a private trace matrix for each Phase 1 task's material requirements against the current implementation. Systematically verified all 15 current P1-FULL findings through targeted `rg` searches and source reads. Conducted a full compliance trace across Tasks 1–14 for any gaps not already captured. Independently confirmed alignment scan implementation status.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** All 15 current P1-FULL findings confirmed unfixed against HEAD `297fb42`

**Key confirmations in iteration 15:**

- **P1-FULL-001 (scoring wiring):** `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon/ src/failover/ src/cli/` → 0 matches. `src/daemon/server.ts:106-108` uses `.sort((a, b) => a.priority - b.priority).find(...)` — priority-only, no scoring.
- **P1-FULL-002 (EXHAUSTED persistence):** `rg -n "patchState.*EXHAUSTED|session\.exhausted" src/daemon/index.ts` → 0 matches. `daemon/index.ts:185` hardcodes `terminal: true` for ALL no-target cases including soft-threshold. No `patchState(..., { status: 'EXHAUSTED' })` call.
- **P1-FULL-003 (resume after failed migration):** `src/failover/switcher.ts:191-198` catch block does not clear `snapshot.claudeSessionId`. Line 237 passes original `snapshot` to `createSessionForTarget`. `daemon/index.ts` resume decision based solely on `snapshot.claudeSessionId`. Also: `migration.skipped_no_transcript` event type exists in union but is never emitted when `transcriptPath` is null.
- **P1-FULL-004 (rehydration callbacks):** `rg -n "onSwitch|onRestart|restartInPlace" src/daemon/rehydration.ts` → 0 matches. `RehydrationDeps` still lacks recovery callbacks. `ACTIVE`/`SWITCH_PENDING_AT_IDLE` without tmux emits event only; no restart/recovery.
- **P1-FULL-005 (idle session.stop):** `daemon/index.ts:152` emits `session.stop` with reason `idle_timeout`. No once-only guard — fires on every idle tick.
- **P1-FULL-006 (alignment scan progress):** All 139 checkboxes in the alignment scan plan remain unchecked (`grep -c "^\- \[ \]"` → 139, `grep -c "^\- \[x\]"` → 0). `Completed: 0 | Remaining: 16` header unchanged despite substantial implementation in commit `297fb42`.
- **P1-FULL-008 (COOLDOWN retry):** `switcher.ts:209` filters `a.state !== 'UNAVAILABLE'`, allowing COOLDOWN accounts through automatic retry.
- **P1-FULL-009 (onSwitch soft-threshold bypass):** `daemon/index.ts:177` calls `selectSwitchTarget(accounts, state.account, [])` with NO `opts` parameter. The soft-threshold "better target" guard never fires at actual switch time.
- **P1-FULL-010 (journal detail contract):** Migration events still lack `target_path`, `source_size`, `target_sha256`. `migration.invalid_path` details remain `{ error: String(err) }`. `telemetry.invalid_json` exists in type union but is never emitted by `src/statusline/store.ts`.
- **P1-FULL-011 (EXHAUSTED rehydration):** No EXHAUSTED branch in `rehydrateSessions()`. Persisted EXHAUSTED sessions invisible to online API after restart.
- **P1-FULL-012 (stale observability):** `/api/status` returns cached in-memory `sessionState`. `aisup log` hardcodes `~/.aisup/journal.jsonl` (line 8) ignoring configured `journal.path`. Online `/api/accounts` returns only name/state/score/priority/enabled.
- **P1-FULL-013 (Slack edge contracts):** `!stop` at `service.ts:232` calls `sessionManager.stopSession()` directly — no `session.stop` journal event, no `onSessionStop()` callback. Compare with server DELETE at `server.ts:149-156` which does both.
- **P1-FULL-014 (live recovery):** No `has-session` check before `isProcessDead()` in `recoveryTick()` at `loop-manager.ts:254`.
- **P1-FULL-015 (telemetry identity):** `statusline/types.ts` has no `workspace` or `project_dir` field. Pre-hydration scanning at `store.ts:130-147` accepts candidates without cwd identity when `t.cwd` is absent.
- **P1-FULL-016 (restart counter):** `loop-manager.ts:348` evaluates `count >= MAX_RESTARTS_BEFORE_SWITCH` BEFORE incrementing at line 363 (4 dead-tick observations before escalation instead of 3). Line 366 `await d.onRestart(...)` has no success/failure signal; counter is never reset on successful restart.

**Compliant areas verified (no issues found — independent confirmation):**
- Config: file permissions 0700/0600 throughout, path NUL/newline validation, account name restriction
- Session: four-step tmux launch, `execFileSync` with argument arrays throughout `tmux.ts`, `tmuxWithTimeout` with 5s timeouts, `singleQuote` shell escaping, atomic state writes (tmp+rename)
- Runner: absolute path resolution via `validateRunner()` at daemon startup, `singleQuote` escaping at tmux boundary, `config_dir_env` usage (not hardcoded)
- Circuit breaker: constructed at `daemon/index.ts:42-44`, passed to loop-manager deps
- Daemon startup: `loopManager.startAll()` → `server.setReady()` → `daemon.ready` → Slack async non-blocking
- Failover: `runner.terminated_for_switch` emitted by switcher; `session.stop` never emitted by switcher
- Attach: uses `-L aisup` socket
- Identity: `crypto.randomUUID()` for `aisup_session_id`
- switch_tx: persistence via `persistTx()` at each phase transition
- Resume: `buildResumeCommand` when `claudeSessionId` available
- `restartInPlace`: wired in `onRestart` callback
- Output log rotation: `rotateOutputLogIfNeeded()` + `output_log.rotated` emission

**Verification performed:**
- `git rev-parse --short HEAD` → `297fb42`
- `git diff --stat HEAD` → 2 files (.gitignore, alignment scan doc), no source changes
- `npm run typecheck` → passed
- `npx vitest run` → 284 passed, 0 failed, 11 skipped (tmux-backed)
- Targeted `rg` searches for all 15 P1-FULL findings (results documented above)
- Source reads of: `src/daemon/index.ts`, `src/daemon/server.ts`, `src/daemon/loop-manager.ts`, `src/daemon/rehydration.ts`, `src/failover/switcher.ts`, `src/session/manager.ts`, `src/slack/service.ts`, `src/statusline/types.ts`, `src/cli/commands/log.ts`
- Alignment scan checkbox audit: 139 unchecked, 0 checked

**Conclusion:** All 15 Phase 1 compliance issues remain unfixed. No new issues found. This fifth independent re-audit by a fresh session confirms the iteration 12–14 results. The Phase 1 compliance gate remains: Phase 2 must not start until all 3 CRITICAL and 8 HIGH issues are resolved. Recommendation: FIX_AND_RE_AUDIT.

---

### Iteration 14 (prior — full Phase 1 compliance re-audit, separate auditor session)

**Approach:** Fourteenth pass — fourth independent full Phase 1 compliance re-audit by a separate auditor session against HEAD `297fb42`. Read the full source plan (Tasks 1–14, 1143 lines), the alignment scan plan (16 tasks, 766 lines), and the existing review artifact (2835 lines). Built a private trace matrix for each Phase 1 task's material requirements against the current implementation. Systematically verified all 15 current P1-FULL findings through targeted `rg` searches and source reads. Conducted a full compliance trace across Tasks 1–14 for any gaps not already captured. Independently confirmed alignment scan implementation status.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** All 15 current P1-FULL findings confirmed unfixed against HEAD `297fb42`

**Key confirmations in iteration 14:**

- **P1-FULL-001 (scoring wiring):** `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon/ src/failover/ src/cli/` → 0 matches. `src/daemon/server.ts:107` uses `.sort((a, b) => a.priority - b.priority).find(...)` — priority-only, no scoring. `src/cli/commands/start.ts:69-71` `--dry-run` also uses priority-only sort.
- **P1-FULL-002 (EXHAUSTED persistence):** `rg -n "patchState.*EXHAUSTED|session\.exhausted" src/daemon/index.ts` → 0 matches. `daemon/index.ts:178-194` — all no-target cases hardcode `terminal: true` including soft-threshold. No `patchState(..., { status: 'EXHAUSTED' })` call. No `session.exhausted` emission.
- **P1-FULL-003 (resume after failed migration):** `src/failover/switcher.ts:191-198` catch block does not clear `snapshot.claudeSessionId`. Line 237 passes original snapshot to `createSessionForTarget`. `daemon/index.ts:214` uses `snapshot.claudeSessionId` for resume decision.
- **P1-FULL-004 (rehydration callbacks):** `rg -n "onSwitch|onRestart|restartInPlace" src/daemon/rehydration.ts` → 0 matches. `RehydrationDeps` still lacks recovery callbacks. `ACTIVE`/`SWITCH_PENDING_AT_IDLE` without tmux emits event only; no restart/recovery.
- **P1-FULL-005 (idle session.stop):** `daemon/index.ts:149-156` emits `session.stop` with reason `idle_timeout` on every idle tick. No once-only guard, no renamed event type.
- **P1-FULL-008 (COOLDOWN retry):** `switcher.ts:209` filters `a.state !== 'UNAVAILABLE'`, allowing COOLDOWN accounts through. Should be `a.state === 'HEALTHY' || a.state === 'DEGRADED'`.
- **P1-FULL-009 (onSwitch soft-threshold bypass):** `daemon/index.ts:177` calls `selectSwitchTarget(accounts, state.account, [])` without `reason` or `currentScore` opts. The soft-threshold "better target" guard at `switcher.ts:70-72` never fires.
- **P1-FULL-010 (journal detail contract):** Migration events lack `target_path`, `source_size`, `target_sha256`. `migration.invalid_path` details are `{ error: String(err) }` not safe reason enums. No `telemetry.invalid_json` emission in statusline store.
- **P1-FULL-011 (EXHAUSTED rehydration):** No EXHAUSTED branch in `rehydrateSessions()`. Persisted EXHAUSTED sessions invisible to online API after restart.
- **P1-FULL-012 (stale observability):** `/api/status` returns cached in-memory `sessionState`. Loop-manager patches (skill, telemetry hydration, failover) don't refresh server visibility. `aisup log` hardcodes `~/.aisup/journal.jsonl`.
- **P1-FULL-013 (Slack edge contracts):** Channel `name_taken` emits `slack.channel_name_collision` for non-collision errors, not on actual `name_taken`. `!stop` calls `sessionManager.stopSession()` without emitting `session.stop` event or `onSessionStop()`.
- **P1-FULL-014 (live recovery):** No `has-session` check before `isProcessDead()` in `recoveryTick()`. Missing-session crash not distinguished from dead-pane crash.
- **P1-FULL-015 (telemetry identity):** No `workspace.project_dir` field in statusline types. Pre-hydration scanning accepts candidates without cwd identity.
- **P1-FULL-016 (restart counter):** `loop-manager.ts:348` evaluates `count >= MAX_RESTARTS_BEFORE_SWITCH` before incrementing at line 363 (4 restarts before escalation instead of 3). No counter reset after successful restart at line 366.

**Compliant areas verified (no issues found — independent confirmation):**
- Config: file permissions 0700/0600 throughout (`loader.ts:171,188,191`, `writer.ts:31,36`, `manager.ts:67,70,319`), path NUL/newline validation, account name restriction, Slack env var validation
- Session: four-step tmux launch, `execFileSync` with argument arrays throughout `tmux.ts`, `tmuxWithTimeout` with 5s timeouts, `singleQuote` shell escaping, atomic state writes (tmp+rename)
- Runner: absolute path resolution via `validateRunner()` at daemon startup (`index.ts:37`), `singleQuote` escaping at tmux boundary, `config_dir_env` usage (not hardcoded)
- Circuit breaker: constructed at `daemon/index.ts:42-44`, passed to loop-manager deps at line 171, `recordSuccess` on successful switch
- Daemon startup: `loopManager.startAll()` → `server.setReady()` (line 291) → `daemon.ready` (line 295) → Slack async non-blocking (line 300)
- Failover: `runner.terminated_for_switch` emitted (switcher.ts:156), `session.stop` never emitted by switcher (confirmed 0 matches)
- Attach: uses `-L aisup` socket (attach.ts:38)
- Identity: `crypto.randomUUID()` for `aisup_session_id` (server.ts:112)
- switch_tx: persistence via `persistTx()` at each phase transition
- Resume: `buildResumeCommand` when `claudeSessionId` available (daemon/index.ts:214, server.ts:222)
- `restartInPlace`: wired in `onRestart` callback (daemon/index.ts:261)
- `DELETE /api/sessions`: honors `force` flag
- `session.start`: emitted from POST `/api/sessions`

**Verification performed:**
- `git rev-parse --short HEAD` → `297fb42`
- `git diff --stat HEAD` → 2 files (.gitignore, alignment scan doc), no source changes
- `npm run typecheck` → passed
- `npx vitest run` → 284 passed, 0 failed, 11 skipped (tmux-backed)
- Targeted `rg` searches for all 15 P1-FULL findings (results documented above)
- Full or targeted reads of: `src/daemon/index.ts`, `src/daemon/server.ts`, `src/daemon/loop-manager.ts`, `src/daemon/rehydration.ts`, `src/failover/switcher.ts`, `src/session/manager.ts`, `src/session/tmux.ts`, `src/statusline/store.ts`, `src/statusline/types.ts`, `src/slack/service.ts`, `src/config/loader.ts`, `src/journal/writer.ts`, `src/cli/commands/attach.ts`, `src/cli/commands/start.ts`, `src/accounts/registry.ts`

**Conclusion:** All 15 Phase 1 compliance issues remain unfixed. No new issues found. This fourth independent re-audit by a fresh session confirms the iteration 12–13 results. The Phase 1 compliance gate remains: Phase 2 must not start until all 3 CRITICAL and 8 HIGH issues are resolved. Recommendation: FIX_AND_RE_AUDIT.

---

### Iteration 13 (prior — independent full Phase 1 compliance re-audit)

**Approach:** Thirteenth pass — independent fresh Phase 1 compliance re-audit by a separate auditor session against HEAD `297fb42`. Read the full source plan (Tasks 1–14, 1143 lines), the alignment scan (16 tasks, 766 lines), the existing review artifact (2779 lines), and all key source files. Built a private trace matrix for each Phase 1 task's material requirements. Systematically verified all 15 current P1-FULL findings through targeted searches and source reads. Conducted a full compliance trace across Tasks 1–14 for any gaps not already captured. Independently confirmed alignment scan implementation status for all 16 remediation tasks.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** All 15 current P1-FULL findings confirmed unfixed against HEAD `297fb42`

**Key confirmations in iteration 13:**

- **P1-FULL-001 (scoring wiring):** `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon/ src/failover/ src/cli/` → 0 matches. All daemon production paths use priority-only selection.
- **P1-FULL-002 (EXHAUSTED persistence):** `rg -n "patchState.*EXHAUSTED|session\.exhausted" src/daemon/index.ts` → 0 matches. Pre-switch no-target handler at line 178-194 returns without persisting EXHAUSTED. All no-target cases hardcode `terminal: true` including soft-threshold.
- **P1-FULL-003 (resume after failed migration):** `src/failover/switcher.ts:191-198` catch block does not clear `snapshot.claudeSessionId`. Line 237 passes original snapshot to `createSessionForTarget`. Line 225 uses `snapshot.claudeSessionId` for phase designation.
- **P1-FULL-004 (rehydration callbacks):** `rg -n "onSwitch|onRestart|restartInPlace" src/daemon/rehydration.ts` → 0 matches. `RehydrationDeps` still lacks recovery callbacks.
- **P1-FULL-005 (idle session.stop):** Line 152 emits `session.stop` on every idle tick. No once-only guard.
- **P1-FULL-008 (COOLDOWN retry):** Line 209 filters `a.state !== 'UNAVAILABLE'`, allowing COOLDOWN accounts through.
- **P1-FULL-009 (onSwitch soft-threshold bypass):** Line 177 calls `selectSwitchTarget(accounts, state.account, [])` without `reason` or `currentScore` opts.
- **P1-FULL-010 (journal detail contract):** Migration events lack `target_path`, `source_size`, `target_sha256`, safe reason enums. No `telemetry.invalid_json` emission in statusline store.
- **P1-FULL-011 (EXHAUSTED rehydration):** No EXHAUSTED branch in `rehydrateSessions()`.
- **P1-FULL-012 (stale observability):** `/api/status` returns cached in-memory state. `aisup log` hardcodes `~/.aisup/journal.jsonl` (line 8). `/api/accounts` returns only name/state/score/priority/enabled.
- **P1-FULL-013 (Slack edge contracts):** Slack `!stop` calls `sessionManager.stopSession()` directly without emitting `session.stop` event or calling `onSessionStop()`. Channel collision emits event for non-collision errors instead of `name_taken`.
- **P1-FULL-014 (live recovery):** No `has-session` check before `isProcessDead()` in `recoveryTick()`.
- **P1-FULL-015 (telemetry identity):** No `workspace.project_dir` field in statusline types. Pre-hydration scanning accepts candidates without cwd.
- **P1-FULL-016 (restart counter):** Line 348 evaluates `count >= MAX_RESTARTS_BEFORE_SWITCH` before incrementing at line 363 (4 restarts before escalation instead of 3). No counter reset after successful restart at line 366.

**Alignment scan implementation status independently confirmed:**
The following alignment scan items ARE correctly implemented in the current codebase: switch_tx persistence via `persistTx()` (6 call sites in switcher.ts), `buildResumeCommand` in daemon/index.ts (lines 214, 250) and server.ts (line 222), `restartInPlace()` method in session/manager.ts, attach uses `-L aisup` socket (attach.ts:38), output log rotation with `rotateOutputLogIfNeeded()` and `output_log.rotated` emission (loop-manager.ts:242-250), doctor validates statusline command with quoted-path parsing + reports model/context/cost per account, offline status reads `~/.aisup/sessions/*/state.json`, Slack output relay poller with interval and cursor (service.ts:320), live 429 scanning via `detect429InOutput()` in recovery tick (loop-manager.ts:279), skill detection via `detectSkill()` in recovery tick (loop-manager.ts:268), `status --json` support, `/api/events` returns journal events via `readEvents()` (server.ts:162), `stop --force` wired through server DELETE body parsing (server.ts:145-146), Slack lifecycle wiring `onSessionStart`/`onSessionStop` (daemon/index.ts:77-78), circuit breaker constructed and wired to loop-manager deps (daemon/index.ts:42-44, 171), runner validation at startup via `validateRunner()` (daemon/index.ts:37), daemon readiness boundary after `loopManager.startAll()` (daemon/index.ts:289-295).

**Compliant areas verified (no issues found — independent confirmation of iteration 12):**
- Config: file permissions 0700/0600 throughout, path NUL/newline validation, account name `[a-zA-Z0-9_-]` restriction, Slack env var config validation, `allowed_user_ids` non-empty enforcement
- Journal: recursive secret key rejection, ENOSPC handling, partial last line skip
- Session: four-step tmux launch, `execFileSync` (no shell strings), output cursor model, atomic state writes
- Runner: absolute path resolution via `validateRunner()`, `singleQuote` escaping, `config_dir_env` usage
- Accounts: HEALTHY/DEGRADED eligibility filter in `selectBestAccount()`, tie-break order, circuit breaker persistence to `circuit-breaker-state.json`
- Statusline: `epochSecondsToDate()`, symlink rejection via `lstatSync`, `readTelemetryForActiveSession` overloads
- Migration: source symlink/regular-file/extension/projects-prefix/basename validation, target traversal check, target parent symlink validation, atomic copy with `O_CREAT|O_EXCL` + `fsyncSync` + rename, SHA-256 integrity, collision handling
- Slack: Socket Mode with Bolt, private channels enforced, `slugifyProjectName`, `allowed_user_ids` filtering, redaction, channel map persistence
- Skills: `detectSkill` via `Launching skill:` regex, `SkillTracker` class, `resume_prompt_mode: 'never'` default
- CLI: `session.start` emitted from POST `/api/sessions`, daemon graceful shutdown (SIGTERM/SIGINT)
- Docs: README and runbook exist with required content

**Verification performed:**
- `git rev-parse --short HEAD` → `297fb42`
- `git diff --stat HEAD` → 2 files (`.gitignore`, alignment scan doc), no source changes
- `npm run typecheck` → passed
- `npx vitest run` → 284 passed, 0 failed, 11 skipped (tmux-backed)
- Targeted `rg` searches for all 15 P1-FULL findings (results documented above)
- Full or targeted reads of: `src/daemon/index.ts`, `src/daemon/server.ts`, `src/daemon/loop-manager.ts`, `src/daemon/rehydration.ts`, `src/failover/switcher.ts`, `src/failover/migrator.ts`, `src/session/manager.ts`, `src/session/tmux.ts`, `src/accounts/registry.ts`, `src/accounts/scorer.ts`, `src/accounts/circuit-breaker.ts`, `src/runner/builder.ts`, `src/statusline/store.ts`, `src/statusline/types.ts`, `src/slack/service.ts`, `src/slack/commands.ts`, `src/slack/channels.ts`, `src/slack/relay.ts`, `src/skills/detector.ts`, `src/skills/tracker.ts`, `src/skills/continuation.ts`, `src/config/loader.ts`, `src/config/schema.ts`, `src/config/defaults.ts`, `src/journal/writer.ts`, `src/journal/reader.ts`, `src/journal/types.ts`, `src/cli/commands/status.ts`, `src/cli/commands/log.ts`, `src/cli/commands/accounts.ts`, `src/cli/commands/attach.ts`, `src/cli/commands/stop.ts`, `src/cli/commands/start.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/failover.ts`, `src/cli/pid.ts`, `src/daemon/loops/recovery-handler.ts`, `src/daemon/loops/health-checker.ts`, `src/daemon/loops/idle-watchdog.ts`, `src/util/rotating-log.ts`, `README.md`, `docs/runbook.md`, `AGENTS.md`

**Conclusion:** All 15 Phase 1 compliance issues remain unfixed. No new issues found. This independent re-audit by a fresh session confirms the iteration 12 results. The Phase 1 compliance gate remains: Phase 2 must not start until all 3 CRITICAL and 8 HIGH issues are resolved. Recommendation: FIX_AND_RE_AUDIT.

---

### Iteration 12 (prior — full Phase 1 compliance re-audit)

**Approach:** Twelfth pass — full independent Phase 1 compliance re-audit against HEAD `297fb42`. Re-read all three source documents (source plan, alignment scan, existing review). Traced each of the 15 current P1-FULL findings against current implementation evidence. Verified alignment scan implementation status. Corrected the Phase 1 summary table arithmetic error (HIGH count 10→8, total 17→15).

**New findings discovered:** 0
**Amendments to prior findings:** 1 (summary table corrected: HIGH 10→8, total 17→15 — counting error, not a finding change)
**Prior findings re-verified:** All 15 current P1-FULL findings confirmed unfixed against HEAD `297fb42`

**Key confirmations in iteration 12:**

- **P1-FULL-001 (scoring wiring):** `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon src/failover src/cli` → 0 matches. Account scoring helpers remain unused by all daemon production paths. Session start uses priority-only sort.
- **P1-FULL-002 (EXHAUSTED persistence):** `rg -n "patchState.*EXHAUSTED|session\.exhausted" src/daemon/index.ts` → 0 matches. Pre-switch no-target handler still returns without persisting EXHAUSTED.
- **P1-FULL-003 (resume after failed migration):** `src/failover/switcher.ts:191-198` catch block logs migration error but does not clear `snapshot.claudeSessionId`. Target creation at line 237 still receives original claudeSessionId.
- **P1-FULL-004 (rehydration callbacks):** `rg -n "onSwitch|onRestart|restartInPlace" src/daemon/rehydration.ts` → 0 matches. RehydrationDeps still lacks recovery callbacks.
- **P1-FULL-005 (idle session.stop):** `src/daemon/index.ts:152` emits `session.stop` on every idle tick. No once-only guard, no renamed event.
- **P1-FULL-008 (COOLDOWN retry):** `src/failover/switcher.ts:209` still filters `a.state !== 'UNAVAILABLE'` (allows COOLDOWN).
- **P1-FULL-009 (onSwitch soft-threshold bypass):** `src/daemon/index.ts:177` calls `selectSwitchTarget(accounts, state.account, [])` without reason/currentScore opts.
- **P1-FULL-010 (journal detail contract):** Migration events still lack `target_path`, `source_size`, `target_sha256`, safe reason enums. No `telemetry.invalid_json` emission in statusline store.
- **P1-FULL-011 (EXHAUSTED rehydration):** No EXHAUSTED branch in `rehydrateSessions()`. Persisted EXHAUSTED sessions invisible to online API after restart.
- **P1-FULL-012 (stale observability):** `/api/status` still returns cached in-memory state; loop-manager state updates (telemetry hydration, skill, failover) don't refresh server visibility.
- **P1-FULL-015 (telemetry identity):** `statusline/types.ts` still has no `workspace.project_dir` field. Pre-hydration scanning accepts candidates without cwd.
- **P1-FULL-016 (restart counter):** `loop-manager.ts:348` evaluates count BEFORE incrementing at line 361-363, causing one extra restart. No counter reset after successful restart at line 366.

**Alignment scan implementation status (verified):**
Many alignment scan items ARE correctly implemented: switch_tx persistence via `persistTx()` (6 call sites), `buildResumeCommand` in daemon/index.ts (lines 214, 250), `restartInPlace()` method, attach uses `-L aisup` socket, output log rotation with `rotateOutputLogIfNeeded()` and `output_log.rotated` emission, doctor validates statusline command + reports model/context/cost, offline status reads state files, Slack output relay poller with interval and cursor, live 429 scanning via `detect429InOutput()` in recovery tick, skill detection via `detectSkill()` in recovery tick, `status --json` support, `/api/events` returns journal events, `stop --force` wired through.

**Verification performed:**
- `git rev-parse --short HEAD` → `297fb42`
- `git diff --stat HEAD` → 2 files (`.gitignore`, alignment scan doc), no source changes
- `npm run typecheck` → passed
- `npx vitest run` → 284 passed, 0 failed, 11 skipped (tmux-backed)
- Targeted rg searches for all 15 P1-FULL findings (results documented above)
- Full or targeted reads of: `src/daemon/index.ts`, `src/daemon/server.ts`, `src/daemon/loop-manager.ts`, `src/daemon/rehydration.ts`, `src/failover/switcher.ts`, `src/session/manager.ts`, `src/accounts/registry.ts`, `src/accounts/scorer.ts`, `src/statusline/store.ts`, `src/statusline/types.ts`, `src/slack/service.ts`, `src/cli/commands/status.ts`, `src/cli/commands/stop.ts`, `src/cli/commands/attach.ts`, `src/cli/commands/doctor.ts`

**Conclusion:** All 15 Phase 1 compliance issues remain unfixed. No new issues found. Summary table corrected (was: 10 HIGH / 17 total → now: 8 HIGH / 15 total). The Phase 1 compliance gate remains: Phase 2 must not start until all 3 CRITICAL and 8 HIGH issues are resolved. Recommendation: FIX_AND_RE_AUDIT.

---

### Iteration 11 (prior)

**Approach:** Eleventh pass — refreshed the existing audit against the current working tree and HEAD `297fb42`. Re-read the Phase 2 implementation plan, the full existing review artifact, and the current source boundaries that determine the critical/high findings: rehydration, loop-manager tick ordering, daemon lifecycle wiring, config defaults/validation, Slack command dispatch, failover selection, session restart, journal reader/types, tmux attach, account scoring, and host-gated test markers.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** Critical/high findings re-checked against current plan/code; representative medium/low findings and Phase 1 compliance gates re-checked. Existing counts remain unchanged.

**Key confirmations in iteration 11:**

- **Phase 2 CR/HIGH findings remained valid at the time:** Pipe-pane restore already exists in rehydration, switch-tx recovery is not purely detection-only, `active_skill` still has no normal null-transition path, and idle still emits misleading `session.stop`. Historical note: this iteration still treated the broad CR-005 EXHAUSTED persistence claim as active; iteration 17 superseded it after confirming `performSwitch()` persists and emits EXHAUSTED. Current EXHAUSTED gaps are the pre-switch no-target path (Phase 1/P1-FULL-002) and restart re-arm gap (CR-006).
- **Task 1 smoke-test findings remain valid:** daemon/config paths still resolve through `homedir()/.aisup` unless the subprocess environment isolates HOME, and `aisup attach` still has a non-TTY guard followed by an inherited-stdio `tmux attach-session`.
- **Phase 1 gates remain valid:** account scoring helpers still are not imported by daemon/failover/CLI production paths, the pre-switch no-target branch still does not persist EXHAUSTED, failed migration still leaves `snapshot.claudeSessionId` available for target resume, and automatic retry still allows accounts whose state is not `UNAVAILABLE`.

**Verification performed:**
- `git status --short` -> dirty working tree contains unrelated existing edits plus untracked plan/review artifacts.
- `git rev-parse --short HEAD` -> `297fb42`.
- Full/targeted reads with line numbers of `src/daemon/rehydration.ts`, `src/daemon/loop-manager.ts`, `src/daemon/index.ts`, `src/config/loader.ts`, `src/config/schema.ts`, `src/config/defaults.ts`, `src/slack/service.ts`, `src/slack/commands.ts`, `src/failover/switcher.ts`, `src/failover/types.ts`, `src/session/manager.ts`, `src/session/types.ts`, `src/daemon/server.ts`, `src/journal/types.ts`, `src/journal/reader.ts`, `src/statusline/types.ts`, `src/daemon/loops/recovery-handler.ts`, `src/skills/detector.ts`, `src/cli/index.ts`, `src/cli/commands/attach.ts`, `src/runner/builder.ts`, `src/accounts/registry.ts`, and `src/accounts/scorer.ts`.
- `rg -n "patchState.*EXHAUSTED|session\\.exhausted" src/daemon/index.ts` -> no matches.
- `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon src/failover src/cli` -> no matches.
- `rg -n "onSwitch|onRestart|restartInPlace" src/daemon/rehydration.ts` -> no matches.
- `rg -n "AuthFailure|NetworkError" src/failover/types.ts` -> no matches.
- `rg -n "case '" src/slack/service.ts` -> only `interrupt`, `stop`, `confirm`, `status`, `cmd`, `relay`, and `help`.
- `ls -d src/cost src/recovery src/permissions src/gates tests/cost tests/recovery tests/permissions tests/gates tests/integration` -> all listed Phase 2 directories are absent.
- `rg -n "RC reconnect|remote-control reconnect|remote control reconnect" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md docs/prd/2026-04-29-ai-supervisor.md` -> PRD mentions remain; plan still omits them.
- `rg -n "TELEMETRY_FIELDS|tests/integration/smoke.test.ts|AISUP_INTEGRATION|requires_tmux|requires_slack|requires_claude" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md tests AGENTS.md` -> plan has env gate and telemetry artifact but no explicit host marker requirement; existing tmux tests use `@requires_tmux`.
- `npm run typecheck` -> passed.
- `npx vitest run tests/daemon/rehydration.test.ts tests/daemon/loops/loop-manager.test.ts tests/config/loader.test.ts tests/slack/service.test.ts` -> passed, 38 tests.
- `npx vitest run` -> passed, 273 tests; 11 tmux-backed tests skipped because the sandbox could not connect to the tmux socket.

**Conclusion:** No new findings were added. The plan remains `FIX_AND_RE_REVIEW`: implementation should not start until the 5 CRITICAL and 14 HIGH Phase 2 findings are corrected, and the Phase 1 compliance gates are resolved or explicitly deferred with owner approval.

---

### Iteration 10 (prior)

**Approach:** Tenth pass — re-read the Phase 2 plan and existing review, then re-verified the highest-risk implementation boundaries against current repository state: daemon home/config isolation, attach/TTY behavior, host-gated test markers, rehydration, loop manager scanning, config defaults/validation, Slack dispatch, circuit breaker state, and existing test health. This pass preserved prior audit history and added only new material findings.

**New findings discovered:** 4 (HI-013, HI-014, ME-020, LO-008)
**Amendments to prior findings:** 0
**Prior findings re-verified:** Critical/high findings re-checked against current plan/code; all remain valid.

**Key discoveries in iteration 10:**

- **HI-013 (Task 1 daemon home isolation):** The smoke test claims a temporary config/journal/port, but the daemon and CLI resolve config, PID, token, log, and session state from `homedir()/.aisup` unless the subprocess environment isolates `HOME` or the code adds an explicit home/config override. Without that instruction, the test can touch live user state.
- **HI-014 (Task 1 attach automation):** The planned automated `aisup attach` check conflicts with the current attach command. `sessionAttach()` exits in non-TTY Vitest runs and blocks interactively when it reaches `tmux attach-session`.
- **ME-020 (Task 1 markers):** The smoke test is env-gated but lacks the explicit `@requires_tmux` / `@requires_claude` marker requirement mandated by AGENTS.md and used by existing host-gated tests.
- **LO-008 (Task 1 telemetry doc artifact):** `tests/integration/TELEMETRY_FIELDS.md` is required by Task 1 DoD but missing from its Files section.

**Verification performed:**
- `git status --short --branch` → branch `main` ahead of origin with unrelated user changes; plan and review are untracked/modified artifacts.
- `sed -n '1,777p' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` → plan fully read.
- Full or targeted reads of `src/daemon/index.ts`, `src/cli/commands/daemon.ts`, `src/cli/commands/attach.ts`, `src/config/loader.ts`, `src/daemon/rehydration.ts`, `src/daemon/loop-manager.ts`, `src/session/manager.ts`, `src/slack/service.ts`, `src/slack/commands.ts`, `src/journal/types.ts`, `src/accounts/circuit-breaker.ts`, `src/daemon/server.ts`, `src/failover/switcher.ts`, `src/accounts/scorer.ts`, and `src/accounts/registry.ts`.
- `HOME=/private/tmp/aisup-home-check node -e "console.log(require('node:os').homedir())"` → confirmed local Node subprocesses can isolate `homedir()` through `HOME`.
- `rg -n "loadConfig\\(\\)|join\\(homedir\\(\\), '\\.aisup'|requires_tmux|AISUP_INTEGRATION|attach requires an interactive TTY|attach-session" src tests docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` → confirmed hard-coded home paths, marker examples, env-only smoke gate, and attach TTY/attach-session behavior.
- `npm run typecheck` → passed.
- `npx vitest run tests/daemon/rehydration.test.ts tests/daemon/loops/loop-manager.test.ts tests/config/loader.test.ts tests/slack/service.test.ts` → passed, 38 tests.
- `npx vitest run` → passed, 273 tests; 11 tmux-backed tests skipped due sandbox tmux socket permission.

**Conclusion:** The Phase 2 plan still needs revision before implementation. The prior findings remain materially valid, and Task 1 now has four additional plan-level gaps. Recommendation remains FIX_AND_RE_REVIEW: correct the 5 CRITICAL and 14 HIGH findings before implementation starts; also resolve or explicitly gate the Phase 1 compliance blockers.

---

### Iteration 9 (prior)

**Approach:** Ninth pass — full independent re-verification of all 48 findings against unchanged plan and codebase. HEAD confirmed at `297fb42` (no commits since iteration 8). Plan file confirmed untracked and unmodified. This is a confirmation pass — verifying the review has reached its final no-new-material-findings state.

**New findings discovered:** 0
**Amendments to prior findings:** 0
**Prior findings re-verified:** All 48 confirmed valid against unchanged plan and codebase

**Verification performed:**
- `git log --oneline -15` → HEAD at `297fb42`, same as iteration 8
- `git status --short` → plan untracked, no source changes
- Full read of: `loop-manager.ts` (408 lines), `daemon/index.ts` (331 lines), `rehydration.ts` (225 lines), `config/schema.ts` (80 lines), `config/defaults.ts` (54 lines), `config/loader.ts:140-179`, `journal/types.ts` (85 lines), `session/manager.ts:165-234`, `slack/service.ts:170-310`, `slack/commands.ts` (57 lines), `daemon/server.ts:1-50`, `cli/index.ts` (88 lines)
- `grep -rn 'event_type:' src/` → 30 emitted event types, 48 union members — drift confirmed (18 unused union members)
- Verified all CRITICAL findings as then understood: CR-001 (pipe-pane exists), CR-002 (switch-tx recovery NOT detection-only), CR-003 (active_skill never clears to null), CR-004 (onIdle doesn't stop sessions), CR-005 (later superseded by CR-006 after confirming `performSwitch()` persistence; pre-switch no-target remains a Phase 1 gap)
- Verified all HIGH findings: HI-001 (defaults.ts missing), HI-002 (failover/types.ts missing from Task 6 Files), HI-003 (daemon/index.ts missing from Task 3 Files), HI-004 (RehydrationDeps lacks callbacks), HI-005 (execFile with command strings), HI-006 (validateConfig explicit return), HI-007 (readEvents not referenced in Task 4), HI-008 (recoveryTick status filter), HI-009 (CBState not exported), HI-010 (dispatchCommand missing cases), HI-011 (Task 9 keystroke logic vs listed files), HI-012 (AGENTS.md rule #8 vs gate execution)
- Verified key Medium findings as then understood: ME-010 (rateLimitTick early return before cost), ME-017 (recoveryTick scan ordering), ME-019 (later rejected in iteration 18 because `createSession()` ignores `accountConfigDir`; HI-004 remains the active recovery wiring concern)
- Phase 1 compliance addendum: All 4 findings remain unfixed in codebase

**Conclusion:** Plan and codebase unchanged. All 48 findings confirmed. No new material issues. Review has reached final confirmation state. The recommendation remains FIX_AND_RE_REVIEW — all 5 CRITICALs and 12 HIGHs require plan corrections before implementation can start safely. Additionally, the 4 Phase 1 compliance gate findings remain unresolved.

---

### Iteration 8 (prior)

**Approach:** Eighth pass — full re-verification of all 46 prior findings against current codebase state (no new commits since iteration 7, `git log --oneline -10` confirmed HEAD at `297fb42`). Plan unchanged. Focused on: AGENTS.md rule #8 vs gate execution design, `restartInPlace()` internal `accountConfigDir` handling for Task 2's state-without-tmux recovery, and cross-referencing the existing `RunnerConfig` command/args split pattern against the gate config format.

**New findings discovered:** 2 (HI-012, ME-019)
**Amendments to prior findings:** 1 (HI-005 status updated to cross-reference HI-012)
**Prior findings re-verified:** All 46 confirmed valid against unchanged plan and codebase

**Key discoveries in iteration 8:**

- **HI-012 (AGENTS.md rule #8 vs gate execution):** Task 11's gate config uses `command: "npx tsc --noEmit"` (single string with spaces) + `args: string[]`. AGENTS.md rule #8 mandates shell-free subprocess execution (`execFile`/argument arrays). HI-005 identified the `execFile` incompatibility; HI-012 goes further: shell-enabled execution would violate AGENTS.md unless explicitly justified and tested. The correct resolution is to change the gate config to split `command` (executable only) from `args` (all arguments), matching the existing `RunnerConfig` pattern at schema.ts:8-14. This makes gate execution work with `execFile` and complies with AGENTS.md.

- **ME-019 (historical, later rejected):** Iteration 8 claimed `restartInPlace()` would relaunch with an empty account config directory during state-without-tmux recovery. Iteration 18 rejected the `CLAUDE_CONFIG_DIR=''` failure claim after verifying `createSession()` ignores `accountConfigDir`; the current actionable risk is HI-004/P1-FULL-004, which require recovery callbacks to construct the correct command/env before calling `restartInPlace()`.

**Automated checks run:**
- `git log --oneline -10` → HEAD at `297fb42`, no new commits since iteration 7
- `git diff --stat HEAD` → 2 files changed (`.gitignore`, alignment scan doc), no source code changes
- `grep -n 'execFile\|execFileSync' src/` → consistent shell-free usage across all 10 subprocess call sites
- `grep -n 'shell-free\|execFile\|argument arrays' AGENTS.md` → rule #8 confirmed at line 10
- `grep -n 'accountConfigDir' src/session/manager.ts` → found empty string at `restartInPlace` createSession fallback
- `grep -n 'accountRegistry.get' src/daemon/index.ts` → onRestart callback correctly resolves configDir (workaround exists)
- All 46 prior findings re-verified: plan unchanged, codebase unchanged, all findings still valid
- Verified `RunnerConfig` at schema.ts:8-14 uses split `command`/`args` pattern (the model the gate config should follow)

**Files analyzed this iteration:**
- `src/session/manager.ts` (lines 165-285) — `restartInPlace()` fallback path, `accountConfigDir: ''`
- `src/daemon/index.ts` (full, 331 lines) — `onRestart` workaround pattern at lines 244-269
- `src/config/schema.ts` (full, 80 lines) — `RunnerConfig.command`/`args` split pattern
- `AGENTS.md` (full, 10 lines) — rule #8 shell-free mandate
- `src/runner/builder.ts` (grep) — existing `execFileSync` usage
- `src/cli/commands/doctor.ts` (grep) — existing `execFileSync` usage
- `src/daemon/loop-manager.ts` (full, 408 lines) — re-verified all tick methods and callback patterns
- `src/daemon/rehydration.ts` (full, 225 lines) — re-verified `RehydrationDeps` interface
- `src/failover/types.ts` (full) — re-verified `SwitchReason` enum
- `src/journal/types.ts` (full) — re-verified `EventType` union
- `src/accounts/circuit-breaker.ts` (lines 30-79) — re-verified `CBState`, `getState()`, `load()` transition
- `src/statusline/types.ts` (full) — re-verified `cost?.total_cost_usd` field
- `src/slack/service.ts` (full) — re-verified dispatch routing and `SlackServiceOpts`
- `src/session/types.ts` (full) — re-verified `SessionStatus` union, `SessionState` fields

---

### Iteration 7

**Approach:** Seventh pass — deep re-verification of all 43 prior findings against current codebase state, focused on runtime code flow analysis within `recoveryTick()` to validate Task 6/8 integration points, architectural separation of concerns for Task 9 permission broker, and state management gaps for new per-session counters. Re-read all key source files: `loop-manager.ts` (full, 408 lines), `daemon/index.ts` (full, 331 lines), `recovery-handler.ts` (full), `daemon/server.ts` (full), `cli/index.ts` (full), `session/types.ts` (full), `skills/detector.ts` (full), `idle-watchdog.ts` (full), `runner/builder.ts` (full), `statusline/types.ts` (full), `config/schema.ts` (full), `config/defaults.ts` (full), `config/loader.ts` (full), `journal/types.ts` (full), `circuit-breaker.ts` (full), `session/manager.ts` (full), `rehydration.ts` (full), `slack/service.ts` (full), `slack/commands.ts` (full), `failover/types.ts` (full). Verified PRD against all 9 `node-pty` references and 3 `events.jsonl` references.

**New findings discovered:** 3 (HI-011, ME-017, ME-018)
**Amendments to prior findings:** 1 (LO-004 amended — 8 missing event types now in union per commit 297fb42)
**Prior findings re-verified:** All 43 confirmed valid against unchanged plan

**Key discoveries in iteration 7:**

- **HI-011 (Task 9 keystroke/tmux gap):** Task 9's DoD includes "auto-granted permissions send approval keystroke to tmux pane with safety checks" but the Files section only lists `policy.ts` (create), tests, `schema.ts`, `loader.ts` — none of which have tmux socket or session state access. The keystroke sending must happen in `daemon/index.ts` inside the `onPermissionDetected` callback, not in the pure policy evaluation module. The plan conflates policy evaluation (stateless, testable) with keystroke side effects (requires tmux access).

- **ME-017 (output scanning insertion ordering):** `recoveryTick()` has a specific scan structure: `readLogTail` → `detectSkill` (line 268) → `detect429InOutput` (line 279) → if 429, `onSwitch` + `return` (line 301). New detection added "after the 429 check" (as the plan says for Tasks 6/8) would be placed at ~line 303, which only executes when NO 429 is found. Auth/network/permission detection must be inserted BEFORE the 429 check (between lines 268-278) or they'll be silently skipped whenever rate-limit output is present.

- **ME-018 (network error counter state):** Task 6 says "3+ consecutive network errors → restart" but doesn't specify where the counter lives. Must be a `Map<string, number>` on `LoopManager` (matching Task 3/12's state tracking pattern) with explicit reset conditions: non-error output, session switch, session stop.

- **LO-004 AMENDMENT (EventType drift partially resolved):** The 8 event types that were missing from the `EventType` union (`output_log.cursor_reset`, `output_log.rotated`, 5× `slack.*`, `tmux.command_timeout`) have been added in commit `297fb42` (Phase 1 alignment scan). The consolidation recommendation still applies for the 21 new Phase 2 types and the 17 unused union members.

**Automated checks run:**
- Full source tree verified: `find src -type f -name '*.ts' | wc -l` → 50 files, unchanged from iteration 6
- `git log --oneline -20` → no new commits since Phase 1 alignment scan (297fb42)
- Verified `EventType` union now includes all production event types (8 previously-missing types confirmed present)
- Verified `recoveryTick()` scan order: skill detection (L268) → 429 detection (L279) → return on 429 (L301) → cursor advance (L304)
- Verified `readLogTail` is imported from `recovery-handler.ts` and called at L266 inside `if (cursor)` block
- Verified `detect429InOutput` is a standalone exported function (not class method) — same pattern for new detectors
- Verified Task 9 Files section: no `daemon/index.ts`, no `session/tmux.ts`
- Verified `sendText`/`sendEnter` are only imported in `slack/service.ts` and `session/manager.ts` — not available in permissions modules
- Verified `DaemonServerOptions` still lacks gate/cost/permission deps (ME-007 confirmed)
- Verified `CBState` type at circuit-breaker.ts:3 still unexported (HI-009 confirmed)
- Verified `KNOWN_COMMANDS` still has 8 entries; `dispatchCommand` still has 7 case handlers (HI-010 confirmed)
- Verified PRD has 9 `node-pty` references and 3 `events.jsonl` references — Task 0 verify command catches all
- All 43 prior findings re-verified: plan unchanged, all findings still valid

**Files analyzed this iteration:**
All 20 source files listed above were read and verified against plan claims. Key verification: `recoveryTick()` internal scan structure and scoping, `onPermissionDetected` callback path from detection to keystroke, `LoopManager` per-session state tracking patterns, `EventType` union reconciliation with commit 297fb42, CLI registration pattern (Commander), `DaemonServerOptions` interface, API route inventory.

---

### Iteration 6

**Approach:** Sixth pass — PRD cross-reference audit, dependency chain validation, strategic alignment check, and Phase 1 compliance gate verification. Read the full PRD (`docs/prd/2026-04-29-ai-supervisor.md`), Phase 1 alignment scan (`docs/plans/2026-05-07-phase1-alignment-scan.md`), all plan task dependency chains, and verified Phase 1 addendum fixes against current codebase. Focused on: PRD Feature D₂ sub-feature coverage, PRD acceptance criteria vs plan deliverables, config ownership across tasks with cross-dependencies, and Phase 1 gate readiness.

**New findings discovered:** 3 (ME-015, ME-016, LO-007)
**Amendments to prior findings:** 1 (IN-002 amended — downgraded from "correctly matches" to "mostly matches" due to RC reconnect omission)
**New info:** 1 (IN-004 — Phase 1 compliance fixes still pending)

**Key discoveries in iteration 6:**

- **ME-015 (RC reconnect omission):** PRD Feature D₂ lists four sub-features: "auth failure, exhausted, network, RC reconnect." The plan implements three and silently drops "remote-control reconnect" without listing it in Out of Scope or Deferred Ideas. The `remote_control_prefix` field exists in RunnerConfig and is used by `buildArgs()`, but no reconnect logic is planned.

- **ME-016 (detection_patterns config ownership):** Task 8 describes configurable permission detection patterns (line 550) but doesn't list config files in its Files section. The config files (`schema.ts`, `loader.ts`) are only assigned to Task 9, which depends on Task 8 — creating a circular dependency for the "configurable patterns" feature.

- **LO-007 (daily/weekly terminology):** PRD acceptance criterion #6 says "daily/weekly token and cost breakdown." Plan uses rolling time windows (`today`, `last_7d`, `last_30d`) instead. Functionally equivalent but doesn't match PRD language exactly.

- **IN-004 (Phase 1 gate):** All 4 Phase 1 compliance findings remain unfixed. The gate condition "Phase 2 should not start until these Phase 1 blockers are fixed" is unmet.

**Automated checks run:**
- `grep -n 'RC reconnect\|remote.control reconnect' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` → 0 matches (PRD says "RC reconnect" at lines 78 and 249)
- `grep -n 'detection_patterns' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` → appears in Task 8 text (line 550) and Task 9 PermissionsConfig (line 585)
- Verified Task 8 Files section: no `schema.ts` or `loader.ts` listed
- `grep 'patchState.*EXHAUSTED' src/daemon/index.ts` → 0 matches (P1-CR-002 unfixed)
- `grep 'session\.exhausted' src/daemon/index.ts` → 0 matches (P1-CR-002 unfixed)
- `grep 'selectBestAccount\|scoreAccount' src/daemon/server.ts` → 0 matches (P1-CR-001 unfixed)
- All 39 prior findings re-verified: plan unchanged, all findings still valid
- Plan dependency chain validated: no circular dependencies except the ME-016 config ownership issue
- PRD acceptance criteria cross-referenced against plan deliverables: 5 of 6 directly covered, #6 partially covered (rolling windows vs daily/weekly)

**Files analyzed this iteration:**
- `docs/prd/2026-04-29-ai-supervisor.md` (full) — Feature Inventory, Phase 2 scope, acceptance criteria
- `docs/plans/2026-05-07-phase1-alignment-scan.md` (full) — Phase 1 alignment tasks and verification requirements
- `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` (full re-read) — dependency chain, scope claims
- `src/daemon/index.ts` — Phase 1 compliance gate verification
- `src/daemon/server.ts` — scorer wiring verification
- `src/runner/builder.ts` — remote_control_prefix usage
- `src/config/schema.ts` — RunnerConfig.remote_control_prefix field

---

### Iteration 5

**Approach:** Fifth pass — deep code verification of all source files referenced by the plan. Read `loop-manager.ts`, `daemon/index.ts`, `rehydration.ts`, `config/schema.ts`, `config/defaults.ts`, `config/loader.ts`, `slack/service.ts`, `slack/commands.ts`, `recovery-handler.ts`, `failover/types.ts`, `journal/types.ts`, `journal/reader.ts`, `journal/writer.ts`, `daemon/server.ts`, `cli/index.ts`, `circuit-breaker.ts`, `account-registry.ts`, `session/manager.ts`, `idle-watchdog.ts`, `skills/tracker.ts`, `statusline/types.ts`, and `cli/commands/status.ts`. Focused on: callback interface placement (Opts vs Deps), EventType union integrity, `readEvents()` scaling, and plan line number accuracy.

**New findings discovered:** 2 (ME-014, IN-003)
**Amendments to prior findings:** 1 (LO-004 amended — 8 existing event types already missing from union)

**Key discoveries in iteration 5:**

- **ME-014 (onGateTrigger placement):** Task 12's `onGateTrigger` callback needs explicit placement on `LoopManagerDeps` (action callbacks), not `LoopManagerOpts` (event/notification callbacks). The split is consistent in existing code: `onSwitch`/`onRestart` are on Deps (actions accessed via `d.*`), `onIdle`/`onCrashDetected` are on Opts (events accessed via `this.*`). Gate triggering is an action.

- **LO-004 AMENDMENT (EventType drift):** `grep -rn "event_type:" src/` revealed 8 production event types not in the `EventType` union: `output_log.cursor_reset`, `output_log.rotated`, `slack.channel_created`, `slack.channel_name_collision`, `slack.connection_error`, `slack.message_ignored`, `slack.queue_dropped`, `tmux.command_timeout`. Additionally, 17 union members have no matching emit in code. The union is already drifted — adding 21 more types without reconciliation deepens the problem.

- **IN-003 (readEvents scaling):** `readEvents()` reads entire journal into memory. Phase 2's `cost.snapshot` events (~288/day) accelerate journal growth. Not blocking but worth noting for Task 4's aggregation queries on large journals.

**Automated checks run:**
- `grep -rn "event_type:" src/ | grep -oP "event_type: '[^']+'" | sort -u` → 30 unique event types in code vs 51 in EventType union. 8 in code but not union, 17 in union but not code (confirmed drift).
- Re-verified all 36 prior findings: plan unchanged, all findings still valid.
- Verified plan's `loop-manager.ts:109` reference → confirmed `rateLimitTick` method signature at line 109.
- Verified plan's `loop-manager.ts:130-145` reference → ME-001 already covers this inaccuracy (telemetry hydration, not journal emission).
- `grep -n 'onPermission\|permission\|Permission' src/daemon/loop-manager.ts` → 0 matches (confirms no permission infrastructure exists yet).
- `grep -rn 'restartInPlace' src/` → 2 call sites (daemon/index.ts:261, session/manager.ts:176 definition).
- `wc -l src/daemon/loop-manager.ts` → 407 lines (within 800-line file size guideline; Phase 2 additions may push it to ~500-550).

**Files analyzed this iteration:**
All 21 source files listed above were read via ctx_batch_execute and verified against plan claims. Key verification: `LoopManagerOpts` vs `LoopManagerDeps` callback split, `EventType` union completeness, `readEvents()` implementation, `CircuitBreaker` state model, `SessionManager.restartInPlace()` signature, `IdleWatchdog` tick behavior, `SkillTracker` class structure.

---

### Iteration 4

**Approach:** Fourth pass with focus on Slack command routing end-to-end, daemon lifecycle integration seams, and runtime behavior validation. Special attention to: `parseCommand` → `dispatchCommand` routing chain, `onIdle` actual behavior vs assumed behavior, `SlackServiceOpts` interface completeness for new features, and unassigned plan items (features in File Structure but not in any task's scope).

**New findings discovered:** 4 (HI-010, ME-012, ME-013, LO-006)
**Amendments to prior findings:** 1 (CR-004 amended — `onIdle` doesn't actually stop the session)

**Key discoveries in iteration 4:**

- **CR-004 AMENDMENT:** `onIdle` at daemon/index.ts:149-156 ONLY calls `journal.append()` — it does NOT call `sessionManager.stopSession()`, `patchState()`, or any lifecycle method. The session is NOT stopped by idle detection, contrary to the iteration 3 claim that "the session may have already been stopped by onIdle." The `session.stop` journal event is misleading — it logs a stop that didn't happen. This changes the nature of CR-004 from "functional conflict between stop and gate" to "undefined idle behavior + misleading journal event + missing gate integration." The design gap remains CRITICAL but is simpler to fix than originally described.

- **HI-010 (dispatchCommand routing):** Adding `'permit'`/`'deny'` to `KNOWN_COMMANDS` makes `parseCommand` return the name, but `dispatchCommand()`'s switch statement has no cases for them — they hit `default: "Unknown command"`. The plan says "Add to KNOWN_COMMANDS" but never mentions adding case handlers in `dispatchCommand()`. This makes `!permit`/`!deny` completely non-functional. Pre-existing same bug: `failover` is in KNOWN_COMMANDS but has no switch case.

- **ME-012 (SlackServiceOpts):** Task 10 needs `PermissionsConfig.grant_ttl_seconds` and permission grant/deny callbacks, but `SlackServiceOpts` only has `config: SlackConfig`. Interface extension required.

- **ME-013 (!gate unassigned):** File Structure says add `!gate` to KNOWN_COMMANDS. Task 10 handles `!permit`/`!deny`. No task handles `!gate` — not in Task 12's Files, Key Decisions, or DoD.

**Files analyzed this iteration:**
- `src/daemon/index.ts` (full, 331 lines) — re-analyzed `onIdle` callback behavior: only `journal.append()`, no stopSession. Verified LoopManager deps wiring at L157-190. Verified performSwitch exhausted handling at L237-238.
- `src/daemon/loop-manager.ts` (full, 408 lines) — verified `idleTick()` at L227-233 fires `onIdle` on every tick while idle (no once-only guard). Verified `isSessionIdle` used in both `rateLimitTick` (L166) and `idleTick` (L230). Verified `LoopManagerDeps` interface at L21-38 and `LoopManagerOpts` at L41-55.
- `src/slack/service.ts` (full, ~400 lines) — traced complete message handling: `handleMessage` → `parseCommand` → `dispatchCommand`. Found `dispatchCommand` switch has 7 cases (interrupt, stop, confirm, status, cmd, relay, help) + default. No permit/deny/gate/failover cases. Verified `SlackServiceOpts` at L17-26 has no permissions fields.
- `src/slack/commands.ts` (full) — confirmed `KNOWN_COMMANDS` has 8 entries including `failover` (no case in dispatchCommand). `ConfirmationStore` confirmed as reusable TTL store.
- `src/statusline/types.ts` (full) — confirmed `StatuslineTelemetry.cost?.total_cost_usd` field structure.
- `src/journal/reader.ts` (full) — confirmed `readEvents()` reads entire file into memory then filters. Not a plan issue but a pre-existing performance consideration for large journals.

**Automated checks run:**
- `grep -n "case '" src/slack/service.ts` → 7 switch cases: interrupt, stop, confirm, status, cmd, relay, help. No permit/deny/gate/failover.
- `grep -n 'stopSession\|patchState\|writeState' src/daemon/index.ts` in onIdle handler (L149-156) → zero matches. Only `journal.append()`.
- `grep -n 'failover' src/slack/service.ts` → no dispatch case for failover.
- Verified KNOWN_COMMANDS vs dispatchCommand case mismatch: `failover` in KNOWN but not in switch.
- All 32 prior findings re-verified: plan unchanged, all findings still valid.

**Cross-references verified:**
- `parseCommand()` → `dispatchCommand()` routing chain for all current and planned Slack commands
- `onIdle` actual behavior (journal-only) vs plan's assumed behavior (session stop) — CR-004 amendment
- `SlackServiceOpts` interface vs Task 10's data needs (permissions config, grant/deny callbacks)
- `!gate` in File Structure section vs task assignments — gap confirmed
- `ExhaustedRecovery` lifecycle vs daemon shutdown handler — cleanup gap confirmed

### Iteration 3

**Approach:** Third independent pass with focus on runtime behavior, state management, and integration seams between tasks — areas that structural analysis in iterations 1-2 couldn't cover. Special attention to: callback wiring in daemon/index.ts, session status filtering in tick callbacks, state persistence vs in-memory-only state, and conflicts between existing behavior and planned features.

**New findings discovered:** 7 (CR-004, CR-005, HI-008, HI-009, ME-010, ME-011, LO-005)

**Key discoveries in iteration 3:**
- **CR-004 (idle/gate conflict):** `onIdle` emits `session.stop` — gate triggers will conflict with session stopping. This is a design-level conflict that iterations 1-2 missed because they focused on code existence, not runtime behavior. **Note: amended in iteration 4 — onIdle doesn't actually stop sessions.**
- **CR-005 (historical, later superseded):** Iteration 3 treated EXHAUSTED persistence as missing broadly. Iteration 17 superseded that finding after verifying `performSwitch()` persists `EXHAUSTED` and emits `session.exhausted` in the all-targets-failed path. The remaining current issues are narrower: the daemon's pre-switch no-target path still does not persist EXHAUSTED (Phase 1/P1-FULL-002), and persisted EXHAUSTED sessions are not re-armed for recovery after daemon restart (CR-006/P1-FULL-011).
- **HI-008 (recoveryTick status filter):** `recoveryTick()` explicitly filters to ACTIVE/SWITCH_PENDING_AT_IDLE — auth/network detection won't work for other states.
- **HI-009 (CBState not exported):** `type CBState` at circuit-breaker.ts:3 lacks `export`, preventing Task 7's ExhaustedRecovery from importing the type.

**Files read in full this iteration:**
- `src/daemon/loop-manager.ts` (full, 395 lines) — verified CR-003, CR-004 idle/gate conflict, ME-010 cost positioning
- `src/daemon/index.ts` (full, 340 lines) — discovered CR-005 EXHAUSTED not persisted, verified HI-003, HI-004
- `src/session/manager.ts` (lines 260-300) — confirmed `getActiveSession()` ACTIVE/SWITCH_PENDING filter, `patchState` signature
- `src/session/types.ts` (full) — confirmed `SessionStatus` union includes EXHAUSTED
- `src/accounts/circuit-breaker.ts` (full) — confirmed `CBState` not exported, `getState()` auto-transition
- `src/daemon/loops/idle-watchdog.ts` (full, 32 lines) — confirmed simple idle detection, no gate awareness
- `src/config/schema.ts` (full, 80 lines) — confirmed AisupConfig has 11 fields
- `src/config/defaults.ts` (full, 54 lines) — confirmed defaults match schema
- `src/config/loader.ts` (lines 140-170) — re-confirmed explicit return statement
- `src/journal/types.ts` (full) — historical snapshot: iteration 3 saw `session.exhausted` in the EventType union without a daemon/index.ts emission path; iteration 17 later confirmed `performSwitch()` emits it for all-targets-failed exhaustion, while the pre-switch no-target path still does not.
- `src/statusline/types.ts` (full) — confirmed `cost?.total_cost_usd` field
- `src/slack/service.ts` (lines 180-190) — discovered ME-011 existing sendText/sendEnter pattern
- `src/slack/commands.ts` (full) — confirmed KNOWN_COMMANDS set

**Automated checks run:**
- `grep -rn 'patchState.*EXHAUSTED\|session\.exhausted' src/daemon/index.ts` → 0 matches (CR-005)
- `grep -n 'export.*CBState\|type CBState' src/accounts/circuit-breaker.ts` → no export (HI-009)
- `grep -n 'onIdle\|session.stop.*idle' src/daemon/index.ts` → session.stop emitted on idle (CR-004)
- All 25 prior findings re-verified against unchanged plan text (none were applied)

**Cross-references verified:**
- `getActiveSession()` status filter against all tasks that add logic to tick callbacks
- `server.setSessionState()` vs `sessionManager.patchState()` for all state changes in daemon/index.ts
- `onIdle` callback semantics against Task 12's gate trigger requirements
- `SlackService` message handling patterns against Task 10's permission routing
- `StatuslineTelemetry` fields against Task 3's cost snapshot payload
- `rateLimitTick` early return guards against Task 3's cost extraction point

### Prior iterations

**Iteration 1:** Initial deep review. 18 findings (3 CR, 5 HI, 6 ME, 2 LO, 2 IN).
**Iteration 2:** Independent re-review. 7 new findings (0 CR, 2 HI, 3 ME, 2 LO, 0 IN). All 18 prior confirmed.
**Iteration 3:** Runtime behavior pass. 7 new findings (2 CR, 2 HI, 2 ME, 1 LO, 0 IN). All 25 prior confirmed.
**Iteration 4:** Slack routing + idle behavior. 4 new findings (0 CR, 1 HI, 2 ME, 1 LO, 0 IN). 1 amendment (CR-004). All 32 prior confirmed.
**Iteration 5:** Deep code verification. 2 new findings (0 CR, 0 HI, 1 ME, 0 LO, 1 IN). 1 amendment (LO-004). All 36 prior confirmed.
**Iteration 6:** PRD cross-reference audit. 3 new findings (0 CR, 0 HI, 2 ME, 1 LO, 1 IN). 1 amendment (IN-002). All 39 prior confirmed.
**Iteration 7:** Output scanning and permission broker integration pass. 3 new findings (1 HI, 2 ME). All 43 prior confirmed.
**Iteration 8:** Gate subprocess and restart recovery pass. 2 new findings (1 HI, 1 ME). All 46 prior confirmed.
**Iteration 9:** Full confirmation pass. 0 new findings. All 48 prior confirmed.
**Iteration 10:** Task 1 integration-smoke safety pass. 4 new findings (2 HI, 1 ME, 1 LO). Critical/high findings re-confirmed.
**Iteration 11:** Full confirmation pass. 0 new findings. All prior confirmed.
**Iteration 12:** Full Phase 1 compliance re-audit. 0 new findings. 1 amendment (summary table arithmetic corrected: HIGH 10→8, total 17→15). All 15 P1-FULL findings re-verified unfixed.
**Iteration 13:** Independent full Phase 1 compliance re-audit by fresh session. 0 new findings. All 15 P1-FULL findings independently re-verified unfixed. Alignment scan implementation status independently confirmed.
**Iteration 14:** Fourth independent full Phase 1 compliance re-audit by separate auditor session. 0 new findings. All 15 P1-FULL findings confirmed unfixed. Compliant areas independently verified. Test suite: 284 passed, 0 failed.
**Iteration 15:** Fifth independent full Phase 1 compliance re-audit by separate auditor session. 0 new findings. All 15 P1-FULL findings confirmed unfixed. Alignment scan implementation status independently confirmed.
**Iteration 16:** Sixth independent full Phase 1 compliance re-audit. 0 new findings. All 15 P1-FULL findings confirmed unfixed. Full Vitest suite passed with 273 passed, 11 skipped.
**Iteration 17:** Phase 2 refresh. 1 stale critical finding superseded (CR-005), 1 replacement critical added (CR-006). Net active finding count unchanged. Typecheck and full Vitest suite passed.
**Iteration 18:** Phase 2 refresh. 1 stale medium finding rejected (ME-019). Active finding count reduced from 51 to 50. Typecheck and full Vitest suite passed.

---

## Full Phase 1 Compliance Audit — 2026-05-26 (Refreshed 2026-05-27)

**Source of Truth:** `docs/plans/2026-04-29-aisup-supervisor-daemon.md` (Tasks 1–14)
**Alignment Context:** `docs/plans/2026-05-07-phase1-alignment-scan.md` (16 remediation tasks)
**Audit Target:** Current repository state at HEAD (`297fb42`) plus dirty docs worktree (`.gitignore`, alignment scan status, this review artifact)
**Audited:** 2026-05-27 (iteration 16 refresh of full Phase 1 compliance audit — not alignment-scan-only)
**Status:** ISSUES_FOUND
**Gate:** Phase 2 must not start until all CRITICAL and HIGH issues below are fixed and re-verified.

### Context

This is a full Phase 1 compliance audit — not limited to whether the alignment scan changes were applied correctly. The audit traces every Phase 1 task's material requirements against the actual implementation, validates that the prior Phase 1 addendum findings (P1-CR-001 through P1-HI-001 from 2026-05-13) have been addressed, and identifies any remaining compliance gaps.

**Prior addendum status:** All 4 findings from the 2026-05-13 Phase 1 addendum (P1-CR-001, P1-CR-002, P1-CR-003, P1-HI-001) remain **unfixed** in the current codebase. They are re-documented below with updated evidence.

**Tests:** Automated validation was refreshed with typecheck and focused Vitest suites. Tests are necessary but not sufficient — several compliance gaps involve missing wiring, stale API state, or untested runtime behavior that existing tests do not cover.

### Summary

| Severity | Count | Description |
|----------|------:|-------------|
| CRITICAL | 3 | Phase 1 behavior violates source plan or produces incorrect runtime state |
| HIGH | 8 | Significant Phase 1 gap requiring code changes or validation before Phase 2 |
| MEDIUM | 4 | Material compliance or coverage gap within Phase 1 scope |

**Total current Phase 1 compliance issues:** 15
**Rejected historical Phase 1 findings:** 1
**Recommendation:** FIX_AND_RE_AUDIT

### Phase 1 Compliance Findings

---

#### P1-FULL-001 [CRITICAL]: Account scoring and eligibility not wired into daemon account selection

**Confirms:** Prior P1-CR-001 (2026-05-13) — STILL UNFIXED

**Source of Truth:** Plan Task 5 requires `selectBestAccount()` to return the highest-scoring eligible account. Plan Task 3A requires session start to use smart account selection. Plan Task 8 requires rate-limit monitor to use scored switch targets.

**Implementation Evidence:**
- `src/daemon/server.ts:106-108` — `POST /api/sessions` selects the start account by `.sort((a, b) => a.priority - b.priority).find((a) => a.enabled && a.state !== 'UNAVAILABLE')`. No call to `scoreAccount()`, `selectBestAccount()`, `applyTelemetry()`, or `setScore()`.
- `src/accounts/registry.ts:40-44` — `setScore()` and `applyTelemetry()` exist but are never called by any daemon production path. `grep -rn 'applyTelemetry\|setScore' src/daemon/ src/failover/ src/cli/` returns 0 matches.
- `src/accounts/registry.ts:18` — All accounts initialized with `score: null`. Scores remain null at runtime because no path refreshes them from telemetry.
- `src/daemon/loop-manager.ts:168,197` — `selectSwitchTarget()` receives accounts with null scores, so soft-threshold "better target" comparison degrades to priority-only.
- `src/failover/switcher.ts:207-210` — Automatic retry targets include `a.state !== 'UNAVAILABLE'` without excluding `COOLDOWN`, so automatic failover can launch into a cooling-down account.
- `src/daemon/index.ts:177` — `onSwitch` callback calls `selectSwitchTarget(accounts, state.account, [])` without passing `reason` or `currentScore` opts. The loop-manager pre-checks with the correct soft-threshold parameters (lines 168-170, 197-200), but the `onSwitch` callback re-selects without those constraints, undoing the "better target" guarantee at the actual switch point.
- `src/cli/commands/start.ts:69-71` — `--dry-run` selects accounts by `.sort((a, b) => a.priority - b.priority)[0]` — priority-only, no scoring.

**Issue:** `aisup start` always picks the highest-priority enabled account regardless of headroom. Soft-threshold failover targets are selected with null scores (always falls to priority). The `onSwitch` callback does not enforce soft-threshold "better target" at switch time. Automatic retry can select COOLDOWN accounts. All violate the Plan Task 5 scoring contract.

**Impact:** Wrong account selected at start, suboptimal failover targets, wasted failover to rate-limited accounts.

**Fix:** Wire a single account scoring/eligibility refresh path: (1) Before `POST /api/sessions` start and `--dry-run`, call `readTelemetryForAccount()` + `scoreAccount()` for each account and use `selectBestAccount()`. (2) In `rateLimitTick()`, refresh target account scores from telemetry before calling `selectSwitchTarget()`. (3) In `onSwitch` callback, pass `reason` and `currentScore` to `selectSwitchTarget()` (or pass the already-selected target from loop-manager). (4) In `performSwitch()` retry filter, change to `a.state === 'HEALTHY' || a.state === 'DEGRADED'` (not just `!== UNAVAILABLE`).

**Validation:** Tests proving: lower-priority account with better score is selected; stale/null scores are refreshed before soft failover; COOLDOWN not selected automatically; `--dry-run` shows scored selection; `onSwitch` callback enforces soft "better target" at switch time.

**Affected Plan Tasks:** Task 5, Task 3A, Task 7, Task 8

---

#### P1-FULL-002 [CRITICAL]: Pre-switch no-target path does not persist EXHAUSTED for hard/429 reasons

**Confirms:** Prior P1-CR-002 (2026-05-13) — STILL UNFIXED

**Source of Truth:** Plan Task 7 requires hard threshold, 429, and source-dead failover with no runnable target to emit `session.exhausted`, set session state to `EXHAUSTED`, and preserve the logical session. Plan Task 8 distinguishes soft-threshold (nonterminal, keep monitoring) from hard/429/source-dead (terminal EXHAUSTED).

**Implementation Evidence:**
- `src/daemon/index.ts:172-194` — `onSwitch` callback: when `selectSwitchTarget()` returns null, the handler writes `failover.no_target_available` to the journal and returns. It does NOT call `sessionManager.patchState(..., { status: 'EXHAUSTED' })`, does NOT emit `session.exhausted`, and does NOT call `server.setSessionState()`.
- `src/daemon/index.ts:185` — `terminal: true` is hardcoded for ALL no-target cases, including soft-threshold. The plan requires soft-threshold no-target to be nonterminal (`terminal: false`).
- `src/daemon/index.ts:177-194` — No distinction between soft-threshold and hard/429/source-dead no-target cases. All reasons are handled identically (journal event + return). The `requires_better_soft_target` field is set based on reason, but no branching occurs on reason to choose different state transitions.
- `src/failover/switcher.ts:294-329` — `performSwitch()` DOES persist EXHAUSTED via `patchState` and emits `session.exhausted`, but only when all target attempts fail AFTER the switch has started. The pre-switch no-target path in `daemon/index.ts` exits before `performSwitch()` and therefore lacks that emission.

**Issue:** Hard threshold, live 429, source-dead, or circuit-breaker failover with no eligible target leaves the session in ACTIVE state while writing a terminal no-target event. The daemon continues retrying the impossible failover on subsequent ticks. Soft-threshold no-target is incorrectly marked `terminal: true`. Operators see the terminal event in the journal but `aisup status` shows ACTIVE.

**Impact:** Session state inconsistency; daemon spin-loops on impossible failover; EXHAUSTED admission blocking (`aisup start`) never engages for pre-switch no-target; soft-threshold journal events incorrectly signal terminal state.

**Fix:** In `daemon/index.ts` `onSwitch` no-target handler: (1) For hard/429/source-dead/restart-failures/circuit-breaker reasons, call `sessionManager.patchState(sessionId, { status: 'EXHAUSTED' })`, emit `session.exhausted`, call `server.setSessionState(...)`, set `terminal: true`. (2) For soft-threshold, set `terminal: false`, do NOT persist EXHAUSTED, keep session ACTIVE with nonterminal behavior.

**Validation:** Tests for: hard-threshold no target → EXHAUSTED persisted + `session.exhausted` emitted + `terminal: true`; live-429 no target → EXHAUSTED; soft-threshold no better target → remains ACTIVE + `terminal: false` (nonterminal).

**Affected Plan Tasks:** Task 7, Task 8

---

#### P1-FULL-003 [CRITICAL]: Missing or failed transcript migration still launches target with --resume

**Confirms:** Prior P1-CR-003 (2026-05-13) — STILL UNFIXED

**Source of Truth:** Plan Task 7 requires: "If transcript file does not exist... skip migration, log `migration.skipped_no_transcript` event, launch new session WITHOUT `--resume` flag (fresh start)." The same logic applies when migration fails — resume is only safe when the transcript was successfully copied to the target account.

**Implementation Evidence:**
- `src/failover/switcher.ts:162` — Migration only runs inside `if (snapshot.transcriptPath)`. If `transcriptPath` is null but `claudeSessionId` is non-null, no `migration.skipped_no_transcript` event is emitted and no fresh-launch decision is recorded.
- `src/failover/switcher.ts:191-198` — When `migrateTranscript()` throws, the catch block logs `migration.invalid_path` but does NOT clear `snapshot.claudeSessionId` or set any flag indicating migration failed.
- `src/failover/switcher.ts:237` — Target creation callback at line 237 passes the original `snapshot` to `createSessionForTarget()`.
- `src/daemon/index.ts:213-215` — `createSessionForTarget` callback chooses `buildResumeCommand` vs `buildLaunchCommand` based solely on `snapshot.claudeSessionId`. After a failed migration, `claudeSessionId` is still non-null, so `--resume` is used against an account that lacks the transcript.
- Same pattern in `src/daemon/server.ts:221-223` for manual failover.

**Issue:** `pilot --resume <id>` is called in the target account when the transcript was not migrated or when no transcript path was available. This fails silently, resumes the wrong state, or creates a broken session.

**Fix:** Make migration produce an explicit launch decision. If `transcriptPath` is null, emit `migration.skipped_no_transcript` and force fresh launch. If migration throws or fails integrity checks, emit the canonical migration event and force fresh launch. Permit resume only when `claudeSessionId` is non-null and migration succeeded or was already valid in the target account.

**Validation:** Test where source has `claudeSessionId` + null `transcriptPath` → target creation receives fresh launch mode. Test where source has `claudeSessionId` + migration throws → target creation receives no resume id / uses `buildLaunchCommand`. Test where migration succeeds → `buildResumeCommand` used.

**Affected Plan Tasks:** Task 7

---

#### P1-FULL-004 [HIGH]: Rehydration remains detection-only for mid-switch phases

**Confirms:** Prior P1-HI-001 (2026-05-13) — STILL UNFIXED

**Source of Truth:** Plan Task 7 requires durable switch transaction recovery, including continuing from `source_destroyed`, `migrating`, `creating` phases. Plan Task 12 specifies rehydration should reconcile persisted state + live tmux sessions with corrective action.

**Implementation Evidence:**
- `src/daemon/rehydration.ts:12-18` — `RehydrationDeps` has no `onSwitch`, `onRestart`, `accountRegistry`, `config`, or `runner` fields. Rehydration cannot invoke switch/restart logic.
- `src/daemon/rehydration.ts:80-85` — `source_destroyed` handler destroys stale tmux and logs `needs_manual_failover`. No continuation to migration/target creation.
- `src/daemon/rehydration.ts:88-115` — `migrating`/`creating` with dead target log `needs_manual_failover`. No retry.
- `src/daemon/rehydration.ts:173-181` — `ACTIVE`/`SWITCH_PENDING_AT_IDLE` without tmux emit `session.destroyed_externally` but do NOT trigger restart or recovery. No call to `restartInPlace()` or `onRestart`.

**Issue:** Daemon restart after source teardown but before target creation leaves a session requiring manual repair. Daemon restart with a destroyed-externally ACTIVE session also requires manual intervention instead of automatic recovery.

**Impact:** Daemon crash during the most critical operation (account switch) produces an unrecoverable state that requires operator intervention. This violates the Phase 1 durability requirement.

**Fix:** Either inject `onSwitch`/`onRestart` callbacks into `RehydrationDeps` and use them for corrective recovery, or run a deferred recovery pass after loop manager starts.

**Validation:** Rehydration tests for: `source_destroyed` → continues to migration/target creation; `migrating`/`creating` dead target → retries or exhausts; `ACTIVE` without tmux → restart or recovery.

**Affected Plan Tasks:** Task 7, Task 8, Task 12

---

#### P1-FULL-005 [HIGH]: `session.stop` emitted misleadingly from idle tick

**Source of Truth:** Plan Task 2 canonical event union: "`session.stop` is exclusive to user/API/Slack terminal stop paths. Failover uses `runner.terminated_for_switch` instead." Plan Task 8 idle watchdog is for detection, not lifecycle action.

**Implementation Evidence:**
- `src/daemon/index.ts:149-156` — `onIdle` callback emits `session.stop` with `{ reason: 'idle_timeout' }` on every idle tick.
- `src/daemon/index.ts:149-156` — The callback does NOT call `sessionManager.stopSession()` or `patchState()`. The session continues running.
- `src/daemon/loop-manager.ts:227-233` — `idleTick()` fires `onIdle` unconditionally on every tick while idle. No once-only guard.

**Issue:** The journal accumulates spurious `session.stop` events whenever the session is idle. `session.stop` should only appear for actual user/API/Slack terminal stops. Operators monitoring the journal see "stopped" events for sessions that are still ACTIVE. Additionally, repeated `session.stop` events on every idle tick (every `idle_interval_s` seconds) create journal spam.

**Fix:** Rename the idle event to `session.idle_detected` (observability, not lifecycle). Add a once-only guard so it fires once per idle period, not on every tick. The existing `session.stop` at `server.ts:152` (DELETE `/api/sessions`) is the correct terminal stop event.

**Validation:** Test: idle tick emits `session.idle_detected` (not `session.stop`); verify `session.stop` only appears from terminal stop paths; verify idle event fires once per idle period.

**Affected Plan Tasks:** Task 2, Task 8

---

#### P1-FULL-006 [MEDIUM]: Alignment scan plan progress not updated despite implementation

**Source of Truth:** `docs/plans/2026-05-07-phase1-alignment-scan.md` Progress Tracking section shows `Completed: 0 | Remaining: 16`.

**Implementation Evidence:**
- Commit `297fb42` ("Phase 1 alignment scan — fix implementation gaps across all modules") touched 28 files with 2,247 insertions. This commit implemented substantial alignment scan work.
- Many alignment scan requirements ARE implemented in the codebase: switch_tx persistence, resume support, restartInPlace, attach socket parity, output relay poller, live 429 scanning, offline status, doctor telemetry diagnostics, etc.
- However, the plan file's progress checkboxes remain all unchecked.

**Issue:** Plan progress does not reflect actual implementation state. This makes it impossible to determine which alignment scan tasks are complete vs. still pending without re-auditing every requirement.

**Fix:** Update the alignment scan plan's progress checkboxes based on actual implementation evidence. Mark completed tasks as `[x]` and update the progress summary.

**Affected Plan Tasks:** All alignment scan tasks (1–16)

---

#### P1-FULL-007 [REJECTED]: `restartInPlace()` empty `accountConfigDir` finding is unsupported

**Prior Status:** Previously counted as a MEDIUM Phase 1 compliance issue.

**Rejection Evidence:**
- `src/session/manager.ts:188-199` does pass `accountConfigDir: ''` to `createSession()` in the dead-tmux fallback path.
- `src/session/manager.ts:77-84` destructures `createSession()` options as `{ aisupSessionId, account, command, args, env, cwd }`; `accountConfigDir` is not read or used by `createSession()`.
- `src/session/manager.ts:94-102` passes the externally supplied `env` object into `createTmuxSession()`.
- `src/daemon/index.ts:244-261` builds that `env` through `buildResumeCommand()` or `buildLaunchCommand()` using the account's real `configDir` before calling `restartInPlace()`.

**Issue Decision:** Rejected as unsupported. The empty `accountConfigDir` field is dead data in this code path and does not cause `CLAUDE_CONFIG_DIR=''`. Future recovery code still needs to pass a correctly built `env` to `restartInPlace()`, but that is covered by P1-FULL-004's rehydration callback gap rather than a separate current defect.

**Impact on Counts:** Removed from current Phase 1 issue totals. Kept here to preserve audit history and prevent this false positive from being re-added.

**Validation:** `rg -n "async createSession|accountConfigDir|createTmuxSession" src/session/manager.ts src/daemon/index.ts` confirms `accountConfigDir` is ignored by `createSession()` and runner account selection comes from the `env` argument.

---

#### P1-FULL-008 [HIGH]: Automatic switch retry includes COOLDOWN accounts

**Source of Truth:** Plan Task 5 requires `selectBestAccount()` to filter eligible accounts to `HEALTHY` or `DEGRADED` only. Plan Task 7 automatic retry after target failure should exclude current plus tried targets and select from eligible accounts. Plan Task 5 explicitly states: "UNAVAILABLE and COOLDOWN are never eligible."

**Implementation Evidence:**
- `src/failover/switcher.ts:207-210` — Automatic retry in `performSwitch()` filters with `a.state !== 'UNAVAILABLE'` only, which allows COOLDOWN accounts through: `const others = accounts.filter((a) => a.name !== snapshot.sourceAccount && a.name !== snapshot.targetAccount && a.enabled && a.state !== 'UNAVAILABLE')`.
- `src/failover/switcher.ts:55-73` — `selectSwitchTarget()` correctly filters to `HEALTHY || DEGRADED`, but `performSwitch()` builds its own `targetOrder` without using `selectSwitchTarget()` for the retry list.
- `src/accounts/scorer.ts:92-113` — `selectBestAccount()` correctly implements the `HEALTHY || DEGRADED` filter, but is never called from any daemon or failover production path.

**Issue:** After a primary target fails during automatic failover, the retry loop can select and launch into a COOLDOWN account. This wastes the switch attempt on an account that was recently rate-limited and is likely to hit rate limits again immediately, potentially burning circuit-breaker budget.

**Impact:** Suboptimal failover target selection during automatic retry. May cause cascading failures by launching into accounts still cooling down from prior rate-limit events.

**Fix:** Change `performSwitch()` retry filter at line 209 from `a.state !== 'UNAVAILABLE'` to `a.state === 'HEALTHY' || a.state === 'DEGRADED'`. This aligns with Plan Task 5's eligibility requirement and matches `selectSwitchTarget()`'s existing filter. Alternatively, use `selectSwitchTarget()` to build the retry target list.

**Why This Fix:** Consistent with the plan's eligibility contract. The simplest change is the filter predicate — one line. Using `selectSwitchTarget()` for the retry list would also work but is a larger refactor.

**Fix Validation:** YES — `selectSwitchTarget()` at line 63 already implements the correct filter pattern. The fix is a direct copy of that predicate.

**Validation:** Test: automatic retry with one COOLDOWN account and one HEALTHY account → COOLDOWN is skipped, HEALTHY is selected. Test: all remaining accounts are COOLDOWN → no retry targets → EXHAUSTED.

**Affected Plan Tasks:** Task 5, Task 7

---

#### P1-FULL-009 [HIGH]: `onSwitch` callback does not pass `reason`/`currentScore` to `selectSwitchTarget()` — soft-threshold better-target check bypassed at switch time

**Status:** NEW (2026-05-26 re-audit)

**Source of Truth:** Plan Task 8 rate-limit monitor: "Soft threshold (85%): ... precheck `selectSwitchTarget(reason: "soft_threshold", currentAccount, excludedAccounts)` and require a better target." Plan Task 5: `selectSwitchTarget()` with soft threshold "require a target that is strictly better than the current account for the triggered rate-limit window or weighted score."

**Implementation Evidence:**
- `src/daemon/loop-manager.ts:168-170` — Soft-threshold idle recheck calls `selectSwitchTarget(accounts, session.account, [], { reason: SwitchReason.SoftThreshold, currentScore: currentTelemetryScore(telemetry) })` — correct, enforces "better target."
- `src/daemon/loop-manager.ts:197-200` — Soft-threshold precheck also passes correct `reason` and `currentScore` — correct.
- `src/daemon/index.ts:177` — `onSwitch` callback calls `selectSwitchTarget(accounts, state.account, [])` with NO `opts` parameter. The function's default `opts = {}` means the soft-threshold branch at `switcher.ts:70-72` (`if (opts.reason === SwitchReason.SoftThreshold && typeof opts.currentScore === 'number')`) never fires.
- `src/failover/switcher.ts:70-72` — The soft-threshold "better target" guard only activates when `opts.reason === SwitchReason.SoftThreshold` AND `opts.currentScore` is provided. Without these, the function returns the first eligible account regardless of whether it's better.

**Issue:** The loop-manager correctly pre-checks "is there a better target?" before calling `onSwitch`. But `onSwitch` re-selects a target without that constraint. Between the pre-check and the switch execution, the re-selected target may be different from (or worse than) the pre-checked target. For soft thresholds, this means the daemon can switch to a worse account than the current one — the exact scenario the plan prohibits.

**Impact:** Soft-threshold failover can switch to a worse account. The pre-check in loop-manager is a hollow guard if the actual selection at switch time doesn't enforce the same constraint.

**Fix:** Pass `reason` and `currentScore` from the loop-manager through to the `onSwitch` callback signature, or have `onSwitch` accept and forward the pre-selected target account instead of re-selecting. Simplest approach: change `onSwitch` signature to `(sessionId, reason, opts?: { currentScore?: number })` and forward the opts to `selectSwitchTarget()` at `daemon/index.ts:177`.

**Fix Validation:** YES — `selectSwitchTarget()` already implements the correct branching at lines 70-72. The fix is passing the existing parameters through.

**Validation:** Test: soft-threshold `onSwitch` called with reason `SoftThreshold` + currentScore → `selectSwitchTarget` receives opts → only switches if target score is strictly better. Test: soft-threshold `onSwitch` where no target is better → no switch performed.

**Cascading Side Effects:** P1-FULL-001 (scoring wiring) is a prerequisite — account scores must be non-null for the "better target" comparison to have meaning. Fix P1-FULL-001 first, then P1-FULL-009.

**Affected Plan Tasks:** Task 5, Task 8

---

#### P1-FULL-010 [HIGH]: Canonical journal detail contract remains incomplete for migration and telemetry events

**Source of Truth:** Source plan Task 2 requires canonical event details for migration, failover, threshold, telemetry, tmux timeout, and Slack events. Alignment scan Task 10 requires migration events to include safe source/target path metadata, sizes, and hashes, and requires `telemetry.session_mismatch`, `tmux.command_timeout`, and `slack.message_ignored` details to match the source plan without secrets or transcript contents.

**Implementation Evidence:**
- `src/failover/switcher.ts:181-190` — `migration.completed`/`migration.already_migrated`/`migration.collision_renamed` details include `status`, `source_account`, `target_account`, `source_path`, and `source_sha256`, but omit required `target_path`, `source_size`, `target_sha256`, and reason/collision metadata.
- `src/failover/switcher.ts:181` — `already_migrated` is emitted as `migration.already_migrated`, but the canonical event union and source plan use `migration.skipped_already_migrated`.
- `src/failover/switcher.ts:194-196` — `migration.invalid_path` details are only `{ error: String(err) }`, not the required safe reason enum such as `symlink_rejected`, `not_regular_file`, `wrong_extension`, `outside_source_dir`, `target_parent_symlink`, or `basename_mismatch`.
- `src/statusline/store.ts:35-41` — Invalid JSON returns `null`; no `telemetry.invalid_json` event is emitted.
- `src/daemon/loop-manager.ts:123-131` — `telemetry.session_mismatch` details include only `reason`, `account`, and `cwd`; they omit file path, expected criteria, observed `session_id`, and observed `transcript_path`.
- `rg -n "source_size|target_path|target_sha256|parse_error_summary" src tests` finds no implementation or assertions for the missing canonical fields.

**Issue:** Phase 1 emits some canonical event names but still does not satisfy the required event detail contract for migration forensics and rejected telemetry candidates.

**Impact:** Operators cannot reliably diagnose failed migrations, target transcript integrity, or telemetry rejection causes from the JSONL journal. Phase 2 recovery and cost/validation features would build on incomplete observability.

**Fix:** Add typed detail helpers or explicit event builders for migration and telemetry events. Return structured migration failure reasons from `migrateTranscript()`, include safe target path/size/hash fields on success and collision paths, emit `telemetry.invalid_json` with parse summary and stale flag, and enrich `telemetry.session_mismatch` with safe expected/observed criteria.

**Why This Fix:** It preserves the single canonical event contract required by AGENTS.md and the source plan instead of adding ad hoc hidden status channels.

**Validation:** Add tests around `performSwitch()` migration success/failure events, invalid statusline JSON, and known-session mismatch emission asserting the required fields and absence of secrets/transcript contents.

**Affected Plan Tasks:** Task 2, Task 6, Task 7, alignment scan Task 10

---

#### P1-FULL-011 [HIGH]: Persisted EXHAUSTED sessions are not rehydrated for status or recovery

**Source of Truth:** The EXHAUSTED MVP scope requires preserving the logical session and allowing recovery via `aisup failover --to <account>`. Source plan Task 12 requires `/api/failover` to accept recoverable sessions in `ACTIVE`, `SWITCH_PENDING_AT_IDLE`, or `EXHAUSTED`. Rehydration must reconcile persisted state files and live tmux sessions with persisted state authoritative.

**Implementation Evidence:**
- `src/failover/switcher.ts:313-328` — Post-switch all-target failure persists `status: 'EXHAUSTED'` and clears `switch_tx`.
- `src/daemon/rehydration.ts:153-206` — Rehydration handles `SWITCHING`, `CREATING`, `STOPPING`, `ACTIVE`, `SWITCH_PENDING_AT_IDLE`, and `STOPPED` with live tmux. There is no branch for persisted `EXHAUSTED`, so `setSessionState()` is never called for an exhausted logical session after daemon restart.
- `src/daemon/server.ts:73-74` — `/api/status` returns only the in-memory `sessionState`.
- `src/daemon/server.ts:180-186` — `/api/failover` rejects when `sessionState` is null, so a persisted EXHAUSTED session after daemon restart cannot use the planned manual recovery path.
- `src/daemon/server.ts:141-159` — `DELETE /api/sessions` also requires cached `sessionState?.aisup_session_id`; after daemon restart it returns "no active session" instead of clearing the persisted EXHAUSTED logical session.
- `src/cli/pid.ts:54-61` — Start admission does still block persisted EXHAUSTED state, so the session is preserved enough to block new starts but invisible/unrecoverable through the online API.

**Issue:** A correctly persisted EXHAUSTED session becomes invisible to online status, manual failover, and the online stop path after daemon restart.

**Impact:** The plan's recovery options are broken after restart: `aisup start` remains blocked by persisted EXHAUSTED, while `aisup failover --to <account>` and `aisup stop` report no active session. Operators can be trapped without the intended recovery command.

**Fix:** Add an EXHAUSTED branch in `rehydrateSessions()` that calls `setSessionState({ status: 'EXHAUSTED', aisup_session_id, hasTmux })`, keeps loops skipped, and preserves recovery guidance. Update `/api/failover` and `DELETE /api/sessions` to read persisted state via `sessionManager` when `sessionState` is null but exactly one recoverable persisted session exists.

**Why This Fix:** It keeps session visibility, runner state, and daemon lifetime separate while preserving the source plan's EXHAUSTED manual recovery contract.

**Validation:** Add rehydration/server tests: persisted EXHAUSTED + daemon restart → `/api/status` returns EXHAUSTED; `POST /api/failover` accepts a valid target; `DELETE /api/sessions` clears the logical session; `POST /api/sessions` remains blocked until stop.

**Affected Plan Tasks:** Task 7, Task 12, alignment scan Tasks 5, 9, 14

---

#### P1-FULL-012 [HIGH]: Online status/log/accounts observability uses stale or wrong sources

**Source of Truth:** Goal verification requires `aisup status` to show current session, account, usage, and active workflow skill. Source plan Task 12 requires CLI/API parity for status, log, and account observability. Alignment scan Task 14 requires online/offline status to show persisted session ID, status, account, cwd, tmux name, active skill, and timestamps; `/api/events` must return journal events or the CLI must explicitly use the offline journal correctly; and `accounts` must expose usage bars, health state, cooldown, model, and disabled-account visibility.

**Implementation Evidence:**
- `src/daemon/server.ts:41-52` — The server stores a private in-memory `sessionState` and exposes it through `setSessionState()`.
- `src/daemon/server.ts:73-74` — `/api/status` returns that cached `sessionState` rather than reading `sessionManager.readState()` or `getActiveSession()`.
- `src/daemon/server.ts:170-177` — `/api/accounts` returns only `{ name, state, priority, enabled, score }`; it does not return usage, model, cooldown, or health details required by the source plan/alignment scan.
- `src/daemon/loop-manager.ts:135-138,173,214,270` — The daemon patches persisted session state for telemetry hydration, status transitions, and `active_skill`; none of these updates refresh server `sessionState`.
- `src/daemon/index.ts:236-241` — Automatic switch success updates circuit breaker/account state but does not call `server.setSessionState()` with the new persisted session.
- `src/cli/commands/status.ts:65-77` — Online status prints only session ID/status/account/tmux/cwd and omits `active_skill`, timestamps, telemetry summary, and recovery guidance.
- `src/cli/commands/log.ts:8-16` — `aisup log` always reads `~/.aisup/journal.jsonl`, ignoring the configured `journal.path` and the online `/api/events` route.
- `src/cli/commands/accounts.ts:31-35` — Online `aisup accounts` prints only name/state/score, omitting usage bars, model, cooldown, and disabled-account/config visibility that the offline path partially renders.

**Issue:** Online status can report stale account, skill, and telemetry hydration state after normal loop updates or automatic failover. `aisup log` can read the wrong file when `journal.path` is configured away from the default. Online account observability drops required usage/health/cooldown/model fields.

**Impact:** Operators and live gates cannot rely on `aisup status --json`, `aisup log`, or online `aisup accounts` to observe current Phase 1 runtime state. This weakens failover validation and can hide the exact session/account/usage state before Phase 2 starts.

**Fix:** Make `/api/status` read the current persisted session state on each request, include the planned status fields, and refresh server visibility after automatic switch/exhaustion. Make `/api/accounts` return the same canonical account health/usage/model/cooldown/config visibility used by the offline path. Make `aisup log` use `/api/events` when the daemon is running and `loadConfig().journal.path` for offline reads.

**Why This Fix:** The persisted state file is the canonical supervisor state. Reading it at the API boundary avoids a competing hidden status channel.

**Validation:** Tests for: skill detection patch → `/api/status` shows `active_skill`; automatic failover success → `/api/status` shows target account; online accounts response/CLI includes usage/model/cooldown/disabled visibility; configured non-default journal path → `aisup log` reads the configured path; JSON status includes timestamps and recovery guidance.

**Affected Plan Tasks:** Task 3A, Task 8, Task 12, alignment scan Task 14

---

#### P1-FULL-013 [MEDIUM]: Optional Slack runtime edge contracts remain incomplete

**Source of Truth:** Source plan Task 9 requires Slack channel-name collision logging, bounded output relay queue/rate-limit handling, and `slack.rate_limited` / `slack.queue_dropped` details. Task 10 requires `!stop` to use the canonical terminal stop path.

**Implementation Evidence:**
- `src/slack/service.ts:88-101` — On `name_taken`, the service increments the suffix and retries, but does not emit `slack.channel_name_collision`; it emits that event for non-collision errors instead.
- `src/slack/service.ts:333-377` — Output relay has a polling loop and 5s throttle, but no bounded queue, no `Retry-After` handling, no exponential backoff, and no `slack.rate_limited` event path.
- `src/slack/service.ts:229-235` — Confirmed `!stop` calls `sessionManager.stopSession()` directly but does not append `session.stop` or call `onSessionStop()`, so Slack terminal stops bypass the canonical journal/notification path used by HTTP DELETE in `src/daemon/server.ts:149-156`.

**Issue:** The optional Slack integration works for the happy path but misses planned edge behavior and canonical lifecycle observability.

**Impact:** When Slack is enabled, channel collisions are not diagnosable as specified, Slack 429s are treated as generic queue failures, and `!stop` can terminate a session without the canonical `session.stop` journal event or channel stop notification.

**Fix:** Emit `slack.channel_name_collision` on `name_taken`; add bounded relay queue handling with Slack 429 detection/retry details and `slack.rate_limited`; route Slack `!stop` through the same terminal stop orchestration used by DELETE `/api/sessions` or inject an `onSessionStop` callback that emits the canonical event and channel summary.

**Why This Fix:** It preserves the single event/lifecycle contract while keeping Slack optional.

**Validation:** Slack service tests for name collision event, mocked `chat.postMessage` 429 with retry metadata, queue overflow, and `!stop` producing `session.stop` plus stop notification.

**Affected Plan Tasks:** Task 9, Task 10, alignment scan Task 12

---

#### P1-FULL-014 [MEDIUM]: Live recovery does not distinguish externally destroyed tmux sessions

**Source of Truth:** Source plan Task 8 requires two-phase crash detection: check whether the tmux session exists first; if the session is gone, treat it as a crash with unknown exit code, emit `session.destroyed_externally`, and trigger recovery. Only then should live sessions check `#{pane_dead}`.

**Implementation Evidence:**
- `src/daemon/loop-manager.ts:254` — Recovery tick calls only `isProcessDead(d.tmuxSocket, session.tmux_name)`.
- `src/session/tmux.ts:126-133` — `isProcessDead()` catches tmux errors, including a missing session, and returns `true`.
- `src/daemon/loop-manager.ts:309-314` — The dead path emits `failure.detected`, not `session.destroyed_externally`, and proceeds as if the pane existed but was dead.
- `tests/daemon/loops/loop-manager.test.ts` has live 429 and skill tests but no missing-tmux-session recovery test.

**Issue:** A tmux session destroyed while the daemon is running is not represented by the planned `session.destroyed_externally` event and is not distinguished from an ordinary dead pane.

**Impact:** Runtime evidence loses the boundary between runner crash and external tmux/session destruction. That makes operator diagnosis and recovery audit trails weaker, especially when validating daemon lifecycle behavior before Phase 2.

**Fix:** Add an explicit `hasSession()`/`sessionExists()` wrapper around `tmux has-session -t <name>` with timeout. In `recoveryTick()`, check session existence before `isProcessDead()`, emit `session.destroyed_externally` when absent, scan the last output window for 429 classification, then apply the same restart/switch/exhaustion decision matrix.

**Why This Fix:** It follows the source plan's named runtime boundary and keeps session destruction separate from runner process exit.

**Validation:** Deterministic loop-manager test with mocked missing tmux session → emits `session.destroyed_externally` and triggers same-account restart or switch according to output classification.

**Affected Plan Tasks:** Task 8, Task 12

---

#### P1-FULL-015 [HIGH]: Active-session telemetry binding still accepts candidates without cwd/project identity

**Source of Truth:** Source plan Task 6 requires telemetry hydration to be tied to the active session/account/cwd and to reject stale or unrelated statusline data. Source plan Task 8 depends on correct active-session telemetry for rate-limit decisions. Alignment scan Task 7 requires known-session and pre-hydration telemetry to reject session/account/cwd/project mismatches, including newer unrelated files, with deterministic fixtures.

**Implementation Evidence:**
- `src/statusline/store.ts:108-113` — Known-session telemetry rejects cwd mismatch only when `t.cwd` exists. A telemetry file with the expected `session_id` and account but no cwd is accepted.
- `src/statusline/store.ts:130-147` — Pre-hydration scanning accepts the first fresh same-account transcript candidate and rejects cwd mismatch only when `t.cwd` exists. A newer same-account statusline file with no cwd can be selected for the active supervisor session.
- `src/statusline/types.ts:6-18` — `StatuslineTelemetry` has no typed `workspace.project_dir` field, so the implementation cannot enforce the project-dir identity check required by the alignment scan.
- `src/daemon/rehydration.ts:153-182` — Rehydration restores ACTIVE/SWITCH_PENDING sessions from persisted state and live tmux without validating known telemetry before setting server state.
- `tests/statusline/store.test.ts:230-264` — Existing active-session coverage verifies only the exact known session-id path. It does not cover pre-hydration newer unrelated files, missing cwd, `workspace.project_dir` mismatch, or stale source-account telemetry after failover.

**Issue:** The statusline resolver can bind a logical aisup session to telemetry from a different same-account Claude session when cwd is absent or when project identity is present only under `workspace.project_dir`. Rehydration also skips the planned known-telemetry validation step.

**Impact:** Wrong `claude_session_id`, transcript path, usage, active skill, and failover decisions can be attached to the supervisor session. That can make rate-limit switching and transcript migration operate on the wrong Claude session.

**Fix:** Extend the telemetry type/parser to include safe project identity fields. Reject active-session candidates unless `cwd === expectedCwd` or `workspace.project_dir` matches the expected project directory; reject candidates with neither identity field. Use the same resolver during rehydration for persisted known sessions. Emit structured mismatch details through the canonical telemetry event path from P1-FULL-010.

**Why This Fix:** It keeps telemetry hydration tied to one canonical session identity instead of allowing best-effort same-account matches.

**Validation:** Add statusline fixtures/tests for known-session missing cwd, pre-hydration newer unrelated same-account files, `workspace.project_dir` mismatch, valid `workspace.project_dir` match, and stale source-account telemetry after failover. Add rehydration coverage proving known telemetry is validated before server visibility is restored.

**Affected Plan Tasks:** Task 6, Task 8, Task 12, alignment scan Task 7

---

#### P1-FULL-016 [MEDIUM]: Same-account restart counter escalates late and never resets on successful restart

**Source of Truth:** Source plan Task 8 requires process crash recovery to attempt same-account restart first, then switch after three restart failures within five minutes. The planned recovery state machine resets failure counters after successful restart.

**Implementation Evidence:**
- `src/daemon/loop-manager.ts:344-366` — The restart threshold check runs before incrementing the current failure count. With `MAX_RESTARTS_BEFORE_SWITCH = 3`, the code restarts on counts 1, 2, and 3, then escalates only on the next dead tick.
- `src/daemon/index.ts:244-269` — `onRestart` returns `void` and only logs success/failure internally, so `LoopManager` has no success signal.
- `src/daemon/loop-manager.ts:366` — After `await d.onRestart(session.aisup_session_id)`, the restart counter is not cleared on success.
- `tests/daemon/loops/loop-manager.test.ts` has no deterministic test for three restart failures, successful restart counter reset, or escalation timing.

**Issue:** The live recovery state machine performs one extra same-account restart beyond the planned threshold and keeps stale restart-attempt counters after a successful restart.

**Impact:** A crash loop can burn extra time before switching accounts. Conversely, a later unrelated crash can inherit stale restart history and switch earlier than intended. Both behaviors violate the planned recovery contract and make runtime evidence harder to reason about.

**Fix:** Make `onRestart` return an explicit success/failure result or have `LoopManager` verify post-restart state. Increment and evaluate restart attempts around actual restart failures, not dead-tick observations alone. Clear the counter after a successful restart and escalate immediately when the third failed restart occurs inside the five-minute window.

**Why This Fix:** It keeps the recovery loop as a single explicit state machine rather than inferring restart success from future ticks.

**Validation:** Add loop-manager tests for: first and second failed restart stay on same account; third failed restart escalates to `SwitchReason.RestartFailures`; successful restart clears the counter; a later crash starts a fresh counter window.

**Affected Plan Tasks:** Task 8

---

### Phase 1 Compliance Audit Methodology

**Requirements traced:** All 14 Phase 1 tasks (Tasks 1–14) from the source plan. Material Definition of Done items traced to implementation evidence. Alignment scan (16 tasks) validated at requirement level. Current iteration 16 refresh confirmed P1-FULL-001 through P1-FULL-006 and P1-FULL-008 through P1-FULL-016 remain current; P1-FULL-007 remains rejected as unsupported. No new supported Phase 1 compliance issues were found.

**Files and docs read:**
- `docs/plans/2026-04-29-aisup-supervisor-daemon.md` (full, 1143 lines)
- `docs/plans/2026-05-07-phase1-alignment-scan.md` (full, 766 lines)
- `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md` (existing output, refreshed in place)
- `src/daemon/index.ts` (full, 331 lines)
- `src/daemon/server.ts` (full, 249 lines)
- `src/daemon/loop-manager.ts` (full, 408 lines)
- `src/daemon/rehydration.ts` (full, 225 lines)
- `src/failover/switcher.ts` (full, 331 lines)
- `src/session/manager.ts` (lines 180–338)
- `src/accounts/registry.ts` (full, 67 lines)
- `src/accounts/scorer.ts` (full, 115 lines)
- `src/runner/builder.ts` (key lines)
- `src/cli/pid.ts` (full, 122 lines)
- `src/cli/commands/start.ts` (full, 94 lines)
- `src/cli/commands/attach.ts` (full, 39 lines)
- `src/cli/commands/status.ts` (full, 95 lines)
- `src/cli/commands/log.ts` (full)
- `src/cli/commands/accounts.ts` (full)
- `src/cli/commands/doctor.ts` (full)
- `src/daemon/loops/health-checker.ts` (full)
- `src/daemon/loops/recovery-handler.ts` (full)
- `src/slack/service.ts` (full)
- `src/statusline/store.ts` (full)
- `src/statusline/types.ts` (full)
- `README.md` (operator-facing documentation)
- `docs/runbook.md` (operator-facing documentation)
- `tests/statusline/store.test.ts` (active-session coverage)
- `tests/daemon/loops/loop-manager.test.ts` (recovery-loop coverage)

- `npm run typecheck` — passed
- `npm test` — passed: 273 tests passed, 11 tmux-backed tests skipped, 0 failed
- `npx vitest run tests/failover/ tests/daemon/loops/ tests/daemon/rehydration.test.ts tests/statusline/ tests/slack/ tests/cli/` — passed, 161 tests
- `git rev-parse --short HEAD` — `297fb42`
- `git diff --stat` — implementation source unchanged; dirty files are `.gitignore` and `docs/plans/2026-05-07-phase1-alignment-scan.md`
- `git diff --stat -- src tests package.json` — no implementation source/test/package changes
- `rg -n "selectBestAccount|scoreAccount|applyTelemetry|setScore" src/daemon src/failover src/cli src/accounts` — scorer helpers only defined in accounts modules; no daemon/failover/CLI production usage (P1-FULL-001)
- `rg -n "bestAccount|sort\\(\\(a, b\\) => a\\.priority|selectSwitchTarget|terminal: true|buildResumeCommand|claudeSessionId|a\\.state !== 'UNAVAILABLE'|status: 'EXHAUSTED'|session\\.exhausted|session\\.stop|onIdle|restartInPlace|accountConfigDir: ''" src/daemon/index.ts src/daemon/server.ts src/failover/switcher.ts src/session/manager.ts src/cli/commands/start.ts` — confirmed P1-FULL-001 through P1-FULL-009 evidence, and rejection evidence for P1-FULL-007
- `rg -n "RehydrationDeps|source_destroyed|needs_manual_failover|session\\.destroyed_externally|recovery\\.failed|recovery\\.success" src/daemon/rehydration.ts` — confirmed detection-only recovery and no EXHAUSTED rehydration (P1-FULL-004, P1-FULL-011)
- `rg -n "migration\\.completed|migration\\.invalid_path|telemetry\\.invalid_json|telemetry\\.session_mismatch|source_size|target_path|target_sha256|parse_error_summary" src tests` — confirmed missing canonical detail fields and tests (P1-FULL-010)
- `rg -n "get\\('/api/status'|setSessionState|sessionState|patchState\\(|active_skill|showStatus|showLog|journal\\.jsonl|api/accounts|showAccounts|usage|model|cooldown|disabled|health" src/daemon/server.ts src/daemon/index.ts src/daemon/loop-manager.ts src/cli/commands/status.ts src/cli/commands/log.ts src/cli/commands/accounts.ts` — confirmed stale status/log/accounts sources (P1-FULL-012)
- `rg -n "name_taken|channel_name_collision|rate_limited|Retry-After|queue|postMessage|sessionManager\\.stopSession|event_type: 'session.stop'" src/slack src/daemon/server.ts src/daemon/index.ts` — confirmed Slack edge-contract gaps (P1-FULL-013)
- `rg -n "has-session|destroyed_externally|isProcessDead|paneDead|tmux session" src/daemon/loop-manager.ts src/session/tmux.ts tests/daemon/loops/loop-manager.test.ts` — confirmed missing live `has-session` distinction (P1-FULL-014)
- `rg -n "workspace|project_dir|cwd|telemetry\\.session_mismatch|readTelemetryForSession|readTelemetryForActiveSession|invalid_json" src/statusline src/daemon/rehydration.ts tests/statusline` — confirmed incomplete telemetry identity enforcement and missing pre-hydration/project-dir fixtures (P1-FULL-015)
- `rg -n "restartAttempts|onRestart|recovery\\.restart_same_account|restart_fresh_no_session_id|same-account|same account|3 within 5|RestartFailures" src/daemon src/session tests/daemon/loops` — confirmed late restart escalation and missing counter-reset tests (P1-FULL-016)
- `grep -n 'runner.terminated_for_switch' src/failover/switcher.ts` — line 156, confirmed present (compliant)
- `grep -n 'session\.stop' src/failover/switcher.ts` — 0 matches (compliant — failover does not emit session.stop)
- `grep -n 'daemon\.ready' src/daemon/index.ts` — line 295, emitted after `loopManager.startAll()` and `server.setReady()` (compliant)
- `grep -n 'randomUUID' src/daemon/server.ts` — line 112, uses `crypto.randomUUID()` (compliant)
- `grep -n 'config_dir_env' src/runner/builder.ts` — line 7, uses configured env var name (compliant)
- `grep -n 'circuit_breaker' src/daemon/index.ts` — lines 43-44 constructed, line 171 passed to loop-manager, line 240 recordSuccess (wired)

**Compliant areas verified (no issues found):**
- Session identity uses `crypto.randomUUID()` (Plan Task 3A)
- `runner.terminated_for_switch` emitted during failover, `session.stop` never emitted by switcher (Plan Task 2, Task 7)
- Daemon startup sequence: `loopManager.startAll()` → `server.setReady()` → `daemon.ready` → Slack async non-blocking (Plan Task 12)
- Runner builder uses configured `config_dir_env` from config, not hardcoded `CLAUDE_CONFIG_DIR` (Plan Task 4)
- Circuit breaker constructed, passed to loop-manager deps, `recordSuccess` called on successful switch (Plan Tasks 5, 8)
- `DELETE /api/sessions` honors `force` flag (Plan Task 3A)
- `session.start` emitted from POST `/api/sessions` (Plan Task 3A)
- `selectSwitchTarget()` correctly filters HEALTHY/DEGRADED and enforces soft-threshold better-target when called with opts (Plan Task 5)
- Switch transaction (`switch_tx`) persisted before each phase transition in `performSwitch()` (Plan Task 7)
- Post-switch all-targets-exhausted path correctly persists EXHAUSTED and emits `session.exhausted` in switcher (Plan Task 7)
- Attach command uses configured tmux socket (`-L aisup`) (Plan Task 12)

**Skipped checks and residual uncertainty:**
- Live runtime testing (daemon start, actual failover) not performed — would require tmux session and multi-account setup
- Slack integration paths not runtime-verified — tested only by unit test mocks
- Live acceptance gates (Task 13) are operator-gated and not audited here
- Alignment scan task-by-task completion status not individually reclassified in this output (P1-FULL-006 covers the progress tracking gap)

**Relationship to prior findings:** P1-FULL-001 through P1-FULL-004 directly confirm the 4 prior Phase 1 addendum findings (P1-CR-001, P1-CR-002, P1-CR-003, P1-HI-001) remain unfixed. P1-FULL-005 and P1-FULL-006 remain current. P1-FULL-007 remains rejected as unsupported by the current code path. P1-FULL-008 through P1-FULL-016 remain current after the iteration 16 full-plan validation. No new P1-FULL findings were added in this refresh.

**Current conclusion (2026-05-27, iteration 16 independent re-audit):** 15 current Phase 1 compliance issues remain: 3 CRITICAL, 8 HIGH, 4 MEDIUM. One historical issue (P1-FULL-007) is rejected. Typecheck passed. Full Vitest suite passed with 273 tests passed, 11 tmux-backed tests skipped, and 0 failed. No implementation fixes were made during this audit; only this review artifact was updated. Sixth independent re-audit confirms no new Phase 1 compliance gaps exist and all 15 previously identified issues remain unfixed.
