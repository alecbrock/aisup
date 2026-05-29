# Phase 2: aisup Supervisor Daemon Implementation Plan

Created: 2026-05-11
Review merge: 2026-05-28
Author: alec.m.brock@gmail.com
Status: PENDING
Approved: No
Iterations: 3
Worktree: No
Type: Feature

## Review Merge Notice

This plan has been merged with `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md` and the final review at `docs/reviews/2026-05-28-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md`. It now includes the Phase 1 remediation gate, Phase 2 plan corrections, final tmux-socket and permission-deny corrections, and a finding traceability matrix. A future implementer should be able to execute this plan without reading the review documents.

## Summary

**Goal:** Implement the PRD Phase 2 features for aisup: cost/token tracking, full reactive recovery, EXHAUSTED auto-resume, permission fallback broker with policy and Slack approval, validation gate engine, and related API/CLI support. Phase 2 implementation must not start until the Phase 1 remediation gate below is complete or explicitly deferred by the owner.

**Architecture:** Build on the existing Phase 1 daemon, journal, config, tmux session manager, Slack service, CLI, API server, statusline reader, and recovery loops. Preserve one canonical event contract, one canonical session state machine, and clear separation between session visibility, runner state, and daemon process lifetime.

**Core rules for all tasks:**

- Use the persisted session state plus live tmux state as the lifecycle source of truth.
- Keep `EXHAUSTED` as a session state only; never introduce it as an account state.
- Use shell-free subprocess execution by default: executable plus argument arrays.
- Keep host-gated tests explicit with `@requires_tmux`, `@requires_slack`, and `@requires_claude` markers.
- Use configured paths such as `config.journal.path`; do not hardcode runtime paths.
- Use configured runtime boundaries such as `config.session.tmux_socket`; do not hardcode the production tmux socket in daemon, CLI, Slack, rehydration, loop-manager, or tests.
- Do not add competing event shapes, hidden status channels, or parallel state machines.
- Do not commit secrets, local transcripts, tmux captures, Slack tokens, Claude account paths, or local settings.

## Scope

### In Scope

- Phase 1 remediation gate for all active review findings that can undermine Phase 2.
- PRD reconciliation for Phase 1 reality and Phase 2 scope.
- Integration smoke test using isolated daemon home and host markers.
- Rehydration corrections for recovery callbacks, persisted `EXHAUSTED`, and state-without-tmux recovery.
- Cost snapshots, aggregation, `aisup cost`, `/api/cost`, and `aisup log --type`.
- Auth/network detection and recovery escalation.
- EXHAUSTED auto-recovery with durable restart re-arming.
- Permission prompt detection, policy matching, auto-grant/deny broker, and Slack approval.
- Validation gate config, execution engine, idle trigger, CLI/API, and Slack `!gate`.

### Out of Scope and Deferred

- Multi-session support.
- Worker gate engine for multi-LLM workers.
- Multi-LLM worker orchestration.
- Mobile dashboard.
- Slack daily/weekly cost summaries.
- Budget alerts.
- Remote-control reconnect logic is explicitly deferred pending investigation of Claude Code remote-control behavior after account switches. The existing `runner.remote_control_prefix` remains supported, but Phase 2 does not add reconnect orchestration.

## Source Documents Read Before Merge

- `AGENTS.md`
- `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
- `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
- `docs/reviews/2026-05-28-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md`
- `docs/plans/2026-04-29-aisup-supervisor-daemon.md`
- `docs/plans/2026-05-07-phase1-alignment-scan.md`
- `docs/handoff/handoff-2026-05-12T17-41-31.md`
- `docs/prd/2026-04-29-ai-supervisor.md`

## Phase 1 Remediation Gate

Phase 2 implementation must not begin until all CRITICAL and HIGH Phase 1 remediation tasks are complete and re-audited, or explicitly deferred by the owner. Medium Phase 1 remediation should also be completed before Phase 2 unless the owner records an explicit deferral. These tasks are separate from the Phase 2 feature tasks.

### Phase 1 Remediation R1: Wire Account Scoring and Eligibility

**Findings:** P1-CR-001, P1-FULL-001
**Severity:** CRITICAL
**Objective:** Use the canonical account scoring and eligibility path for start admission, dry-run, soft/hard failover target selection, and automatic retry.
**Files:** `src/accounts/scorer.ts`, `src/accounts/registry.ts`, `src/daemon/server.ts`, `src/cli/commands/start.ts`, `src/daemon/loop-manager.ts`, `src/failover/switcher.ts`, `tests/accounts/`, `tests/daemon/`, `tests/failover/`, `tests/cli/`.
**Implementation Requirements:**
- Refresh account scores from statusline telemetry and circuit-breaker state before session start, dry-run, and failover target selection.
- Use `selectBestAccount()` or the canonical selector rather than priority-only sorting.
- Exclude `UNAVAILABLE` and `COOLDOWN` accounts from automatic selection; allow `COOLDOWN` only through explicit manual override where already supported.
- Ensure soft-threshold selection uses current telemetry score and requires a strictly better target.
**Tests:** Lower-priority higher-score account wins; stale/null scores are refreshed; `COOLDOWN` is skipped automatically; dry-run reports the scored selection.
**Acceptance Criteria:** Runtime account selection cannot bypass scoring, eligibility, or circuit-breaker state.

### Phase 1 Remediation R2: Persist Terminal No-Target EXHAUSTED State

**Findings:** P1-CR-002, P1-FULL-002
**Severity:** CRITICAL
**Objective:** Make pre-switch no-target behavior terminal only for hard/429/source-dead/restart/circuit-breaker reasons, and nonterminal for soft-threshold no-better-target.
**Files:** `src/daemon/index.ts`, `src/daemon/loop-manager.ts`, `src/session/types.ts`, `tests/daemon/loops/loop-manager.test.ts`, `tests/daemon/server.test.ts`.
**Implementation Requirements:**
- For terminal reasons, patch persisted session state to `EXHAUSTED`, clear `switch_tx`, emit `session.exhausted`, emit terminal `failover.no_target_available`, refresh API/session visibility, and notify Slack when configured.
- For soft-threshold no-better-target, keep the session `ACTIVE`, emit nonterminal `failover.no_target_available`, and continue monitoring.
**Tests:** Hard-threshold and live-429 no-target paths persist `EXHAUSTED`; soft-threshold no-better-target remains `ACTIVE`.
**Acceptance Criteria:** Terminal and nonterminal no-target paths cannot be represented by the same event details or state transition.

