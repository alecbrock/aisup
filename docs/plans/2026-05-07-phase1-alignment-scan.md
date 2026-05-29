# Phase 1 Plan Alignment Scan

Created: 2026-05-07
Author: alec.m.brock@gmail.com
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Fix all gaps found by line-by-line scans of Phase 1 implementation against the source-of-truth plan (`docs/plans/2026-04-29-aisup-supervisor-daemon.md`). The original 10 gaps in this file are real. Codex re-audited the current HEAD (`3cb0948`) on 2026-05-11 against the source plan, handoff, completion plan, prior blocking review (`docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md`), and current source files; the original 15 remediation tasks remain supported, this scan adds one startup/readiness sequencing gap, and Task 14 now includes a missed attach/socket parity gap that must be resolved before Phase 1 can be considered complete.

**Architecture:** Surgical fixes to existing modules where possible, with focused test additions as needed. Changes touch: `switcher.ts` (switch_tx persistence + resume + target-attempt cleanup), `daemon/index.ts` and `server.ts` (start/failover/stop wiring, Slack lifecycle, runner validation, startup readiness), `session/manager.ts` and `tmux.ts` (restart, output rotation, state predicates), `rehydration.ts` (state/tmux union recovery), `statusline/store.ts` and `loop-manager.ts` (active-session telemetry binding, skill wiring, mismatch events), `slack/service.ts` (relay poller and command safety), `cli/commands/*` (offline/status/json/doctor/accounts/attach parity), `config/loader.ts` (path and prerequisite validation), and tests.

**Tech Stack:** TypeScript, Node.js 22, vitest

## Scope

### In Scope

- BLOCKER: Persist switch_tx to state file at each performSwitch phase transition
- HIGH: Use buildResumeCommand when claude_session_id available during switch
- HIGH: Use respawnPane canonical restart primitive for same-account restart
- MEDIUM: Output relay interval poller in SlackService
- HIGH: Scan live pipe-pane output for PTY 429 strings before pane death
- MEDIUM: Wire skill detector/tracker into daemon recovery tick
- MEDIUM: Emit session.exhausted event when all switch targets fail
- MEDIUM: Offline status reads state files when daemon not running
- LOW: Doctor validates statusline command script path + quoted paths
- LOW: Doctor reports model_id, context_window_size, and total_cost_usd per account
- LOW: Emit telemetry.session_mismatch from rate-limit tick
- BLOCKER: Use persisted state/tmux union for start admission, dry-run, and EXHAUSTED blocking
- BLOCKER: Complete transaction-safe switch failure handling, failed-target cleanup, and stale-source/target identity checks
- BLOCKER: Bind active-session telemetry by known `claude_session_id` when present; never hydrate from unrelated same-cwd files
- HIGH: Rehydration must recover persisted state-without-tmux and interrupted switch transactions, not only live tmux sessions
- HIGH: Soft-threshold switch selection must require a strictly better target, not just any eligible account
- HIGH: Canonical journal events need required detail payloads, not only event names
- HIGH: Session output logs need rotation and scanner cursor reset
- HIGH: Slack channel lifecycle must be wired to session start/stop/failover, not only command handling
- HIGH: Circuit breaker and account health state must be wired into recovery/failover selection
- MEDIUM: CLI/API parity gaps: `status --json`, `accounts` usage output, `stop --force`, `/api/events`, attach socket handling, and plan path persistence
- MEDIUM: Config and runner validation must match the plan's path, account, Slack, and absolute-runner requirements
- HIGH: Daemon readiness must not be set before monitoring loops are registered; Slack startup must happen after READY and must not block core supervision

### Out of Scope

- Task 13 live acceptance gates (operator action)
- Phase 2 features (prompt detection modes beyond default `never`, multi-session, validation gate engine)

## Approach

**Chosen:** Direct surgical fixes — each gap is a targeted edit to an existing module with a specific test.

**Why:** All modules exist and work. The gaps are specific missing behaviors, not architectural issues.

**Alternatives considered:**
- Batch refactor: Restructure modules to make gaps impossible. Overkill — the existing architecture is sound, just missing specific wiring.

## Context for Implementer

- **performSwitch:** `src/failover/switcher.ts` — constructs local `switchTx` variable but never calls `sessionManager.patchState()` with it. Fix: add `patchState({ switch_tx: switchTx })` before each phase's action.
- **buildResumeCommand:** `src/runner/builder.ts:32` — already exists, takes `(config, accountConfigDir, claudeSessionId)`. The daemon's `createSessionForTarget` callback at `src/daemon/index.ts:~167` always calls `buildLaunchCommand`. Fix: check `snapshot.claudeSessionId`, use `buildResumeCommand` when non-null.
- **respawnPane:** `src/session/tmux.ts:125` — already exists, takes `(socket, name, cwd, env)`. The daemon's `onRestart` at `src/daemon/index.ts:~182` calls `sessionManager.createSession()` (new tmux session). Fix: add `SessionManager.restartInPlace()` that uses respawnPane + startOutputLog + send-keys exec.
- **SlackService relay:** `src/slack/service.ts` — has `relayEnabled` map but no interval poller. Fix: add `startRelay()/stopRelay()` methods with setInterval that reads the session pipe-pane output log via the shared cursor model, diffs from the last offset, redacts, truncates, and posts.
- **Live output scanning:** `src/skills/detector.ts` has `detectSkillInvocation()`, `src/skills/tracker.ts` has `SkillTracker`, and `RecoveryHandler.detect429InOutput()` exists, but live loop wiring does not scan new pipe-pane output while the pane is alive. Fix: add a shared output-log cursor scan on recovery tick for live `ACTIVE`/`SWITCH_PENDING_AT_IDLE` sessions; scan new output for both PTY 429 patterns and skill invocations before advancing the cursor.
- **Status offline:** `src/cli/commands/status.ts` — prints "not running" when no PID file. Fix: read `~/.aisup/sessions/*/state.json` and display persisted session state.
- **Doctor statusline:** `src/cli/commands/doctor.ts` — no statusline command validation. Fix: read each account's `<config_dir>/settings.json`, parse `statusLine.command` with a shell-word parser, and validate the script/executable path.
- **Doctor telemetry diagnostics:** Doctor doesn't read statusline telemetry. Fix: for each account, read telemetry via `readTelemetryForAccount()`, display `model.id`, `context_window.context_window_size`, and `cost.total_cost_usd`.
- **Attach socket parity:** Sessions are created on the configured tmux socket (`tmuxSocket = 'aisup'` in `src/daemon/index.ts`), but `src/cli/commands/attach.ts:38` calls `tmux attach-session -t <name>` without `-L aisup`, so `aisup attach` can look at the default tmux server instead of the supervised session.