### Phase 1 Remediation R3: Make Migration Outcome Own Resume Eligibility

**Findings:** P1-CR-003, P1-FULL-003
**Severity:** CRITICAL
**Objective:** Launch with resume only when a valid transcript was migrated or already exists in the target account.
**Files:** `src/failover/switcher.ts`, `src/failover/migrator.ts`, `src/daemon/index.ts`, `src/daemon/server.ts`, `tests/failover/switcher.test.ts`, `tests/failover/migrator.test.ts`.
**Implementation Requirements:**
- Produce an explicit launch decision from migration: `resumed` only on successful or already-valid migration, `fresh` for null/missing/invalid/failed migration.
- Emit `migration.skipped_no_transcript` for null or missing transcript paths.
- Do not pass `claude_session_id` into target creation after failed migration.
**Tests:** Null transcript plus known Claude session launches fresh; migration failure launches fresh; successful migration resumes.
**Acceptance Criteria:** Target account launch mode is determined by safe target transcript state, not merely by source snapshot fields.

### Phase 1 Remediation R4: Add Recovery Callbacks to Rehydration

**Findings:** P1-HI-001, P1-FULL-004, HI-004
**Severity:** HIGH
**Objective:** Make rehydration capable of corrective recovery for incomplete switch phases and state-without-tmux sessions.
**Files:** `src/daemon/rehydration.ts`, `src/daemon/index.ts`, `src/session/manager.ts`, `tests/daemon/rehydration.test.ts`.
**Implementation Requirements:**
- Extract daemon-level `onSwitch` and `onRestart` functions and pass them to `rehydrateSessions()` through `RehydrationDeps`, or implement an equivalent deferred recovery pass immediately after loop startup.
- Continue `source_destroyed`, `migrating`, and `creating` phases instead of only logging `needs_manual_failover`.
- Restart or switch persisted `ACTIVE` and `SWITCH_PENDING_AT_IDLE` sessions with missing tmux according to the recovery decision matrix.
**Tests:** Rehydration from `source_destroyed`, `migrating`, `creating`, `resuming`, and `ACTIVE` without tmux performs corrective recovery or deterministic exhaustion.
**Acceptance Criteria:** No mid-switch phase requires manual repair solely because the daemon restarted.

### Phase 1 Remediation R5: Fix Idle Event Contract

**Findings:** P1-FULL-005, CR-004
**Severity:** HIGH
**Objective:** Stop emitting misleading `session.stop` events from idle observation.
**Files:** `src/daemon/index.ts`, `src/daemon/loop-manager.ts`, `src/journal/types.ts`, `tests/daemon/loops/loop-manager.test.ts`.
**Implementation Requirements:**
- Replace idle-time `session.stop` with `session.idle_detected` or another canonical non-lifecycle event.
- Add `lastIdleEmit` throttling so an idle period does not write an event every tick.
- Preserve `session.stop` exclusively for user/API/Slack terminal stop paths.
**Tests:** Idle emits only the idle event, once per idle period; terminal stop still emits `session.stop`.
**Acceptance Criteria:** Journal consumers can trust `session.stop` as a real terminal lifecycle event.

### Phase 1 Remediation R6: Correct Retry Eligibility and Soft-Target Execution

**Findings:** P1-FULL-008, P1-FULL-009
**Severity:** HIGH
**Objective:** Keep automatic retries and `onSwitch` execution aligned with the same scoring and better-target rules.
**Files:** `src/failover/switcher.ts`, `src/daemon/index.ts`, `src/daemon/loop-manager.ts`, `tests/failover/switcher.test.ts`, `tests/daemon/loops/loop-manager.test.ts`.
**Implementation Requirements:**
- Automatic retry list must include only `HEALTHY` or `DEGRADED` targets.
- Pass `reason` and `currentScore` through `onSwitch`, or pass the preselected target into `onSwitch`, so soft-threshold better-target checks are not bypassed.
**Tests:** Soft-threshold `onSwitch` cannot switch to a worse target; COOLDOWN automatic retry is skipped.
**Acceptance Criteria:** The precheck and actual switch target decision use the same selector contract.

### Phase 1 Remediation R7: Complete Canonical Journal Details

**Findings:** P1-FULL-010
**Severity:** HIGH
**Objective:** Make migration, telemetry, failover, timeout, and Slack events carry the required safe detail fields.
**Files:** `src/journal/types.ts`, `src/journal/writer.ts`, `src/failover/switcher.ts`, `src/failover/migrator.ts`, `src/statusline/store.ts`, `src/daemon/loop-manager.ts`, `src/slack/service.ts`, `tests/journal/`, `tests/failover/`, `tests/statusline/`, `tests/slack/`.
**Implementation Requirements:**
- Use typed event detail helpers or equivalent centralized builders.
- Migration events include safe source/target path metadata, `source_size`, `source_sha256`, `target_path`, `target_sha256`, and collision metadata where relevant.
- Use the canonical already-migrated event name `migration.skipped_already_migrated`; do not emit a parallel `migration.already_migrated` event shape.
- `migration.invalid_path` and other rejected-migration events use safe reason enums such as `symlink_rejected`, `not_regular_file`, `wrong_extension`, `outside_source_dir`, `target_parent_symlink`, and `basename_mismatch` instead of raw exception text.
- `telemetry.invalid_json` includes a safe parse error summary and stale/freshness context.
- `telemetry.session_mismatch` includes safe expected/observed criteria, including expected account/session/project identity and observed session id/transcript path when available, and never transcript contents.
- Preserve recursive secret-key rejection.
**Tests:** Assert required detail fields and absence of secrets/transcript content.
**Acceptance Criteria:** Operators can diagnose migration and telemetry failures from the JSONL journal alone.

### Phase 1 Remediation R8: Rehydrate Persisted EXHAUSTED Sessions

**Findings:** P1-FULL-011, CR-006
**Severity:** HIGH
**Objective:** Make persisted `EXHAUSTED` sessions visible and recoverable after daemon restart.
**Files:** `src/daemon/rehydration.ts`, `src/daemon/server.ts`, `src/daemon/index.ts`, `src/session/manager.ts`, `tests/daemon/rehydration.test.ts`, `tests/daemon/server.test.ts`.
**Implementation Requirements:**
- Add an `EXHAUSTED` rehydration branch that restores API visibility without putting the session in normal active loops.
- Allow manual failover and stop commands to operate on a persisted `EXHAUSTED` session after daemon restart.
- Provide the startup hook used by Task 7 to re-arm EXHAUSTED polling when `auto_resume_exhausted` is enabled.
**Tests:** Persisted `EXHAUSTED` after restart appears in `/api/status`, accepts valid manual failover, can be stopped, and blocks new start until stopped.
**Acceptance Criteria:** `EXHAUSTED` durability does not depend on the daemon instance that created it.

### Phase 1 Remediation R9: Use Current Sources for Status, Log, and Accounts

**Findings:** P1-FULL-012
**Severity:** HIGH
**Objective:** Remove stale in-memory observability and hardcoded journal access from status/log/accounts surfaces.
**Files:** `src/daemon/server.ts`, `src/cli/commands/status.ts`, `src/cli/commands/log.ts`, `src/cli/commands/accounts.ts`, `src/config/loader.ts`, `tests/daemon/server.test.ts`, `tests/cli/commands.test.ts`.
**Implementation Requirements:**
- `/api/status` reads the persisted session state on request or refreshes it whenever loop-manager patches state.
- Online status and `aisup status --json` include persisted session id, status, account, cwd, tmux name, `active_skill`, timestamps, telemetry summary, and recovery guidance.
- `aisup log` uses `/api/events` online and `loadConfig().journal.path` offline.
- `/api/accounts` and `aisup accounts` expose usage, health, cooldown, model, disabled-account visibility, and score.
**Tests:** Skill detection and failover state changes are visible in online status; JSON status includes timestamps, telemetry summary, and recovery guidance; non-default journal path works; accounts include usage/cooldown/model data.
**Acceptance Criteria:** Online and offline observability agree on canonical state and configured paths.

### Phase 1 Remediation R10: Finish Slack Edge Contracts

**Findings:** P1-FULL-013
**Severity:** MEDIUM
**Objective:** Complete optional Slack collision, rate-limit, queue, and stop-lifecycle behavior.
**Files:** `src/slack/service.ts`, `src/slack/commands.ts`, `src/daemon/index.ts`, `tests/slack/service.test.ts`, `tests/daemon/server.test.ts`.
**Implementation Requirements:**
- Emit `slack.channel_name_collision` on actual channel-name collisions.
- Add bounded relay queue handling with Slack retry metadata and `slack.rate_limited`.
- Route Slack `!stop` through the canonical terminal stop path so it emits `session.stop` and calls session stop notifications.
**Tests:** Mock name collision, Slack 429, queue overflow, and `!stop` lifecycle.
**Acceptance Criteria:** Slack remains optional but uses the same event and lifecycle contracts when enabled.

### Phase 1 Remediation R11: Distinguish Missing tmux Session from Dead Pane

**Findings:** P1-FULL-014
**Severity:** MEDIUM
**Objective:** Represent externally destroyed tmux sessions distinctly from dead runner panes.
**Files:** `src/session/tmux.ts`, `src/daemon/loop-manager.ts`, `tests/daemon/loops/loop-manager.test.ts`.
**Implementation Requirements:**
- Add a shell-free `hasSession()` or `sessionExists()` tmux wrapper.
- In recovery tick, check session existence before `isProcessDead()`.
- Emit `session.destroyed_externally` when tmux is gone, scan the last output window for 429/rate-limit classification, then use the same restart/switch/exhaustion matrix.
**Tests:** Missing tmux session produces `session.destroyed_externally`, preserves 429 classification when present in recent output, and triggers the correct recovery path.
**Acceptance Criteria:** Runtime evidence distinguishes process exit from externally destroyed session container.

### Phase 1 Remediation R12: Enforce Active-Session Telemetry Identity

**Findings:** P1-FULL-015
**Severity:** HIGH
**Objective:** Accept telemetry only when it belongs to the supervised account, Claude session, and project identity.
**Files:** `src/statusline/types.ts`, `src/statusline/store.ts`, `src/daemon/loop-manager.ts`, `src/daemon/rehydration.ts`, `tests/statusline/store.test.ts`, `tests/daemon/rehydration.test.ts`.
**Implementation Requirements:**
- Add typed support for safe project identity fields such as `workspace.project_dir`.
- Reject candidates lacking both `cwd` and project identity.
- Use the same resolver during rehydration for known sessions.
- Emit canonical mismatch details from R7.
**Tests:** Missing cwd rejected; `workspace.project_dir` match accepted; unrelated newer same-account file rejected; stale source-account telemetry rejected after failover.
**Acceptance Criteria:** Rate-limit, resume, migration, and cost logic never hydrate from an unrelated Claude statusline file.

### Phase 1 Remediation R13: Fix Restart Counter State Machine

**Findings:** P1-FULL-016
**Severity:** MEDIUM
**Objective:** Escalate after the third failed same-account restart and reset counters after success.
**Files:** `src/daemon/loop-manager.ts`, `src/daemon/index.ts`, `tests/daemon/loops/loop-manager.test.ts`.
**Implementation Requirements:**
- Make `onRestart` return success/failure or let loop-manager verify restart result.
- Count failed restart attempts inside a five-minute rolling window, not dead-tick observations.
- Clear the counter after a successful restart and on session stop/switch.
**Tests:** Third failed restart inside five minutes escalates; failures outside the five-minute window do not count together; success clears the counter; later crashes start a fresh counter window.
**Acceptance Criteria:** Restart behavior matches one explicit recovery state machine.

### Phase 1 Remediation R14: Update Alignment Scan Progress

**Findings:** P1-FULL-006
**Severity:** MEDIUM
**Objective:** Make `docs/plans/2026-05-07-phase1-alignment-scan.md` reflect implementation reality.
**Files:** `docs/plans/2026-05-07-phase1-alignment-scan.md`.
**Implementation Requirements:** Reconcile every checkbox and progress total against actual code evidence after R1-R13 are resolved.
**Tests:** Documentation review only.
**Acceptance Criteria:** The alignment scan no longer reports all tasks as unstarted after implementation work has landed.

## Cross-Cutting Phase 2 Consolidation

### Consolidation C1: Event and Config Contract Baseline