## Assumptions

- `buildResumeCommand` correctly adds `--resume <sessionId>` — supported by runner tests — Task 1 and Task 6 depend on this.
- `respawnPane` correctly respawns a dead pane — supported by `tmux.test.ts` integration test — Task 3 depends on this.
- `readTelemetryForAccount` is for account scoring only and may return historical telemetry. It must not be used for session identity hydration — Task 7 depends on this distinction.
- `detectSkillInvocation` correctly identifies skills from text — supported by 11 passing detector tests — Task 3 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| switch_tx persistence adds I/O on every phase transition | Low | Low | Single atomic writeFileSync per phase (< 1ms); same pattern as existing writeState |
| respawnPane on dead pane may fail if tmux session is also gone | Medium | Medium | Check if tmux session exists before respawn; fall back to createSession if gone |
| Output relay poller adds CPU/disk load on active sessions | Low | Low | Only runs when relay_output_enabled=true AND relay is toggled on |

## Goal Verification

### Truths

1. Daemon crash during any performSwitch phase recovers correctly on restart (switch_tx persisted)
2. Account switch resumes claude_session_id when available, launches fresh when null
3. Same-account restart uses respawnPane canonical primitive, not createSession
4. Slack output relay posts redacted tmux output to channel when enabled
5. Live output-log scanning detects PTY 429 strings and skill transitions, then journals the corresponding events
6. `aisup status` shows session info when daemon is not running
7. Doctor reports model_id/context_window_size/total_cost_usd per account and validates statusline command path
8. `aisup start` is blocked by any persisted non-terminal or recoverable logical session, including EXHAUSTED and state-without-tmux cases
9. Account switches either complete, retry to a valid target, or preserve recoverable EXHAUSTED state with canonical events
10. Active-session telemetry belongs to the supervised cwd, current account, and known Claude session ID when present
11. Rehydration reconciles persisted state and live tmux sessions in both directions
12. Output log rotation resets all scanners and emits `output_log.rotated`
13. Slack channel creation, command handling, relay, redaction, and channel-map restoration are wired end to end
14. Circuit breaker state influences account eligibility and recovery escalation
15. CLI and HTTP routes expose the Phase 1 status/log/accounts/failover/attach contract without stubs or socket mismatches
16. Daemon startup exposes non-health APIs only after rehydration plus loop registration, emits `daemon.ready`, and starts Slack after readiness without blocking core supervision

### Artifacts

1. `src/failover/switcher.ts` — switch_tx persisted via patchState at each phase
2. `src/daemon/index.ts` — createSessionForTarget uses buildResumeCommand, onRestart uses restartInPlace, session.exhausted emitted
3. `src/session/manager.ts` — restartInPlace() method
4. `src/slack/service.ts` — output relay poller
5. `src/daemon/loop-manager.ts` — live 429 scan, skill detection wiring, telemetry mismatch event
6. `src/cli/commands/status.ts` — offline state file reader
7. `src/cli/commands/doctor.ts` — statusline command + model/context/cost checks
8. `src/daemon/server.ts` / `src/cli/commands/start.ts` / `src/cli/pid.ts` — canonical start admission and dry-run validation
9. `src/daemon/rehydration.ts` — full persisted-state/live-tmux reconciliation and switch_tx recovery
10. `src/statusline/store.ts` — known-session telemetry resolver and detailed mismatch reporting
11. `src/session/manager.ts` / `src/util/rotating-log.ts` or equivalent — session output-log rotation
12. `src/accounts/*` and `src/daemon/loops/*` — circuit breaker and account health integration
13. `src/cli/commands/attach.ts` — attach uses the same configured tmux socket as session creation
14. `src/daemon/index.ts` — source-plan startup order and readiness boundary

## Progress Tracking

- [ ] Task 1: Persist switch_tx during performSwitch + resume support
- [ ] Task 2: Canonical restart primitive (respawnPane) + session.exhausted event
- [ ] Task 3: Output relay poller + live output 429/skill wiring + telemetry mismatch event
- [ ] Task 4: CLI offline status + doctor statusline/model/cost reporting
- [ ] Task 5: Canonical start admission, session identity, and lifecycle events
- [ ] Task 6: Transaction-safe switch target attempts and stale-source identity recovery
- [ ] Task 7: Active-session telemetry binding and mismatch diagnostics
- [ ] Task 8: Soft-threshold better-target selection
- [ ] Task 9: Full rehydration recovery matrix
- [ ] Task 10: Canonical journal detail contract
- [ ] Task 11: Session output-log rotation and scanner reset
- [ ] Task 12: Slack lifecycle and relay completion
- [ ] Task 13: Circuit breaker and health integration
- [ ] Task 14: CLI/API/Attach parity completion
- [ ] Task 15: Config and runner validation alignment
- [ ] Task 16: Daemon readiness and startup sequencing
      **Total Tasks:** 16 | **Completed:** 0 | **Remaining:** 16

## Implementation Tasks

### Task 1: Persist switch_tx and Resume Support

**Objective:** Fix the BLOCKER: persist switch_tx to state file at each performSwitch phase transition. Fix HIGH: use buildResumeCommand when claude_session_id is available during account switch.

**Dependencies:** None

**Files:**

- Modify: `src/failover/switcher.ts`
- Modify: `src/daemon/index.ts`
- Modify: `tests/failover/switcher.test.ts`

**Key Decisions / Notes:**

- **switch_tx persistence:** In `performSwitch()`, after constructing `switchTx` and before each phase's action (terminate, migrate, create target), call `deps.sessionManager.patchState(snapshot.aisupSessionId, { switch_tx: switchTx })`. This writes the current switch_tx to `~/.aisup/sessions/<id>/state.json` atomically (tmp+rename via existing `writeState`).
- **Resume support:** In the daemon's `createSessionForTarget` callback (`src/daemon/index.ts:~167`), check `snapshot.claudeSessionId`. If non-null, call `buildResumeCommand(config.runner, acct.configDir, snapshot.claudeSessionId)` instead of `buildLaunchCommand`. `buildResumeCommand` only throws when `claudeSessionId === null` (precondition violation) — since we check non-null first, this won't happen. Runner-not-found errors are fatal and should propagate (not fallback silently). Fallback to `buildLaunchCommand` happens only when `claudeSessionId` is null.
- **Phase timestamps:** Each `switchTx.phase_timestamps[phase]` is set to `new Date().toISOString()` (ISO-8601) before the phase action.
- **switch_tx retry lifecycle:** `switchTx.tried_accounts` and `switchTx.attempts[]` are populated on each target attempt. On rehydration, if `switch_phase` is non-null, the recovery table uses both the phase value and current-attempt tmux identity to decide whether to clean up stale source, resume a confirmed target, retry, or preserve recoverable `EXHAUSTED`. After performSwitch completes (success, exhausted, or failed), `patchState({ switch_tx: null })` clears the tx only after final session state has been persisted.