**Findings:** HI-001, HI-006, LO-004, ME-016, ME-023, Final Review HI-001, Final Review HI-002
**Objective:** Establish the Phase 2 event union and config schema/defaults/loader return shape once, before feature tasks depend on them.
**Dependencies:** Phase 1 Remediation R7
**Files:**

- Modify: `src/journal/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Modify: `tests/config/loader.test.ts`
- Modify: `tests/journal/writer.test.ts`

**Implementation Requirements:**

- Add Phase 2 event types in one pass: `cost.snapshot`, `failure.auth_detected`, `failure.network_detected`, `recovery.exhausted_polling_started`, `recovery.exhausted_resumed`, `recovery.exhausted_polling_stopped`, `recovery.exhausted_max_retries`, `permission.detected`, `permission.granted`, `permission.denied`, `permission.expired`, `permission.auto_granted`, `permission.auto_denied`, `permission.routed_to_slack`, `permission.keystroke_timeout`, `permission.keystroke_unconfirmed`, `gate.started`, `gate.passed`, `gate.failed`, `gate.timeout`, and `gate.run_completed`.
- Add `session.idle_detected` if R5 uses that event name.
- Add `RecoveryConfig`: `auto_resume_exhausted`, `exhausted_poll_interval_s`, `network_error_threshold`, and `max_exhausted_retries`.
- Extend `SessionConfig` with `tmux_socket`.
- Add `PermissionsConfig`: `enabled`, `detection_patterns`, `approval_key`, `denial_key`, `policy.allowlist`, `policy.denylist`, `policy.default_action`, `slack_routing`, and `grant_ttl_seconds`.
- Add `GatesConfig`: `enabled`, `gates`, `trigger`, and `idle_delay_seconds`.
- Update `CONFIG_DEFAULTS` for every new section with these exact safe defaults:
  ```yaml
  session:
    # Preserve existing session defaults and add:
    tmux_socket: "aisup"
  recovery:
    auto_resume_exhausted: true
    exhausted_poll_interval_s: 60
    network_error_threshold: 3
    max_exhausted_retries: 5
  permissions:
    enabled: false
    detection_patterns: []
    approval_key: "y"
    denial_key: "n"
    policy:
      allowlist: []
      denylist: []
      default_action: "deny"
    slack_routing: false
    grant_ttl_seconds: 300
  gates:
    enabled: false
    gates: []
    trigger: "idle_and_skill"
    idle_delay_seconds: 30
  ```
- Update `validateConfig()` return shape so no new section is dropped by the explicit return object.
- Validate `session.tmux_socket` as a non-empty tmux socket name with no NUL, newline, whitespace, path separators, shell metacharacters, or control characters. Production default remains `aisup`; tests can override it with a unique value such as `aisup-test-<pid>`.
- Validate `permissions.approval_key` and `permissions.denial_key` as non-empty printable text with no NUL, newline, or terminal/system-reserved control input. Enter is always sent separately with `sendEnter()`. `!interrupt` remains the only intentional Ctrl-C path.
- Validate that gate `command` is an executable name/path and every argument is in `args`.

**Tests:** Typecheck must fail if any config section is missing from schema/defaults/loader return. Loader tests cover defaults, custom values, invalid gate command strings with spaces, retry limits, tmux socket default/custom/invalid values, approval key, denial key, control-input rejection, and detection pattern overrides.
**Acceptance Criteria:** Feature tasks consume one config and event contract instead of adding local variants.

## Implementation Tasks

### Task 0: Update PRD to Match Current Reality

**Objective:** Reconcile the PRD with Phase 1 implementation and this corrected Phase 2 scope.
**Dependencies:** Phase 1 Remediation Gate review
**Files:** `docs/prd/2026-04-29-ai-supervisor.md`
**Requirements:**
- Replace current-behavior `node-pty` language with tmux-native supervision where appropriate.
- Replace supervisor-owned statusline hook claims with existing tap-file reading where appropriate.
- Correct event journal path references to the configured journal path concept.
- Mark Slack remote control and event journal/status CLI as Phase 1 implemented.
- Clarify that Phase 2 covers D2 auth/network/exhausted recovery, permissions, approval routing, gates, and cost.
- Add explicit note that remote-control reconnect is deferred as described in this plan.
- Note that cost CLI uses rolling `today`, `last_7d`, and `last_30d` windows as the Phase 2 implementation of daily/weekly visibility; itemized calendar summaries remain deferred.
**Validation:** Search the PRD for stale current-behavior wording and verify remaining references are historical or explicitly superseded.

### Task 1: Integration Smoke Test

**Objective:** Verify Phase 1 plus remediation behavior end-to-end before building Phase 2 features.
**Dependencies:** Phase 1 Remediation Gate
**Files:**

- Create directory: `tests/integration/`
- Create: `tests/integration/smoke.test.ts`
- Create: `tests/integration/TELEMETRY_FIELDS.md`

**Requirements:**
- Add file-level marker comments: at minimum `@requires_tmux`; add `@requires_claude` if the smoke test launches real Pilot/Claude; add `@requires_slack` only for Slack paths.
- Keep `AISUP_INTEGRATION=1` as the runtime guard.
- Use an isolated temp daemon home for every subprocess: write `.aisup/config.yaml` under the temp home, set `HOME` for CLI/daemon subprocesses, use test-specific port, PID, token, sessions, journal paths, and `session.tmux_socket`.
- Set `session.tmux_socket` to a unique test socket such as `aisup-test-<pid>` or `aisup-test-<worker>-<timestamp>`. The smoke test must never use the production default `aisup` socket.
- Replace hardcoded tmux socket usage in daemon startup, dry-run session enumeration, attach, rehydration wiring, loop-manager deps, SlackService wiring, and smoke-test checks with `config.session.tmux_socket`.
- Use real account config dirs only as read-only account inputs; do not mutate live `~/.aisup`.
- Do not run interactive `aisup attach` in Vitest. Verify attach/socket contract with a unit mock or `tmux -L <config.session.tmux_socket> has-session -t <tmuxName>`.
- Cleanup may only kill or inspect the configured test tmux socket. It must not enumerate, kill, or attach to the production `aisup` socket.
- Record observed statusline fields, `cost.total_cost_usd` availability, and whether permission prompt output was not tested because bypass mode was enabled.
- Add a host-gated permission validation mode: `AISUP_TEST_PERMISSIONS=1` with bypass mode disabled and `@requires_claude`. This mode must trigger real Claude permission prompts, verify detector output, verify that `config.permissions.approval_key` followed by Enter approves the prompt, and verify that `config.permissions.denial_key` followed by Enter denies the prompt. If the local host cannot run it, record the skipped/manual result and exact reason in `tests/integration/TELEMETRY_FIELDS.md`.
**Tests:** `AISUP_INTEGRATION=1 npx vitest run tests/integration/smoke.test.ts`
**Acceptance Criteria:** Smoke test leaves no orphan test tmux sessions on the configured test socket and no live user supervisor state is touched.

### Task 2: Rehydration Automatic Recovery

**Objective:** Complete daemon restart recovery without duplicating already-correct rehydration behavior.
**Dependencies:** Phase 1 Remediation R4, R8
**Files:**

- Modify: `src/daemon/rehydration.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/session/manager.ts`
- Modify: `tests/daemon/rehydration.test.ts`

**Current Behavior to Preserve:**
- Pipe-pane restore for live sessions already exists and is not new work.
- Switch-tx recovery already corrects `snapshot`, `stopping` with source alive, `stopping` with source dead as far as `source_destroyed`, and `resuming` with live target.

**New Work:**
- Use the R4 recovery callback boundary to continue `source_destroyed`, `migrating`, and `creating` phases.
- Restart persisted state-without-tmux sessions via the same daemon-level restart callback used by live recovery.
- Rehydrate persisted `EXHAUSTED` for status and Task 7 polling re-arm.
- Optionally report or destroy tmux orphans only through explicit, tested behavior.
**Tests:** Switch-tx phase tests, state-without-tmux tests, persisted `EXHAUSTED` tests, and pipe-pane restore regression tests.
**Acceptance Criteria:** Rehydration performs corrective recovery without reimplementing existing pipe-pane or already-correct switch phases.

### Task 3: Cost Snapshot Collection

**Objective:** Record cost snapshots from statusline telemetry during monitoring and lifecycle boundaries.
**Dependencies:** Task 1, Consolidation C1
**Files:**

- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/daemon/index.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`

**Requirements:**
- Use the `StatuslineTelemetry` object already read by `rateLimitTick()`.
- Extract `cost.total_cost_usd`, `model.id`, and `context_window.context_window_size` before any guard that returns on missing `rate_limits`.
- Track last snapshot per session and emit only when delta is at least `$0.01`.
- Emit a final snapshot on session stop and before account switch from `src/daemon/index.ts`.
- Clean the snapshot map on terminal stop.
**Tests:** Delta filtering, missing cost, cost present with missing rate limits, lifecycle snapshots, and map cleanup.
**Acceptance Criteria:** Cost data is captured even when rate-limit telemetry is temporarily absent.

### Task 4: Cost Aggregation Module

**Objective:** Aggregate journaled cost snapshots by account, session, and time window.
**Dependencies:** Task 3
**Files:**

- Create directory: `src/cost/`
- Create directory: `tests/cost/`
- Create: `src/cost/aggregator.ts`
- Create: `tests/cost/aggregator.test.ts`

**Requirements:**
- Use `readEvents()` from `src/journal/reader.ts`; do not reimplement JSONL parsing.
- Aggregate `cost.snapshot` events from a caller-provided journal path.
- Per aisup session cost is the sum of final/max costs across Claude session segments.
- Expose rolling windows: `today`, `last_7d`, `last_30d`; document these as the Phase 2 implementation of PRD daily/weekly visibility.
- Handle empty journals and large enough journals without crashing; streaming optimization is deferred.
**Tests:** Empty journal, single session, multi-account switch, multiple Claude segments, and time-window filtering.
**Acceptance Criteria:** Aggregation uses existing journal semantics and configured paths supplied by callers.

### Task 5: `aisup cost`, `/api/cost`, and `aisup log --type`

**Objective:** Add cost CLI/API surfaces and make the plan's cost verification command valid.
**Dependencies:** Task 4
**Files:**

- Create: `src/cli/commands/cost.ts`
- Create: `tests/cli/cost.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/log.ts`
- Modify: `src/daemon/server.ts`
- Modify: `tests/daemon/server.test.ts`

**Requirements:**
- `aisup cost` supports `--json`, `--since`, and `--account`.
- Offline cost mode loads config and uses `config.journal.path`.
- `GET /api/cost` can use existing `DaemonServerOptions.journalPath` and call `aggregateCosts()` inline.
- Add `aisup log --type <event_type>` online through `/api/events?type=...` and offline through `readEvents(config.journal.path, { type })`.
- Preserve current `aisup log` behavior when no type is provided.
**Tests:** JSON output, account filtering, offline mode with a non-default configured journal path, API parity, and `log --type cost.snapshot`.
**Acceptance Criteria:** Online/offline cost and log surfaces read the same configured journal source.

### Task 6: Auth and Network Failure Detection

**Objective:** Detect auth failures and network errors from active session output and trigger the correct recovery action.
**Dependencies:** Phase 1 Remediation R1, R11, C1
**Files:**

- Create directory: `src/recovery/`
- Create directory: `tests/recovery/`
- Create: `src/recovery/patterns.ts`
- Create: `tests/recovery/patterns.test.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/failover/types.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`

**Requirements:**
- Add `AuthFailure` and `NetworkError` to `SwitchReason`.
- Follow the existing `detect429InOutput()` pattern: module-level regex arrays, `strip-ansi`, detector functions, and `readLogTail()` based scanning.
- `recoveryTick()` only processes `ACTIVE` and `SWITCH_PENDING_AT_IDLE`; document that auth/network detection does not run for `EXHAUSTED`, `SWITCHING`, `CREATING`, or `STOPPING`.
- Insert detector calls in the live-output scan before the 429 action path. Preferred priority: auth failure, 429, network error escalation, permission/non-action logging.
- Track network errors on `LoopManager` with `Map<string, number>`, reset on non-error output, switch, stop, or successful restart. Threshold comes from `config.recovery.network_error_threshold`.
**Tests:** Auth triggers switch, network errors restart after threshold, counters reset, output with both auth and 429 takes the intended priority, non-active statuses are skipped.
**Acceptance Criteria:** Failure detection is an extension of the existing output scanner, not a parallel scanner or hidden loop.

### Task 7: EXHAUSTED Auto-Recovery

**Objective:** Poll persisted exhausted sessions and auto-resume them when an account becomes runnable.
**Dependencies:** Phase 1 Remediation R8, Task 6, C1
**Files:**