**Definition of Done:**

- [ ] `performSwitch()` calls `patchState({ switch_tx })` before terminate, migrate, and create-target phases
- [ ] `switchTx.tried_accounts` populated on each target attempt
- [ ] `switchTx.phase_timestamps` entries are ISO-8601 strings
- [ ] After switch completes (success or failure), switch_tx is cleared from state (`patchState({ switch_tx: null })`)
- [ ] Daemon's createSessionForTarget uses `buildResumeCommand` when `snapshot.claudeSessionId` is non-null
- [ ] Server/manual failover createSessionForTarget uses account-specific `buildResumeCommand`/`buildLaunchCommand`, not daemon startup's first-account runner config
- [ ] Fallback to `buildLaunchCommand` only when claudeSessionId is null (not on runner errors)
- [ ] Journal emits `recovery.restart_fresh_no_session_id` when falling back to fresh
- [ ] Test verifies switch_tx written to state file during performSwitch
- [ ] Test verifies phase_timestamps are ISO-8601 format

**Verify:**

- `npx vitest run tests/failover/`

---

### Task 2: Canonical Restart Primitive and session.exhausted Event

**Objective:** Fix HIGH: use respawnPane for same-account restart (not createSession). Fix MEDIUM: emit session.exhausted when all targets fail.

**Dependencies:** None

**Files:**

- Modify: `src/session/manager.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`

**Key Decisions / Notes:**

- **SessionManager.restartInPlace(aisupSessionId, command, args, env):** New method that: (1) reads current state, (2) checks tmux session exists via `listSessions()` — if session name not found, skips respawn and falls back to `createSession` (log `recovery.restart_fresh_no_session_id`), (3) calls `respawnPane(socket, tmuxName, state.cwd, env)`, (4) calls `startOutputLog(socket, tmuxName, state.output_log_path)`, (5) uses `sendText` + `sendEnter` to send `exec <command> <args>` via `singleQuote` escaping, (6) writes ACTIVE state.
- **onRestart callback:** In daemon/index.ts, replace `sessionManager.createSession(...)` with `sessionManager.restartInPlace(...)`.
- **session.exhausted event:** In the daemon's `onSwitch` callback, after `performSwitch` returns `exhausted` status, emit `session.exhausted` event and set session state to EXHAUSTED via `patchState`.
- **Why respawnPane over createSession:** Plan explicitly says "Recovery uses canonical restart primitive (respawn-pane, not send-keys to dead pane)". Respawning reuses the existing tmux session, preserving session identity (tmux_name, pipe-pane path) without cleanup/recreation overhead.

**Definition of Done:**

- [ ] `SessionManager.restartInPlace()` checks session exists via listSessions before respawn
- [ ] restartInPlace uses respawnPane → startOutputLog → send-keys exec → sendEnter when session exists
- [ ] restartInPlace falls back to createSession when tmux session no longer exists, logs recovery event
- [ ] Daemon onRestart callback calls restartInPlace instead of createSession
- [ ] Daemon onSwitch callback emits `session.exhausted` and sets EXHAUSTED state when performSwitch returns exhausted
- [ ] Test verifies session.exhausted emitted when onSwitch gets exhausted result

**Verify:**

- `npx vitest run tests/daemon/loops/ tests/session/`

---

### Task 3: Output Relay Poller + Live Output 429/Skill Wiring + Telemetry Mismatch Event

**Objective:** Fix MEDIUM: implement Slack output relay interval poller. Fix HIGH: scan live pipe-pane output for PTY 429 strings and skill invocations instead of only inspecting output after a pane is already dead. Fix LOW: emit telemetry.session_mismatch from rate-limit tick.

**Dependencies:** None

**Files:**

- Modify: `src/slack/service.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `tests/slack/service.test.ts`

**Key Decisions / Notes:**

- **Output relay poller:** In `SlackService`, add `private relayHandle: NodeJS.Timeout | null`, a per-session/channel output cursor `{path, offset, generation}`, and `private lastPostTime: Map<string, number>` (per-channel throttle timestamps). When `relay_output_enabled: true` in config, start a 10s interval in `start()` that: (1) iterates sessions with relay enabled, (2) reads new bytes from `session.output_log_path` since the cursor offset — catch errors, log to journal, continue to next, (3) coalesces/truncates to Slack-safe chunks, (4) if new content AND elapsed since lastPostTime >= 5000ms, `redactSecrets()` and `chat.postMessage()` — catch postMessage errors, log `slack.rate_limited` or `slack.queue_dropped` to journal, don't crash, (5) update cursor and lastPostTime on successful post. Stop interval in `stop()`. `capture-pane` remains for explicit `!status`, not auto-relay.
- **Live 429 + skill wiring:** In `LoopManager.recoveryTick()`, for live `ACTIVE` and `SWITCH_PENDING_AT_IDLE` panes, read new bytes from `session.output_log_path` using the recovery/output cursor instead of blindly advancing to EOF. Scan that new content with `detect429InOutput()` and `detectSkillInvocation()` before advancing the cursor. A live 429 match triggers immediate `onSwitch(sessionId, SwitchReason.RateLimit429)` and emits `failure.detected`; it must not wait for the pane to die. `detectSkillInvocation` uses exact regex patterns (e.g., `Launching skill: spec-plan`, `Launching skill: fix`) — NOT arbitrary `/` paths. See `tests/skills/detector.test.ts` for false-positive rejection of `/path/to/file`. If a skill is detected, emit `skill.detected` journal event and update session state `active_skill` via `patchState`. Dead-pane recovery still scans the bounded last/new output window for 429 classification as described in Task 9.
- **telemetry.session_mismatch:** In `LoopManager.rateLimitTick()`, when `readTelemetryForActiveSession()` returns null AND the session has a `claude_session_id`, call `readTelemetryForSession(claudeSessionId, accountConfigDir, cwd, statuslineDir)`. If it returns a `mismatch` string (e.g., transcript account mismatch, cwd mismatch, session_id mismatch), emit `telemetry.session_mismatch` journal event as a warning. This indicates a telemetry lookup issue, not necessarily a critical error.

**Definition of Done:**

- [ ] SlackService starts relay interval when relay_output_enabled=true and relay is toggled on
- [ ] Relay posts new pipe-pane output-log diffs to channel with redaction and truncation
- [ ] Relay stops on service stop
- [ ] Recovery tick scans live output-log deltas for 429 strings before advancing the cursor
- [ ] Live 429 output triggers immediate account switch without waiting for pane death
- [ ] Recovery tick scans live output-log deltas for skill invocations via detectSkillInvocation
- [ ] Skill transitions emitted as `skill.detected` journal events
- [ ] Rate-limit tick emits `telemetry.session_mismatch` when known session telemetry mismatches
- [ ] Test verifies relay posts to channel when new output exists

**Verify:**

- `npx vitest run tests/slack/ tests/daemon/loops/`

---

### Task 4: CLI Offline Status + Doctor Statusline/Model/Cost Reporting

**Objective:** Fix MEDIUM: make `aisup status` work offline by reading state files. Fix LOW: doctor validates statusline command script path, handles quoted paths, and reports model_id/context_window_size/total_cost_usd per account.

**Dependencies:** None

**Files:**

- Modify: `src/cli/commands/status.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `tests/cli/scaffold.test.ts`