- Create: `src/recovery/exhausted.ts`
- Create: `tests/recovery/exhausted.test.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/rehydration.ts`
- Modify: `src/accounts/circuit-breaker.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Modify: `tests/config/loader.test.ts`

**Requirements:**
- Export `CBState` from `src/accounts/circuit-breaker.ts`.
- Constructor deps:
  ```typescript
  interface ExhaustedRecoveryDeps {
    circuitBreaker: CircuitBreaker;
    accountRegistry: AccountRegistry;
    config: RecoveryConfig;
    journal: JournalWriter;
    onAccountAvailable: (sessionId: string, account: string) => Promise<void>;
  }
  ```
- Candidate logic calls `getState(account)` first; `HALF_OPEN` or `CLOSED` is runnable. Use `getCooldownEta()` only for ETA messaging.
- Add `max_exhausted_retries` config default `5`, validate it, and emit `recovery.exhausted_max_retries` when exhausted retries stop.
- Start polling when live failover enters `EXHAUSTED` and when daemon startup rehydrates a persisted `EXHAUSTED` session.
- Stop polling on resume, manual stop, manual failover, and daemon shutdown.
**Tests:** Cooldown expiry, persisted restart re-arm, disabled auto-resume, max retries, shutdown cleanup, and no reliance on `getActiveSession()`.
**Acceptance Criteria:** `auto_resume_exhausted` remains durable across daemon restarts.

### Task 8: Permission Prompt Detection

**Objective:** Detect permission prompts from active output and emit canonical observability events.
**Dependencies:** Task 6, C1
**Files:**

- Create directory: `src/permissions/`
- Create directory: `tests/permissions/`
- Create: `src/permissions/detector.ts`
- Create: `src/permissions/types.ts`
- Create: `tests/permissions/detector.test.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`

**Requirements:**
- Task 1 is not a hard dependency for permission patterns. Live validation is owned by the `AISUP_TEST_PERMISSIONS=1` host-gated path with bypass mode disabled.
- Add `onPermissionDetected?: (sessionId: string, request: PermissionRequest) => void` to `LoopManagerDeps`.
- Detector scans new output deltas, not full logs.
- Default patterns must match full prompt-like lines and avoid generic `Allow` false positives. Include false-positive tests such as ordinary prose containing "allow".
- Own `permissions.detection_patterns` here or rely on C1 if C1 has already landed.
- Insert permission detection before the 429 action path; permission detection logs and notifies the broker but does not block a higher-priority 429/auth action.
**Tests:** Prompt formats, extraction, deduplication, false positives, callback invocation, and configured pattern override.
**Acceptance Criteria:** Permission observability is precise enough to feed policy without creating noisy Slack prompts.

### Task 9: Permission Policy Engine

**Objective:** Evaluate permission requests against a deterministic allowlist/denylist policy.
**Dependencies:** Task 8, C1
**Files:**

- Create: `src/permissions/policy.ts`
- Create: `tests/permissions/policy.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Requirements:**
- Keep `policy.ts` pure: it returns `grant`, `deny`, or `ask`; it does not send tmux keystrokes.
- Denylist wins over allowlist.
- Add `picomatch` as a direct runtime dependency and use it for policy glob matching. Do not import a transitive dependency and do not hand-roll glob semantics.
- Match against `<tool>:<detail>` strings, with tests for `Read:*`, `Bash:git *`, and path-style `**` examples.
- Include `permissions.approval_key` default `y` and `permissions.denial_key` default `n` for the broker tasks to use, with final behavior validated by the host-gated permission test.
**Tests:** Allowlist, denylist, precedence, unmatched default action, glob examples, and invalid policy config.
**Acceptance Criteria:** Permission decisions are deterministic, dependency-backed, and side-effect free.

### Task 10: Permission Broker and Slack Approval Routing

**Objective:** Route permission decisions to tmux or Slack and implement `!permit`/`!deny`.
**Dependencies:** Task 9
**Files:**

- Modify: `src/daemon/index.ts`
- Modify: `src/slack/service.ts`
- Modify: `src/slack/commands.ts`
- Modify: `tests/slack/service.test.ts`
- Modify: `tests/daemon/server.test.ts`

**Requirements:**
- Wire `onPermissionDetected` in daemon/index: evaluate policy, then auto-grant, auto-deny, or route to Slack.
- Auto-grant/deny side effects live in daemon or Slack service boundaries with tmux access, not in `policy.ts`.
- Approval keystroke sends `config.permissions.approval_key` with `sendText()` followed by `sendEnter()`. Use the existing SlackService tmux keystroke pattern.
- Denial keystroke sends `config.permissions.denial_key` with `sendText()` followed by `sendEnter()` for auto-deny and Slack `!deny`, using the same freshness, TTL, and prompt-confirmation checks as approval.
- Do not emit `permission.denied` or `permission.auto_denied` until the denial keystroke has been sent after prompt freshness checks. If the host-gated Claude validation shows that the current prompt has no safe printable denial key, update this task before implementation completion to use an explicit fallback such as `permission.expired` plus Slack/manual instruction instead of claiming denial.
- Before sending a keystroke, re-scan recent output to confirm the prompt is still active; enforce detection-to-keystroke TTL; emit timeout or unconfirmed events.
- Extend `SlackServiceOpts` with `permissionsConfig`, `onPermissionGrant`, and `onPermissionDeny` callbacks.
- Add `permit` and `deny` to `KNOWN_COMMANDS` and add `case 'permit'` / `case 'deny'` in `dispatchCommand()`.
- Reuse `ConfirmationStore` or extract a generic TTL store for pending permissions.
**Tests:** Auto-grant sends approval key plus Enter; auto-deny sends denial key plus Enter; stale prompt; keystroke timeout; Slack route; `!permit`; `!deny`; TTL expiry; invalid/control key rejection through config validation; unknown command behavior.
**Acceptance Criteria:** Permission side effects happen only after prompt freshness checks and through the canonical tmux boundary.

### Task 11: Validation Gate Config and Engine

**Objective:** Execute configured validation gates using shell-free executable/argument arrays.
**Dependencies:** C1
**Files:**

- Create directory: `src/gates/`
- Create directory: `tests/gates/`
- Create: `src/gates/engine.ts`
- Create: `src/gates/types.ts`
- Create: `tests/gates/engine.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`