**Key Decisions / Notes:**

- **Offline status:** When daemon is not running (no PID file or PID dead), read `~/.aisup/sessions/*/state.json` directly. For each session, display: aisup_session_id, status, account, tmux_name, last updated_at. This gives operators visibility into persisted session state even when daemon is down.
- **Doctor statusline command validation:** For each account, read `<config_dir>/settings.json`; if `statusLine.command` is present, parse the shell string with a POSIX shell-word parser, extract the script/executable path (handling interpreter wrappers and single/double quotes), and verify the script file exists and is readable/executable as appropriate.
- **Doctor model/context/cost diagnostics:** For each account, call `readTelemetryForAccount(acct.config_dir, config.statusline.directory, config.statusline.freshness_window_s)`. If telemetry found, display `model.id`, `context_window.context_window_size`, and `cost.total_cost_usd` from telemetry. If not found, display "no telemetry".

**Definition of Done:**

- [ ] `aisup status` shows persisted session state when daemon is not running
- [ ] Offline status shows session ID, status, account, last updated time
- [ ] Doctor validates statusline command script path when available
- [ ] Doctor handles quoted paths in statusline command
- [ ] Doctor displays model_id, context_window_size, and total_cost_usd per account (format: `Account | Model | Context Window | Total Cost` with `—` for missing/stale)
- [ ] Doctor warns when telemetry is older than freshness_window_s or missing entirely
- [ ] Tests verify offline status output format

**Verify:**

- `npx vitest run tests/cli/`

---

### Task 5: Canonical Start Admission, Session Identity, and Lifecycle Events

**Objective:** Fix BLOCKER: `aisup start` and `--dry-run` must use persisted session state plus live tmux state, not only daemon memory. Fix session identity/lifecycle gaps: generated IDs must be UUIDs, `--plan` must be persisted, `--force` must reach `stopSession()`, and start/stop events must be journaled.

**Dependencies:** Task 9 rehydration helpers may share the same persisted-state/tmux scan.

**Files:**

- Modify: `src/daemon/server.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/commands/stop.ts`
- Modify: `src/cli/pid.ts`
- Modify: `src/session/manager.ts`
- Modify: `tests/cli/scaffold.test.ts`
- Modify: `tests/daemon/server.test.ts`
- Add/modify focused tests for persisted EXHAUSTED and STOPPED-with-live-tmux admission

**Key Decisions / Notes:**

- **Evidence:** `src/daemon/server.ts` currently calls `canStartNewSession(sessionState)`, where `sessionState` is in-memory and may be null even when a persisted `EXHAUSTED`, `ACTIVE` without tmux, or `SWITCHING` state exists. `src/cli/commands/start.ts` `--dry-run` prints only static text and does not validate config, cwd, account selection, or the single-session predicate. `POST /api/sessions` checks only `existsSync(cwd)` rather than verifying a directory, generates `${Date.now()}-${Math.random()...}` instead of a UUID, and ignores `plan`. DELETE `/api/sessions` ignores the request body's `force` flag.
- **Canonical predicate:** Add a shared `getBlockingSession()`/`canStartNewSession()` path that scans `~/.aisup/sessions/*/state.json` plus live `aisup-*` tmux sessions before every start request and dry run. Allow only no session, or a single `STOPPED` session with no live tmux. Block `CREATING`, `ACTIVE`, `SWITCH_PENDING_AT_IDLE`, `SWITCHING`, `STOPPING`, and `EXHAUSTED` with the source-plan messages.
- **Identity:** Use `crypto.randomUUID()` for `aisup_session_id`; keep stable tmux name `aisup-<first8>`.
- **Plan path:** Validate `--plan` exists/readable, store its absolute path as `plan_path` in session state, and include it in continuation prompt inputs.
- **Lifecycle events:** Emit `session.start` after successful create and `session.stop` only for user/API/Slack terminal stop paths. Failover source termination must continue to emit `runner.terminated_for_switch`, never `session.stop`.
- **Force stop:** Parse DELETE `/api/sessions` body and pass `{ force: true }` through to `stopSession()` when requested.

**Definition of Done:**

- [ ] `aisup start --dry-run` validates cwd/config/start admission/account selection and prints selected account plus launch command without creating state
- [ ] POST `/api/sessions` rejects a cwd that exists but is not a directory
- [ ] POST `/api/sessions` checks persisted state and live tmux before creating a session
- [ ] Persisted `EXHAUSTED` blocks `aisup start` until `aisup stop`
- [ ] Persisted `ACTIVE` or `SWITCH_PENDING_AT_IDLE` with missing tmux blocks start and is routed to recovery/doctor guidance, not silently replaced
- [ ] STOPPED-with-live-tmux is rejected as inconsistent/orphaned
- [ ] `aisup_session_id` is a UUID and tmux name uses `aisup-<first8>`
- [ ] `--plan` is validated and stored in `state.plan_path`
- [ ] DELETE `/api/sessions` honors `force`
- [ ] `session.start` and terminal `session.stop` events include session/account/cwd details without secrets

**Verify:**

- `npx vitest run tests/cli/ tests/daemon/server.test.ts tests/session/manager.test.ts`

---

### Task 6: Transaction-Safe Switch Target Attempts and Stale-Source Identity Recovery

**Objective:** Fix BLOCKER: Task 1's `switch_tx` persistence is necessary but not sufficient. The switcher must persist per-target attempts, clean up failed targets, retry bounded automatic targets, preserve recoverable EXHAUSTED state, use resume commands from all switch entry points, and distinguish stale source tmux sessions from created target sessions by tmux object IDs.

**Dependencies:** Task 1 and Task 2.

**Files:**

- Modify: `src/session/types.ts`
- Modify: `src/failover/switcher.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/rehydration.ts`
- Modify: `src/session/manager.ts`
- Modify: `tests/failover/switcher.test.ts`
- Modify: `tests/daemon/rehydration.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `src/failover/switcher.ts` constructs `switchTx` but never persists it, never clears it, never patches session status to `EXHAUSTED`, and never cleans up a partially created failed target. `SwitchTx` stores only top-level target tmux IDs, not an `attempts[]` history. `src/daemon/server.ts` manual failover uses `opts.runnerConfig` from daemon startup, which was built for the first account, so manual failover can launch with the wrong `CLAUDE_CONFIG_DIR`. `src/daemon/index.ts` and server switch callbacks use `buildLaunchCommand()` even when `claude_session_id` is available.
- **Attempt model:** Extend `SwitchTx` with `attempts[]` containing `{target_account, phase, target_tmux_name, target_tmux_session_id, target_pane_id, error_summary, ts, cleaned_up}` plus `tried_accounts`, `last_launch_error`, and source tmux identity. Persist before and after each phase transition.
- **Failed target cleanup:** On create/resume failure, destroy the failed target tmux session by persisted target ID/name before the next attempt. Do not leave an occupied stable tmux name that blocks retry.
- **Source/target disambiguation:** Recovery may accept an existing target session only when tmux `#{session_id}` matches the persisted current-attempt target ID. If the name exists but matches the source ID, clean it up as stale source before creating the target.
- **Resume support:** All `createSessionForTarget` callbacks must choose `buildResumeCommand()` when `snapshot.claudeSessionId` is non-null and `buildLaunchCommand()` only when null. Runner/config errors must propagate; do not silently downgrade resume failures to fresh launch.
- **Terminal switch failure:** If the source is already terminated and no target succeeds, set session `EXHAUSTED`, clear `switch_tx`, preserve the logical session and Slack channel mapping, and emit terminal `failover.no_target_available` plus `session.exhausted`.

**Definition of Done:**

- [ ] `SwitchTx` persists `attempts[]` with per-target tmux IDs/pane IDs and cleanup status
- [ ] `performSwitch()` patches state to `SWITCHING` and persists `switch_tx` before every destructive phase
- [ ] Target launch/resume failure emits `runner.launch_failed` or `runner.respawn_failed` with sanitized error and target metadata
- [ ] Failed target tmux sessions are cleaned up before retry
- [ ] Automatic switches retry next eligible target excluding source and tried targets
- [ ] Manual target launch/resume failure returns typed non-200 and leaves the logical session recoverable, not `STOPPED`
- [ ] All switch entry points build account-specific launch/resume commands for the actual target account
- [ ] Rehydration distinguishes stale source and real target by tmux object ID, not name only
- [ ] Successful failover preserves `aisup_session_id`, state directory, output log path, and Slack channel map key
- [ ] `session.stop` is never emitted during failover

**Verify:**

- `npx vitest run tests/failover/ tests/daemon/rehydration.test.ts tests/daemon/server.test.ts`

---

### Task 7: Active-Session Telemetry Binding and Mismatch Diagnostics

**Objective:** Fix BLOCKER: active session telemetry must bind to the supervised session by known `claude_session_id` when available, and by launch time/account/cwd only before hydration. Rejected candidates must emit useful `telemetry.session_mismatch` events without transcript contents.

**Dependencies:** Task 3 for mismatch event emission.

**Files:**