**Requirements:**
- Gate config format:
  ```typescript
  interface GateCommandConfig {
    name: string;
    command: string;      // executable only, for example "npx"
    args: string[];       // for example ["tsc", "--noEmit"]
    timeout_seconds: number;
    required: boolean;
    cwd: string | null;
  }
  ```
- Execute gates sequentially with `execFile(gate.command, gate.args, ...)`.
- Capture stdout/stderr tail with truncation.
- Log `gate.started`, terminal per-gate result events, and `gate.run_completed`.
- Validation rejects empty names, missing commands, and command strings that contain arguments.
**Tests:** Pass, fail, timeout, multiple gates, output truncation, invalid config, executable plus args behavior.
**Acceptance Criteria:** Gate execution complies with the repository shell-free subprocess rule.

### Task 12: Gate Trigger Wiring, CLI/API, and Slack `!gate`

**Objective:** Trigger gates after idle work, expose results, and support manual runs from CLI, API, and Slack.
**Dependencies:** Task 11, Task 8
**Files:**

- Create: `src/cli/commands/gate.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/slack/service.ts`
- Modify: `src/slack/commands.ts`
- Modify: `src/cli/index.ts`
- Modify: `tests/daemon/loops/loop-manager.test.ts`
- Modify: `tests/daemon/server.test.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/slack/service.test.ts`

**Requirements:**
- Automatic trigger is idle plus non-null `session.active_skill`, not a transition to null.
- After a gate run starts or completes, clear `active_skill` with `patchState()` to prevent repeated triggers for the same completed work.
- Add `lastGateRun` debounce and avoid triggering more than once inside the debounce window.
- Keep `onIdle` as observability only; use `lastIdleEmit` to avoid journal spam.
- Add `onGateTrigger?: (sessionId: string, completedSkill: string) => Promise<void>` to `LoopManagerDeps`, not `LoopManagerOpts`.
- Extend `DaemonServerOptions` with a gate engine and latest-run getter/store for `GET /api/gates` and `POST /api/gates/run`.
- Add `aisup gate`, `aisup gate run`, and `aisup gate --json`.
- Add `gate` to `KNOWN_COMMANDS` and add `case 'gate'` in Slack dispatch: `!gate` runs gates, `!gate status` reports latest results.
**Tests:** Idle + active skill triggers; no active skill does not trigger; debounce; active_skill clears; manual CLI/API/Slack runs; latest status; Slack notification.
**Acceptance Criteria:** Gates are runnable manually and automatically without depending on a nonexistent skill-null transition.

## Validation Gates

Before marking the plan implementation complete, run the relevant fresh commands for the changed modules. Expected command groups:

- `npm run typecheck`
- `npx vitest run tests/config/ tests/journal/`
- `npx vitest run tests/accounts/ tests/failover/ tests/daemon/`
- `npx vitest run tests/cost/ tests/cli/ tests/daemon/server.test.ts`
- `npx vitest run tests/recovery/ tests/permissions/ tests/slack/ tests/gates/`
- Host-gated: `AISUP_INTEGRATION=1 npx vitest run tests/integration/smoke.test.ts`
- Host-gated Claude permission validation: `AISUP_INTEGRATION=1 AISUP_TEST_PERMISSIONS=1 npx vitest run tests/integration/smoke.test.ts` with assertions for prompt detection, approval key behavior, and denial key behavior.

Host-gated tests must be skipped by default unless the required marker and env gate are satisfied.

## Final Self-Audit Checklist

- Phase 1 CRITICAL/HIGH remediation is complete or explicitly deferred by the owner.
- Every active Phase 2 critical/high finding is folded into a task.
- Every finding ID appears in the traceability matrix.
- Superseded, rejected, and informational findings have no active implementation work.
- Event contract changes are centralized.
- Config schema/defaults/loader changes are centralized and then consumed by tasks.
- Gate subprocess execution is shell-free.
- Host-gated integration tests have explicit markers.
- Host-gated integration uses a test-specific tmux socket, not the production `aisup` socket.
- Claude permission validation covers both approval and denial key behavior, or documents a safe manual-denial fallback before completion.
- All journal and cost reads use configured paths.
- Rehydration re-arms persisted `EXHAUSTED` recovery.

## Finding Traceability Matrix