- Modify: `src/statusline/store.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/daemon/rehydration.ts`
- Modify: `src/failover/switcher.ts`
- Modify: `tests/statusline/store.test.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`
- Modify: `tests/daemon/rehydration.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `readTelemetryForActiveSession()` does not accept `claude_session_id`. `LoopManager.rateLimitTick()` always scans by launch time/account/cwd, so after hydration it can consume a newer unrelated same-account/same-cwd telemetry file instead of exact `statusline-<claude_session_id>.json`. `readTelemetryForSession()` exists but is not used by the rate-limit path or rehydration.
- **Resolver contract:** Replace call sites with `readTelemetryForActiveSession(session, accountConfigDir, statuslineDir, freshnessWindowS)` where the function internally uses exact `readTelemetryForSession()` when `session.claude_session_id` is non-null. Only pre-hydration scans may choose a candidate by mtime/account/cwd.
- **Mismatch details:** Return structured mismatch records: file path, expected session/account/cwd, observed `session_id`, observed `transcript_path`, and reason. Do not include transcript contents or statusline raw JSON.
- **Switch snapshots:** Use only validated active-session telemetry for `claude_session_id` and `transcript_path`; if no validated telemetry exists, snapshot null and launch fresh with `recovery.restart_fresh_no_session_id`.
- **Rehydration:** Validate known telemetry before restoring it. Leave telemetry pending if only stale source-account or unrelated files exist.

**Definition of Done:**

- [ ] Known `claude_session_id` reads only `statusline-<id>.json`
- [ ] Known session telemetry is rejected on session ID, account transcript-prefix, cwd/project mismatch, stale source-account file, or invalid JSON
- [ ] Pre-hydration scans ignore older same-account files and newer unrelated cwd files
- [ ] Rate-limit switching is skipped until validated active-session telemetry exists
- [ ] Rejected telemetry candidates emit `telemetry.session_mismatch` with required safe details
- [ ] Rehydration does not hydrate from `readTelemetryForAccount()`
- [ ] Gate fixture with newer unrelated same-account statusline file is represented as a deterministic test

**Verify:**

- `npx vitest run tests/statusline/ tests/daemon/loops/ tests/daemon/rehydration.test.ts`

---

### Task 8: Soft-Threshold Better-Target Selection

**Objective:** Fix HIGH: soft-threshold failover must not switch to an eligible but worse account. The source plan requires soft no-target/no-better-target cases to remain supervised and emit nonterminal `failover.no_target_available`.

**Dependencies:** Task 7 for validated current telemetry and Task 10 for event details.

**Files:**

- Modify: `src/failover/switcher.ts`
- Modify: `src/accounts/scorer.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `tests/failover/switcher.test.ts`
- Modify: `tests/accounts/scorer.test.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `selectSwitchTarget()` currently sorts eligible accounts by priority only and does not require the target to improve the triggered rate-limit window or score. `LoopManager.rateLimitTick()` only checks whether a target exists before entering `SWITCH_PENDING_AT_IDLE`.
- **Selector contract:** Add `selectSwitchTarget(reason, currentAccount, accounts, excludedAccounts, currentTelemetry)` or equivalent. Soft threshold requires a target that is strictly better than current for the triggered window or weighted score. Hard/429/source-dead recovery may select any runnable target.
- **Deferral behavior:** If soft precheck or idle-time recheck finds no better target, keep or return session to `ACTIVE`, emit nonterminal `failover.no_target_available` with `requires_better_soft_target: true`, throttle notifications, and keep monitoring.

**Definition of Done:**

- [ ] Soft threshold does not enter `SWITCH_PENDING_AT_IDLE` without a better target
- [ ] Idle-time recheck returns to `ACTIVE` when a better target is no longer available
- [ ] Soft threshold never enters `EXHAUSTED` while current runner is still usable
- [ ] Soft threshold never switches from an 85-90% current account to a worse 90-95% target
- [ ] Hard threshold, 429, and source-dead recovery still switch or exhaust when no runnable target remains
- [ ] Nonterminal no-better-target events are throttled

**Verify:**

- `npx vitest run tests/failover/ tests/accounts/ tests/daemon/loops/`

---

### Task 9: Full Rehydration Recovery Matrix

**Objective:** Fix HIGH: daemon restart must reconcile the union of persisted state files and live tmux sessions, run switch transaction recovery first, restore pipe-pane, recover state-without-tmux sessions, and report tmux orphans without dropping preserved logical sessions.

**Dependencies:** Task 5, Task 6, Task 7.

**Files:**

- Modify: `src/daemon/rehydration.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/session/manager.ts`
- Modify: `tests/daemon/rehydration.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `rehydrateSessions()` logs `session.destroyed_externally` for persisted `ACTIVE` or `SWITCH_PENDING_AT_IDLE` with no tmux, but does not restart, switch, exhaust, register the session, or mark a recoverable failed operation. It only handles `SWITCHING` when `switch_tx` exists and only fully recovers `resuming` when a target is alive. Daemon startup builds `liveSessions` with `tmux list-sessions` on the default tmux server instead of the configured `-L aisup` socket, so aisup-owned sessions can be invisible during rehydration. Orphan detection also derives a short ID from `aisup-<first8>` and compares it to full state-directory names, so matched live sessions can still be counted as tmux-without-state orphans.
- **Recovery order:** Read all persisted state files, list live tmux sessions plus tmux IDs/pane IDs, run `switch_tx` recovery before normal reconciliation, then process state-without-tmux and tmux-without-state cases.
- **State-without-tmux:** For `ACTIVE`/`SWITCH_PENDING_AT_IDLE`, emit `session.destroyed_externally`, scan last 64KB for 429, and apply the Task 8 recovery decision matrix: restart same account, switch account, or set recoverable `EXHAUSTED`.
- **Operation states:** `CREATING`, `STOPPING`, or `SWITCHING` without enough transaction data must become a typed recoverable failed-operation state/status with force-stop/manual guidance rather than being dropped.
- **Pipe/log restoration:** Live sessions must restore `pipe-pane` if inactive and initialize recovery cursor to EOF; dead/missing sessions scan only last 64KB then move to EOF.

**Definition of Done:**

- [ ] Rehydration reads persisted states and live tmux sessions, not tmux-first only
- [ ] Live tmux enumeration uses the same configured tmux socket used to create sessions
- [ ] `switch_tx` recovery runs before orphan handling
- [ ] Persisted `ACTIVE` without tmux is recovered or set to recoverable `EXHAUSTED`
- [ ] Persisted `SWITCH_PENDING_AT_IDLE` without tmux is recovered or set to recoverable `EXHAUSTED`
- [ ] `CREATING`/`STOPPING`/malformed `SWITCHING` are not silently ignored
- [ ] STOPPED-with-live-tmux is reported as inconsistent/orphaned and blocks new start
- [ ] tmux-without-state sessions are reported as orphans without deleting persisted logical sessions
- [ ] Matched live sessions are not also counted as tmux-without-state orphans due to short-ID/full-ID mismatch
- [ ] Rehydration validates known telemetry before restoring `claude_session_id`/`transcript_path`

**Verify:**

- `npx vitest run tests/daemon/rehydration.test.ts tests/daemon/server.test.ts`

---

### Task 10: Canonical Journal Detail Contract

**Objective:** Fix HIGH: the event union includes many required event names, but emitted events often omit the source plan's required detail fields. Operators and tests need stable details for EXHAUSTED, thresholds, failover, migration, telemetry mismatch, timeouts, Slack ignores, and lifecycle events.

**Dependencies:** Tasks 1-9.

**Files:**

- Modify: `src/journal/types.ts`
- Modify: `src/journal/writer.ts`
- Modify: event emitters in `src/daemon/*`, `src/failover/*`, `src/session/*`, `src/slack/*`
- Modify: `tests/journal/writer.test.ts`
- Add/modify tests around emitted event payloads in affected modules

**Key Decisions / Notes:**

- **Evidence:** `performSwitch()` emits `account.switch` without `from_account`, `to_account`, or `selection_mode`; `migration.completed` is emitted with only `{status}`; `rate_limit.threshold_crossed` in `daemon/index.ts` uses `{level, window}` instead of the required `triggered_window`, percentages, thresholds, and reset ETA; `failover.no_target_available` often omits `from_account`, `excluded_accounts`, `tried_accounts`, `source_runner_alive`, and `requires_better_soft_target`.
- **Typed details:** Define detail interfaces or factory helpers for canonical event payloads. Keep the existing recursive secret-key rejection and add tests proving raw command strings, tokens, Authorization headers, Slack command text, and transcript contents are not written.
- **Log readability:** `aisup log` can remain concise, but the JSONL event must retain the full safe details needed for diagnosis.

**Definition of Done:**

- [ ] `account.switch` includes reason, from/to accounts, phase, and selection mode
- [ ] `runner.terminated_for_switch` includes reason, source account, and target account
- [ ] `session.exhausted` includes reason, from account, tried accounts, earliest cooldown ETA, and last switch failure when present
- [ ] `failover.no_target_available` includes terminal flag, reason, from account, excluded/tried accounts, source-runner-alive, earliest cooldown ETA, and soft-target requirement
- [ ] `rate_limit.threshold_crossed` includes `triggered_window`, five-hour/seven-day percentages, configured thresholds, and reset ETA
- [ ] Migration events include safe source/target path metadata, sizes, and hashes as required by the source plan
- [ ] `telemetry.session_mismatch`, `tmux.command_timeout`, and `slack.message_ignored` details match the source plan and contain no secrets/transcript contents
- [ ] Tests assert canonical detail fields for each blocking path

**Verify:**

- `npx vitest run tests/journal/ tests/failover/ tests/daemon/loops/ tests/slack/`

---

### Task 11: Session Output-Log Rotation and Scanner Reset

**Objective:** Fix HIGH: the source plan requires session `output.log` rotation at `session.output_log_max_size_mb`, pipe-pane restart, retention cleanup, `output_log.rotated`, and cursor resets for recovery, skill detection, and Slack relay. Current code only rotates the daemon log.

**Dependencies:** Task 3 for Slack relay cursor and skill scanner reset.

**Files:**

- Modify: `src/session/manager.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/slack/service.ts`
- Modify: `src/daemon/index.ts`
- Modify: `tests/session/manager.test.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`
- Modify: `tests/slack/service.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `src/util/rotating-log.ts` is used for `~/.aisup/daemon.log` only. `SessionManager` stores `outputLogMaxSizeMb` but never checks or rotates session output logs. No code emits `output_log.rotated`.
- **Rotation sequence:** Stop pipe-pane, rename `output.log` to `output.log.1`, restart pipe-pane to a new `output.log`, emit `output_log.rotated`, and reset all output scanners to offset 0/generation +1. Retain logs for `output_log_retention_days`.

**Definition of Done:**

- [ ] Session output log rotates at configured max size
- [ ] Rotation restarts pipe-pane to the new log file
- [ ] Recovery handler, skill detector, and Slack relay reset cursors after rotation
- [ ] Old output logs are retained/deleted according to `output_log_retention_days`
- [ ] Rotation emits `output_log.rotated` with safe details
- [ ] No 429 replay from pre-rotation output after cursor reset

**Verify:**

- `npx vitest run tests/session/ tests/daemon/loops/ tests/slack/`

---

### Task 12: Slack Lifecycle and Relay Completion

**Objective:** Fix HIGH: Slack command handling exists, but session-channel lifecycle and relay semantics are not wired end to end. The source plan requires per-session channel creation, invite, channel map persistence/restoration, output relay, command redaction, and failover summaries in the same channel.

**Dependencies:** Task 3 and Task 10.

**Files:**

- Modify: `src/slack/service.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/slack/commands.ts`
- Modify: `tests/slack/service.test.ts`
- Modify: `tests/daemon/server.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `SlackService.onSessionStart()` exists, but no daemon/session creation path calls it. `onSessionStop()` is not called from stop paths. `!relay on` only toggles a map; there is no poller yet (covered by Task 3). Regular messages are ignored even when relay is on, while the source plan says regular messages are relayed only when auto-relay is enabled. `!cmd` confirmation preview currently echoes raw args to Slack.
- **Lifecycle:** Call `onSessionStart()` after successful session creation and preserve the existing channel map through failover. Call `onSessionStop()` only on terminal stops. Post switch/exhausted summaries to the same channel when Slack is enabled.
- **Command safety:** Redact and truncate `!cmd` confirmation previews; store only the local unredacted command in confirmation state. Ignore bot/system subtypes with `slack.message_ignored` where appropriate.

**Definition of Done:**

- [ ] Channel is created on session start with source-plan naming and allowed-user invites
- [ ] Channel map is persisted and restored on daemon restart
- [ ] Stop paths post session ended notification; failover does not create a new channel
- [ ] Output relay posts redacted diffs only when global config and per-channel relay are enabled
- [ ] Regular messages are not relayed by default and are relayed only when `!relay on`
- [ ] `!cmd` confirmation preview is redacted/truncated before posting to Slack
- [ ] Bot/system/self messages are ignored safely and journaled where required

**Verify:**

- `npx vitest run tests/slack/ tests/daemon/server.test.ts`

---

### Task 13: Circuit Breaker and Health Integration

**Objective:** Fix HIGH: the circuit breaker and health checks are implemented as isolated utilities but are not wired into recovery/failover decisions as required by the source plan.

**Dependencies:** Task 6 and Task 8.

**Files:**