| Finding ID | Review Status | Plan Destination | Merge Disposition | Required Work |
|------------|---------------|------------------|-------------------|---------------|
| CR-001 | Confirmed | Task 2 | Merged | Mark pipe-pane restore as existing behavior and avoid duplicate work. |
| CR-002 | Confirmed | Task 2 | Merged | Correct switch-tx current-state description and narrow new rehydration work. |
| CR-003 | Confirmed | Task 12 | Merged | Use idle plus non-null active skill and clear active skill after gate run. |
| CR-004 | Amended active | R5, Task 12 | Merged | Replace idle `session.stop`, throttle idle events, and add gate trigger design. |
| CR-005 | Superseded | Traceability only | Superseded - no work | Historical EXHAUSTED persistence finding replaced by CR-006. |
| CR-006 | Active | R8, Task 7 | Merged | Re-arm EXHAUSTED polling from persisted state after daemon restart. |
| HI-001 | Confirmed | C1, Tasks 7/9/11 | Merged | Add defaults for recovery, permissions, and gates. |
| HI-002 | Confirmed | Task 6 | Merged | Add `src/failover/types.ts` and new switch reasons. |
| HI-003 | Confirmed | Task 3 | Merged | Add daemon lifecycle snapshot wiring in `src/daemon/index.ts`. |
| HI-004 | Confirmed | R4, Task 2 | Merged | Add rehydration recovery callbacks or deferred recovery boundary. |
| HI-005 | Confirmed | Task 11 | Merged with HI-012 | Use executable plus args with `execFile`. |
| HI-006 | Confirmed | C1 | Merged | Update `validateConfig()` explicit return for new sections. |
| HI-007 | Confirmed | Task 4 | Merged | Use `readEvents()` from journal reader for aggregation. |
| HI-008 | Active | Task 6 | Merged | Document `recoveryTick()` status filtering. |
| HI-009 | Active | Task 7 | Merged | Export `CBState`. |
| HI-010 | Active | Task 10 | Merged | Add dispatch cases for `!permit` and `!deny`. |
| HI-011 | Active | Task 9, Task 10 | Merged | Keep policy pure and move keystroke side effects to daemon/Slack wiring. |
| HI-012 | Active | Task 11 | Merged | Reconcile gate config with shell-free subprocess rule. |
| HI-013 | Active | Task 1 | Merged | Isolate daemon home/config for smoke test subprocesses. |
| HI-014 | Active | Task 1 | Merged | Replace automated attach with deterministic socket/session check. |
| ME-001 | Confirmed | Context and Task 3 | Merged | Avoid stale loop-manager line reference and use current event patterns. |
| ME-002 | Confirmed | Task 10 | Merged | Specify approval key and `sendText` plus `sendEnter`. |
| ME-003 | Confirmed | Task 1, Task 8 | Merged | Remove Task 1 as hard dependency for permission pattern validation. |
| ME-004 | Confirmed | Task 8 | Merged | Add `onPermissionDetected` to `LoopManagerDeps`. |
| ME-005 | Confirmed | Task 7 | Merged | Use `getState()` for candidates and `getCooldownEta()` for ETA only. |
| ME-006 | Confirmed | Task 7 | Merged | Specify `ExhaustedRecoveryDeps`. |
| ME-007 | Confirmed | Task 5, Task 12 | Merged | Clarify server option dependencies for cost and gates. |
| ME-008 | Confirmed | Task 6 | Merged | Follow existing 429 detector/ANSI-stripping pattern. |
| ME-009 | Confirmed | Task 8 | Merged | Use specific permission prompt patterns and false-positive tests. |
| ME-010 | Active | Task 3 | Merged | Capture cost before missing-rate-limit early return. |
| ME-011 | Active | Task 10 | Merged | Reference existing SlackService tmux keystroke pattern. |
| ME-012 | Active | Task 10 | Merged | Extend `SlackServiceOpts` for permissions. |
| ME-013 | Active | Task 12 | Merged | Implement Slack `!gate` command. |
| ME-014 | Active | Task 12 | Merged | Put `onGateTrigger` on `LoopManagerDeps`. |
| ME-015 | Active | Scope | Merged | Explicitly defer remote-control reconnect with rationale. |
| ME-016 | Active | C1, Task 8 | Merged | Own permission detection pattern config before policy task. |
| ME-017 | Active | Task 6, Task 8 | Merged | Specify detector ordering before 429 action path. |
| ME-018 | Active | Task 6 | Merged | Add per-session network error counter and reset rules. |
| ME-019 | Rejected | Traceability only | Rejected - no work | Empty `accountConfigDir` claim unsupported; active issue covered by HI-004. |
| ME-020 | Active | Task 1 | Merged | Add explicit host markers. |
| ME-021 | Active | Task 5 | Merged | Implement `aisup log --type`. |
| ME-022 | Active | Task 5 | Merged | Offline cost mode uses `config.journal.path`. |
| ME-023 | Active | C1, Task 7 | Merged | Add max exhausted retries config/default/event/tests. |
| ME-024 | Active | Task 9 | Merged | Add direct glob dependency or tested local matcher; plan selects dependency. |
| LO-001 | Confirmed | Task 1 | Merged | Create `tests/integration/`. |
| LO-002 | Confirmed | Task 10 | Merged | Reuse or generalize `ConfirmationStore`. |
| LO-003 | Confirmed | Tasks 1/4/6/8/11 | Merged | List new directories. |
| LO-004 | Amended active | C1 | Merged | Centralize Phase 2 event union updates. |
| LO-005 | Active | Task 3 | Merged | Clarify cost fields come from existing telemetry object. |
| LO-006 | Active | Task 7 | Merged | Stop exhausted poller during daemon shutdown. |
| LO-007 | Active | Task 0, Task 4 | Merged | Document rolling windows as daily/weekly visibility. |
| LO-008 | Active | Task 1 | Merged | Add `TELEMETRY_FIELDS.md` to Files. |
| IN-001 | Informational | Task 12 note | Informational - noted | SkillTracker may be reused but is not required. |
| IN-002 | Informational | Scope | Informational - noted | Scope mostly matches PRD; RC reconnect now explicitly deferred. |
| IN-003 | Informational | Task 4 note | Informational - noted | `readEvents()` scaling noted; no blocking work. |
| IN-004 | Informational | Phase 1 Remediation Gate | Informational - noted | Phase 1 gate incorporated as required pre-Phase-2 work. |
| P1-CR-001 | Active | R1 | Merged with P1-FULL-001 | Wire account scoring and eligibility. |
| P1-CR-002 | Active | R2 | Merged with P1-FULL-002 | Persist terminal no-target EXHAUSTED. |
| P1-CR-003 | Active | R3 | Merged with P1-FULL-003 | Make migration outcome own resume eligibility. |
| P1-HI-001 | Active | R4 | Merged with P1-FULL-004 | Complete switch transaction rehydration. |
| P1-FULL-001 | Active | R1 | Merged | Account scoring and eligibility wiring. |
| P1-FULL-002 | Active | R2 | Merged | Pre-switch no-target EXHAUSTED persistence. |
| P1-FULL-003 | Active | R3 | Merged | Failed migration must force fresh launch. |
| P1-FULL-004 | Active | R4 | Merged | Rehydration callbacks for mid-switch phases. |
| P1-FULL-005 | Active | R5 | Merged | Replace misleading idle `session.stop`. |
| P1-FULL-006 | Active | R14 | Merged | Update alignment scan progress. |
| P1-FULL-007 | Rejected | Traceability only | Rejected - no work | Unsupported empty `accountConfigDir` finding. |
| P1-FULL-008 | Active | R6 | Merged | Exclude COOLDOWN from automatic retry. |
| P1-FULL-009 | Active | R6 | Merged | Preserve soft-threshold reason/current score at switch time. |
| P1-FULL-010 | Active | R7 | Merged | Complete canonical journal detail contract. |
| P1-FULL-011 | Active | R8 | Merged | Rehydrate persisted EXHAUSTED sessions. |
| P1-FULL-012 | Active | R9 | Merged | Use current sources for status/log/accounts. |
| P1-FULL-013 | Active | R10 | Merged | Complete optional Slack runtime edge contracts. |
| P1-FULL-014 | Active | R11 | Merged | Distinguish missing tmux session from dead pane. |
| P1-FULL-015 | Active | R12 | Merged | Enforce active-session telemetry identity. |
| P1-FULL-016 | Active | R13 | Merged | Fix restart counter state machine. |