- Modify: `src/accounts/registry.ts`
- Modify: `src/accounts/circuit-breaker.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/failover/switcher.ts`
- Modify: `src/daemon/loops/health-checker.ts`
- Modify: `tests/accounts/circuit-breaker.test.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`
- Modify: `tests/failover/switcher.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `CircuitBreaker` is not instantiated or consulted by the daemon. `LoopManager` tracks restart attempts in memory, but does not persist account circuit-breaker state or emit `circuit_breaker.tripped`. `selectSwitchTarget()` ignores circuit-breaker state beyond `AccountInfo.state`. `HealthChecker` only checks config dir exists/writable, while the plan also expects readable statusline directory and valid account prerequisites.
- **Breaker semantics:** Increment breaker only for rate-limit/target launch failures that should affect account eligibility, not ordinary process crashes. Trip after configured max failures, set cooldown, emit `circuit_breaker.tripped`, skip OPEN accounts in automatic selection, and reset on successful launch.
- **Health:** Disabled accounts should remain visible in doctor/accounts output. Account health should check config dir exists/writable, readable statusline directory, and a valid account `.claude.json` as required by the source plan, then mark unavailable accounts appropriately without deleting them from the registry.

**Definition of Done:**

- [ ] CircuitBreaker is constructed with durable state path and daemon config
- [ ] Rate-limit/target launch failures increment account breaker; process crashes do not
- [ ] Breaker trips after max failures and emits `circuit_breaker.tripped`
- [ ] OPEN accounts are excluded from automatic switch selection until cooldown/HALF_OPEN
- [ ] Successful launch resets breaker for the target account
- [ ] Health checks cover config dir exists/writable, valid `.claude.json`, and statusline directory readability
- [ ] Disabled accounts are reported in doctor/accounts but skipped by scorer/selector

**Verify:**

- `npx vitest run tests/accounts/ tests/daemon/loops/ tests/failover/`

---

### Task 14: CLI/API/Attach Parity Completion

**Objective:** Fix MEDIUM: remaining CLI and HTTP routes must match Task 12 of the source plan. This includes `status --json`, richer status fields, account usage output, `/api/events`, failover status codes, attach socket parity, and offline behavior.

**Dependencies:** Tasks 5-13.

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/cli/commands/accounts.ts`
- Modify: `src/cli/commands/attach.ts`
- Modify: `src/cli/commands/log.ts`
- Modify: `src/cli/commands/failover.ts`
- Modify: `src/daemon/server.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/daemon/server.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `src/daemon/server.ts` `/api/events` returns an empty stub. `aisup status` has no `--json` option and only prints session status/account when daemon responds. `aisup accounts` prints a message and exits when daemon is not running instead of reading config/statusline directly. `triggerFailover()` exits 0 on HTTP 409, which can hide a failed manual recovery path. `src/cli/commands/attach.ts:38` runs `tmux attach-session -t <tmuxName>` without the configured `-L aisup` socket even though daemon-created sessions use the `aisup` tmux socket, so attach can fail against an otherwise live supervised session.
- **Status fields:** Include `aisup_session_id`, `claude_session_id`, `status`, `account`, `tmux_name`, `cwd`, `plan_path`, `active_skill`, telemetry summary, and EXHAUSTED/recovery guidance. JSON mode must be machine-parseable for live gates.
- **Events:** `/api/events` should read journal with filters/limit or the CLI should explicitly use offline journal reading; avoid a route that claims API support but returns empty events.

**Definition of Done:**

- [ ] `aisup status --json` returns machine-readable session/daemon state
- [ ] Online and offline status show persisted session ID, status, account, cwd, tmux name, active skill, and timestamps
- [ ] `aisup accounts` reports configured accounts, disabled accounts, health, score/usage, model, and cooldown where available
- [ ] `/api/events` returns journal events or is removed from claimed API surface; `aisup log` remains correct
- [ ] Manual failover maps 400/409/503 to non-zero CLI exits and clear messages
- [ ] `/api/failover` allows `EXHAUSTED` manual recovery and rejects operation-owned states with typed 409
- [ ] `aisup attach` uses the same tmux socket as daemon-created sessions and has a deterministic test proving it calls `tmux -L aisup attach-session -t <tmuxName>`

**Verify:**

- `npx vitest run tests/cli/ tests/daemon/server.test.ts`

---

### Task 15: Config and Runner Validation Alignment

**Objective:** Fix MEDIUM: config loading and runner validation must match Task 1 and Task 4 of the source plan: path expansion/validation, account config existence, Slack requirements, statusline path expansion, and absolute runner command resolution at daemon startup.

**Dependencies:** None.

**Files:**

- Modify: `src/config/loader.ts`
- Modify: `src/runner/builder.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/runner/builder.test.ts`
- Modify: `tests/cli/commands.test.ts`

**Key Decisions / Notes:**

- **Evidence:** `validateConfig()` validates account path syntax but does not require account config dirs to exist, does not expand `statusline.directory`, and does not validate all configured path fields. `validateRunner()` returns an absolute command path, but `buildLaunchCommand()` still uses `config.command`; daemon startup does not replace the command with the resolved absolute path. `SessionManager.createSession()` unconditionally adds `CLAUDE_CONFIG_DIR` even when `runner.config_dir_env` is configured to another name. Slack enabled config does not enforce non-empty `allowed_user_ids`.
- **Runner resolution:** At daemon startup and doctor, resolve `runner.command` once and use the absolute path for launch/resume commands. Keep `execFileSync` boundaries shell-free.
- **Config paths:** Expand `~` and validate NUL/newline/absolute/existence rules for all path fields where the source plan requires them. Do not reject normal shell metacharacters in paths.
- **Slack config:** When `slack.enabled` is true, require non-empty allowed users and env var names; token values stay in env only and are never written to config.

**Definition of Done:**

- [ ] Account config dirs must exist and be absolute after expansion
- [ ] `statusline.directory` and `journal.path` expand `~` and reject NUL/newline
- [ ] Runtime dirs/files are created with 0700/0600 permissions where applicable
- [ ] Daemon fails fast if runner command is missing/not executable
- [ ] Launch/resume commands use resolved absolute runner path
- [ ] Session launch uses only the configured `runner.config_dir_env`; it does not hard-code `CLAUDE_CONFIG_DIR`
- [ ] Slack enabled config requires non-empty `allowed_user_ids` and env var names, without storing token values
- [ ] Tests cover paths with spaces, `$`, and parentheses to prove shell-safe escaping still works

**Verify:**

- `npx vitest run tests/config/ tests/runner/ tests/cli/`

---

### Task 16: Daemon Readiness and Startup Sequencing

**Objective:** Fix HIGH: the daemon must follow the source-plan startup state machine. Non-health routes should become READY only after rehydration and monitoring-loop registration, and Slack startup should run after READY without blocking core supervision.

**Dependencies:** Tasks 9, 12, 13, and 14.

**Files:**

- Modify: `src/daemon/index.ts`
- Modify: `tests/daemon/server.test.ts`
- Add or modify a daemon startup sequencing test with fake loop/slack dependencies

**Key Decisions / Notes:**

- **Evidence:** The source plan requires startup order `STARTING` -> HTTP health available -> `REHYDRATING` -> rehydrate sessions -> register monitoring loops -> set `READY`/emit `daemon.ready` -> start Slack non-blocking. Current `src/daemon/index.ts` calls `server.setReady()` immediately after `rehydrateSessions()` and before registering the tmux timeout handler, constructing `LoopManager`, initializing recovery cursors, or calling `loopManager.startAll()`. It then awaits `slackService.start()` before loop construction/start, so a slow or hanging Slack connection can delay monitoring loops even though Slack is optional.
- **Readiness boundary:** Move `server.setReady()` and `daemon.ready` emission after loop manager construction, recovery cursor initialization, and `loopManager.startAll()`. Until then, `/api/health` stays available and non-health routes continue returning 503.
- **Slack ordering:** Start Slack only after READY. Treat Slack as non-blocking optional work: launch it in a guarded async task, log `slack.connection_error` on failure, and never delay monitoring loop registration or daemon readiness.
- **Validation hook:** Add a deterministic startup sequencing test that proves non-health routes are not ready until after loop registration and that a delayed/failing Slack service does not prevent loop startup or daemon READY.

**Definition of Done:**

- [ ] `server.setReady()` is called only after rehydration, loop construction, recovery cursor initialization, and `loopManager.startAll()`
- [ ] `daemon.ready` is emitted after loops are registered, not before
- [ ] Slack startup happens after READY and cannot block loop startup
- [ ] Non-health routes return 503 during rehydration and loop registration
- [ ] Startup sequencing test covers the readiness boundary and optional Slack failure/delay

**Verify:**

- `npx vitest run tests/daemon/server.test.ts tests/daemon/loops/`

---

## Open Questions

None — all gaps above were validated against source code, the source-of-truth plan, and the prior blocking review.

### Deferred Ideas

None — all listed gaps are Phase 1 alignment work, not Phase 2 feature expansion.
