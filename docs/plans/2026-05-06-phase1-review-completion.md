# Phase 1 Review Issue Completion Plan

Created: 2026-05-06
Author: alec.m.brock@gmail.com
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Fully fix the 4 partially-fixed issues (ISSUE-002, ISSUE-005, ISSUE-007, ISSUE-014) from the Phase 1 implementation review, aligned with the original implementation plan's acceptance criteria with no remaining gaps.

**Architecture:** Each issue maps to specific plan tasks (Task 8/12 for loops, Task 12 for rehydration, Task 9/10 for Slack, Task 8 for tmux journaling). The loop classes already have static helper methods and `tick()` signatures — the work is wiring real session/telemetry data into the interval callbacks. Slack requires a new service layer between Bolt and tmux/session. Rehydration requires implementing the per-phase recovery table from the plan. Tmux timeout journaling requires a callback mechanism since `tmuxWithTimeout` is a low-level function without journal access.

**Tech Stack:** TypeScript, Node.js 22, `@slack/bolt` 4.x, Fastify, tmux, vitest

## Scope

### In Scope

- ISSUE-002: Wire real tick bodies for all 4 monitoring loops (rate-limit, recovery, health, idle) with session state access, telemetry reads, output log scanning, pane death detection, and failover triggering
- ISSUE-005: Full per-phase switch_tx recovery table, pipe-pane restoration for live sessions, same-account restart for state-without-tmux
- ISSUE-007: Full Slack Task 9 (Bolt lifecycle, channel creation/invite, channel map persistence) + Task 10 (all 6 command handlers, output relay with redaction)
- ISSUE-014: Tmux timeout event journaling via callback mechanism

### Out of Scope

- Phase 2 features (prompt detection, multi-session, full reactive recovery)
- Live acceptance gates (Task 13) — requires operator action after this plan
- CLI offline status fallback (separate issue, not in these 4)
- Events API journal reader integration (separate issue)

## Approach

**Chosen:** LoopManager holds deps (SessionManager, AccountRegistry, config refs). Each loop's `start()` interval calls its own `tick()` reading real data from these deps. Slack gets a dedicated `SlackService` class orchestrating Bolt app, channel lifecycle, and command dispatch.

**Why:** Minimal indirection — loops directly access the services they need per the plan's design. SlackService encapsulates all Slack state (channel map, relay cursors) behind a single daemon-level dependency.

**Alternatives considered:**
- Daemon-passes-snapshot: More explicit data flow but requires the daemon to construct a snapshot object on every tick for every loop, adding complexity to daemon/index.ts without benefit.
- Event-driven loops: Loops react to events rather than polling — cleaner but contradicts the plan's interval-based polling design.

## Context for Implementer

> Write for an implementer who has never seen the codebase.

- **Patterns to follow:**
  - Loop classes: `src/daemon/loops/rate-limit-monitor.ts` — each has `start()/stop()/tick()`, constructor takes `intervalMs` + callbacks. Static helpers already exist for the core logic (e.g., `RateLimitMonitor.checkThresholds()`, `detect429InOutput()`, `isSessionIdle()`, `checkAccountHealth()`).
  - Session state: `src/session/manager.ts:55` — `writeState()` does atomic tmp+rename. `readState()` returns `SessionState | null`.
  - Tmux operations: `src/session/tmux.ts` — all calls go through `tmuxWithTimeout()` (5s default). Exports: `isProcessDead`, `isPipePaneActive`, `startOutputLog`, `captureOutput`, `respawnPane`, `sendInterrupt`, `sendEnter`, `sendText`, `destroyTmuxSession`.
  - Slack helpers already exist: `src/slack/channels.ts` (slugify, buildChannelName, isChannelNameTaken), `src/slack/commands.ts` (parseCommand, ConfirmationStore), `src/slack/relay.ts` (redactSecrets, isAllowedUser, isBotMessage), `src/slack/client.ts` (createSlackClient returns `SlackClient | null`).
  - Statusline store: `src/statusline/store.ts` — `readTelemetryForActiveSession()` returns fresh telemetry for the current session; `readTelemetryForAccount()` returns freshest per-account for scoring.
  - Failover: `src/failover/switcher.ts` — `performSwitch(snapshot, accounts, deps)` orchestrates the full switch. `selectSwitchTarget()` picks best eligible account by priority.
  - Circuit breaker: `src/accounts/circuit-breaker.ts` — tracks consecutive failures per account.

- **Conventions:** kebab-case files, explicit return types on exports, no `any`, `node:` prefix for built-ins, vitest for tests.

- **Key files:**
  - `src/daemon/index.ts` — daemon main, creates all services, starts loops, handles shutdown
  - `src/daemon/loop-manager.ts` — orchestrates all 4 loops
  - `src/daemon/loops/*.ts` — individual loop classes
  - `src/session/manager.ts` — session CRUD with tmux
  - `src/session/types.ts` — `SessionState`, `SwitchTx`, `SessionStatus`
  - `src/slack/client.ts` — Bolt app creation
  - `src/config/schema.ts` — all config types including `SlackConfig`

- **Gotchas:**
  - `failover_in_progress` mutex: Before any loop triggers `performSwitch()`, it must check and set this flag (atomic via single-threaded JS event loop). Clear on completion. Prevents rate-limit and recovery from racing.
  - Output log scan bounded to last 64KB to avoid stale 429 replay from pre-rotation content.
  - Daemon restart with live pane: cursor starts at EOF (no back-scan). Dead pane: scan last 64KB then EOF.
  - `tmuxWithTimeout` error message always says "timed out" even for non-timeout errors — callers must distinguish actual timeouts (killed signal) from other exec failures.
  - Slack disabled mode: entire Slack service is null when `slack.enabled` is false. No Bolt import overhead.
  - Channel map persistence: write `~/.aisup/channel-map.json` on every change, read on daemon start.

- **Domain context:** The daemon supervises a single Claude/Pilot coding session at a time. When rate limits are hit or the process crashes, it can switch to a different account (different `~/.claude-*` config dir) while preserving the logical session identity (`aisup_session_id`). The switch involves terminating the source runner, migrating the transcript, and launching a new runner on the target account.

## Assumptions

- `readTelemetryForActiveSession()` correctly finds the current session's statusline file — supported by 13 passing statusline tests — Tasks 1, 2 depend on this.
- `performSwitch()` correctly orchestrates the full switch sequence — supported by the earlier fix in this session — Tasks 1, 3 depend on this.
- `@slack/bolt` App correctly handles Socket Mode when given valid tokens — supported by Bolt documentation — Task 4 depends on this.
- The existing `SwitchTx` type in `src/session/types.ts` has all fields needed for per-phase recovery — supported by code inspection — Task 3 depends on this.
- `readFileSync` with offset (via `fd` + `read`) or Buffer slicing works for 64KB output log tail scan — supported by Node.js docs — Task 2 depends on this.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Slack bolt import adds startup latency even when disabled | Medium | Low | Lazy-import Bolt only when `slack.enabled` is true |
| Output log 64KB scan window too small for some 429 patterns | Low | Medium | Make scan window configurable via config; default 64KB matches plan |
| Concurrent loop ticks race on session state | Medium | High | `failover_in_progress` flag checked before every `performSwitch()` call; single-threaded JS event loop makes flag check + set atomic |
| Rehydration switch_tx recovery incorrectly identifies stale tmux sessions | Medium | High | Use persisted `source_tmux_session_id`/`pane_id` to distinguish source from target tmux sessions |

## Goal Verification

### Truths

1. Rate-limit monitor reads real statusline telemetry and triggers `performSwitch()` when hard threshold is breached
2. Recovery handler scans output logs for 429 patterns and detects pane death, triggering appropriate recovery
3. Health checker verifies account config dirs and reports unhealthy accounts
4. Idle watchdog detects sessions with no output change and emits idle event
5. Daemon rehydration restores pipe-pane for live sessions and executes per-phase switch_tx recovery
6. Slack connects via Socket Mode, creates channels, and executes all 6 commands (!interrupt, !stop, !status, !cmd, !relay, !help)
7. Tmux timeout events are journaled with sanitized operation details

### Artifacts

1. `src/daemon/loops/rate-limit-monitor.ts` — real tick body reading telemetry
2. `src/daemon/loops/recovery-handler.ts` — real tick body with output scanning and pane death detection
3. `src/daemon/loops/health-checker.ts` — real tick body with account health checks
4. `src/daemon/loops/idle-watchdog.ts` — real tick body with output log mtime check
5. `src/daemon/loop-manager.ts` — holds deps, passes to loops, manages failover mutex
6. `src/daemon/index.ts` — rehydration with per-phase recovery and pipe-pane restore
7. `src/slack/service.ts` — SlackService with channel lifecycle, command dispatch, relay
8. `src/session/tmux.ts` — timeout callback mechanism for journal events

## Progress Tracking

- [x] Task 1: Wire real loop tick bodies with session/telemetry access
- [x] Task 2: Wire recovery handler with output log scanning and pane death detection
- [x] Task 3: Implement full rehydration recovery (pipe-pane, switch_tx, same-account restart)
- [x] Task 4: Implement Slack service with Bolt lifecycle, channels, commands, relay
- [x] Task 5: Add tmux timeout journaling via callback
- [x] Task 6: Wire everything into daemon startup and update tests
      **Total Tasks:** 6 | **Completed:** 6 | **Remaining:** 0

## Implementation Tasks

### Task 1: Wire Real Loop Tick Bodies (Rate-Limit Monitor, Health Checker, Idle Watchdog)

**Objective:** Replace placeholder interval callbacks in `RateLimitMonitor`, `HealthChecker`, and `IdleWatchdog` with real tick bodies that read telemetry, check health, and detect idle sessions. Wire `LoopManager` to hold service dependencies.

**Dependencies:** None (builds on existing loop classes and helpers)

**Files:**

- Modify: `src/daemon/loops/rate-limit-monitor.ts`
- Modify: `src/daemon/loops/health-checker.ts`
- Modify: `src/daemon/loops/idle-watchdog.ts`
- Modify: `src/daemon/loop-manager.ts`
- Modify: `tests/daemon/loops/rate-limit-monitor.test.ts`

**Key Decisions / Notes:**

- **LoopManager gains a `deps` object:** `{ sessionManager, accountRegistry, config (thresholds, statusline, monitoring, session), journal }`. Passed to constructor. Each loop's `start()` interval calls the loop's existing `tick()` or static helper with real data from deps.
- **RateLimitMonitor.start() interval body:**
  1. Read current session from `sessionManager` (if no active session, skip)
  2. Call `readTelemetryForActiveSession()` from `src/statusline/store.ts` with session's `launch_started_at`, `account` config dir, `cwd`, statusline dir, freshness window
  3. If telemetry found and has `rate_limits`, call `this.tick(telemetry.rate_limits, softPct, hardPct)`
  4. If telemetry found and session has no `claude_session_id` yet, hydrate it from `telemetry.session_id` and `telemetry.transcript_path` (write state)
  5. If `tick()` returns `level !== 'none'`, `onBreach` callback handles it (already wired)
- **Soft threshold → SWITCH_PENDING_AT_IDLE flow:** When `tick()` returns `soft`, check if session is already `SWITCH_PENDING_AT_IDLE`. If not, precheck `selectSwitchTarget(accounts, currentAccount, [])` — "better target" means: enabled, not UNAVAILABLE, not the current account, not tripped by circuit breaker (`CircuitBreaker.isTripped(name)` returns false), and has lower priority number (higher priority) or HEALTHY state while current is DEGRADED. If no target passes this precheck, emit nonterminal `failover.no_target_available` with `{terminal: false}` and stay ACTIVE. If a suitable target exists, set session state to `SWITCH_PENDING_AT_IDLE`. On subsequent ticks, if session is `SWITCH_PENDING_AT_IDLE` and idle condition met (output log mtime stable for `idle_boundary_seconds`), recheck target suitability — if still suitable, execute the switch; if no better target remains, clear pending state back to ACTIVE and emit throttled nonterminal no-target event.
- **Hard threshold → immediate failover:** Call `performSwitch()` immediately (subject to `failover_in_progress` mutex).
- **HealthChecker.start() interval body:** Iterate `accountRegistry.getAll()`, call `checkAccountHealth()` for each, call `this.onResult()` for unhealthy accounts.
- **IdleWatchdog.start() interval body:** Read current session state, call `isSessionIdle(outputLogPath, idleBoundarySeconds)`, if idle call `this.onIdle(sessionId)`.
- **failover_in_progress flag:** Added to `LoopManager` instance. Checked before any `performSwitch()` call. Set before, cleared after (in finally block).

**Definition of Done:**

- [ ] RateLimitMonitor reads real statusline telemetry via `readTelemetryForActiveSession()` on each tick
- [ ] RateLimitMonitor calls `checkThresholds()` with real telemetry data and config thresholds
- [ ] Soft threshold triggers `SWITCH_PENDING_AT_IDLE` with target precheck; no-better-target stays ACTIVE with nonterminal event
- [ ] Hard threshold triggers immediate `performSwitch()` (guarded by `failover_in_progress`)
- [ ] `SWITCH_PENDING_AT_IDLE` + idle condition met → execute switch
- [ ] HealthChecker iterates all accounts and calls `checkAccountHealth()` on each tick
- [ ] IdleWatchdog reads session output log mtime and calls `isSessionIdle()` on each tick
- [ ] `failover_in_progress` flag prevents concurrent switch attempts across loops
- [ ] Session `claude_session_id` and `transcript_path` hydrated from telemetry when first available
- [ ] Existing rate-limit-monitor tests still pass; new test verifies tick reads telemetry and calls onBreach

**Verify:**

- `npx vitest run tests/daemon/loops/`

---

### Task 2: Wire Recovery Handler with Output Log Scanning and Pane Death Detection

**Objective:** Replace the placeholder interval callback in `RecoveryHandler` with real tick body that scans output logs for 429 patterns, detects pane death, and triggers appropriate recovery (same-account restart vs account switch).

**Dependencies:** Task 1 (LoopManager deps pattern)

**Files:**

- Modify: `src/daemon/loops/recovery-handler.ts`
- Modify: `tests/daemon/loops/recovery-handler.test.ts`

**Key Decisions / Notes:**

- **RecoveryHandler gains deps:** `sessionManager`, `tmuxSocket` (for `isProcessDead()`), `journal` (for events), and access to `failover_in_progress` flag via callback.
- **Recovery tick body:**
  1. Get current session from sessionManager. If no active session (or STOPPED/EXHAUSTED), skip.
  2. Check `isProcessDead(tmuxSocket, session.tmux_name)`.
  3. If pane is dead:
     a. Read output log from cursor to EOF (bounded to last 64KB).
     b. Call `detect429InOutput()` on the new content.
     c. If 429 detected → call `onCrashDetected(sessionId, true)` → triggers account switch via `performSwitch()`.
     d. If no 429 → call `onCrashDetected(sessionId, false)` → triggers same-account restart using `respawnPane()` + four-step relaunch.
  4. If pane is alive: advance cursor to current EOF (no scan needed).
- **Output log reading with 64KB bound:** Use `openSync` + `fstatSync` for size → `readSync` from `max(0, size - 65536)` to cursor offset → close. Avoids loading full log into memory.
- **Same-account restart:** Dead pane → `respawnPane(socket, name, cwd, env)` → `set-window-option remain-on-exit on` → `startOutputLog()` → `send-keys exec <runner-command>` → `send-keys Enter`. This is the canonical restart primitive from the plan (Task 3 acceptance criteria).
- **Repeated restart failures:** Track consecutive same-account restart count per session. After 3 failures within 5 minutes, escalate to account switch. Circuit breaker only increments on rate-limit failures per the plan.
- **Cursor initialization:** For new sessions, init cursor at EOF. On daemon restart with live pane, init at EOF. On daemon restart with dead pane, init at `max(0, fileSize - 65536)` (scan last 64KB).
- **State/loop matrix filtering:** Recovery handler processes `ACTIVE` and `SWITCH_PENDING_AT_IDLE` sessions. `SWITCH_PENDING_AT_IDLE` + crash → upgrade to immediate switch.

**Definition of Done:**

- [ ] Recovery handler detects pane death via `isProcessDead()` on each tick
- [ ] Output log scanned from cursor with 64KB bound
- [ ] `detect429InOutput()` called on new output content
- [ ] Crash with 429 → account switch via `onCrashDetected(id, true)`
- [ ] Crash without 429 → same-account restart using `respawnPane()` + four-step relaunch
- [ ] Repeated same-account restart failures (3 within 5 min) escalate to account switch
- [ ] `SWITCH_PENDING_AT_IDLE` + crash → immediate switch
- [ ] Cursor starts at EOF for live panes, scans last 64KB for dead panes on daemon restart
- [ ] No 429 replay from pre-rotation output (cursor tracks generation)
- [ ] Existing recovery-handler tests pass; new test verifies tick detects dead pane and calls onCrash

**Verify:**

- `npx vitest run tests/daemon/loops/recovery-handler.test.ts`

---

### Task 3: Implement Full Rehydration Recovery

**Objective:** Replace detection-only rehydration with full recovery: pipe-pane restoration for live sessions, per-phase switch_tx recovery table, same-account restart for state-without-tmux.

**Dependencies:** Task 2 (restart primitive pattern)

**Files:**

- Modify: `src/daemon/index.ts` (rehydrateSessions function)
- Modify: `src/session/manager.ts` (add `restartSession()` method for same-account restart)
- Test: `tests/daemon/rehydration.test.ts` (new — deterministic fixture tests)

**Key Decisions / Notes:**

- **Rehydration function gains deps:** `sessionManager`, `accountRegistry`, `config` (runner, statusline), `journal`, `tmuxSocket`.
- **Pipe-pane restoration for live sessions:** After identifying a live ACTIVE session, check `isPipePaneActive(socket, tmux_name)`. If false, call `startOutputLog(socket, tmux_name, session.output_log_path)` to restore pipe-pane. Log `output_log.cursor_reset` event.
- **Per-phase switch_tx recovery table** (from plan `docs/plans/2026-04-29-aisup-supervisor-daemon.md`):
  | Phase at crash | Recovery action |
  |---|---|
  | `snapshot` | Clear `switch_tx`, return session to ACTIVE |
  | `stopping` | Check `isProcessDead` by persisted source tmux ID. Alive → clear switch_tx, return ACTIVE. Dead → kill source tmux, advance to `source_destroyed`. |
  | `source_destroyed` | Kill stale source tmux if still exists, advance to `migrating`. |
  | `migrating` | Check target transcript hash. Match → advance to `creating`. Mismatch → re-copy via `migrateTranscript()`. |
  | `creating` | Check if target tmux exists and matches persisted target ID → advance to `resuming`. Otherwise → create new target session. |
  | `resuming` | Check if target tmux is alive → set ACTIVE, clear switch_tx. Dead → treat as creation failure, advance to next target or EXHAUSTED. |
- **Same-account restart for state-without-tmux:** When a persisted ACTIVE/SWITCH_PENDING_AT_IDLE session has no live tmux, attempt same-account restart: create new tmux session with same `aisup_session_id`, using `respawnPane` pattern if tmux session exists but pane is dead, or full `createSession` if tmux session is gone. If restart fails → log `recovery.failed` and set STOPPED.
- **SessionManager.restartSession():** Reuses existing `aisup_session_id`, creates new tmux session with same parameters, writes ACTIVE state. Uses `buildLaunchCommand()` with the session's account.

**Definition of Done:**

- [ ] Live ACTIVE sessions have pipe-pane restored if not active (`isPipePaneActive` check + `startOutputLog`)
- [ ] switch_tx recovery implements all 6 phases from the per-phase table
- [ ] `snapshot` phase → clear switch_tx, return ACTIVE
- [ ] `stopping` phase → check source pane death, branch to clear or advance
- [ ] `source_destroyed` → clean stale source, advance to migrating
- [ ] `migrating` → check transcript hash, re-copy if needed
- [ ] `creating` → check target tmux, create if missing
- [ ] `resuming` → check target alive, set ACTIVE or fail to next target
- [ ] State-without-tmux (ACTIVE/SWITCH_PENDING_AT_IDLE, no tmux) → same-account restart attempt
- [ ] Failed restart → log `recovery.failed`, set STOPPED
- [ ] Journal events emitted for each recovery action
- [ ] Rehydration test covers: live session with pipe-pane disabled, interrupted switch at each phase, state-without-tmux restart

**Verify:**

- `npx vitest run tests/daemon/`

---

### Task 4: Implement Slack Service with Bolt Lifecycle, Channels, Commands, Relay

**Objective:** Create `SlackService` that wraps Bolt app lifecycle, channel creation/invite, command dispatch for all 6 commands, output relay with redaction, and channel map persistence. Wire into daemon startup.

**Dependencies:** None (uses existing Slack helpers)

**Files:**

- Create: `src/slack/service.ts` — SlackService class
- Modify: `src/slack/client.ts` — add message event handler registration
- Modify: `src/slack/commands.ts` — add command executor functions (not just parser)
- Modify: `src/slack/relay.ts` — add output relay poller
- Test: `tests/slack/service.test.ts` (new — command dispatch with fake tmux/session)

**Key Decisions / Notes:**

- **SlackService interface:**
  ```typescript
  class SlackService {
    constructor(opts: { config: SlackConfig; sessionManager: SessionManager;
                        tmuxSocket: string; journal: JournalWriter; })
    async start(): Promise<void>       // creates Bolt app, registers handlers, starts
    async stop(): Promise<void>        // stops Bolt app
    async onSessionStart(session: SessionState): Promise<void>  // create channel, invite users
    async onSessionStop(sessionId: string): Promise<void>       // post summary, optionally archive
    getChannelId(sessionId: string): string | null
  }
  ```
- **Channel lifecycle:**
  - `onSessionStart`: call `conversations.create(name, is_private: true)`. Handle `name_taken` with retry (append counter). Call `conversations.invite` for each `allowed_user_ids`. Persist channel map.
  - Channel map: `~/.aisup/channel-map.json` — `Record<aisupSessionId, channelId>`. Read on `start()`, write on every channel create/delete.
- **Message handler registration:** In `start()`, register `app.message()` handler that:
  1. Checks `isBotMessage(event)` → ignore
  2. Checks `isAllowedUser(event.user, allowedUserIds)` → ignore + log `slack.message_ignored`
  3. Calls `parseCommand(event.text)` → if command, dispatch to command executor
  4. If not a command: if relay is on, store as note (no-op for Phase 1)
- **Command executors** (in `src/slack/commands.ts`):
  - `!interrupt` → `sendInterrupt(socket, tmuxName)` → post "Interrupted." to channel
  - `!stop` → require confirmation: post "Session will be terminated. Reply `!confirm` within 60s." → `ConfirmationStore.set()`. On `!confirm` → `sessionManager.stopSession()` → post "Session stopped."
  - `!status` → `captureOutput(socket, tmuxName, 50)` → post redacted output to channel
  - `!cmd <text>` → if `cmd_require_confirmation`, require confirm. Then `sendText(socket, tmuxName, text)` + `sendEnter(socket, tmuxName)` → post "Sent: <text>"
  - `!relay on|off` → toggle per-channel relay flag → post confirmation
  - `!help` → post command reference
  - `!failover --to <account>` → call `performSwitch()` via deps → post result
- **Output relay** (when `relay_output_enabled: true`): On a configurable interval (10s), capture recent tmux output via `captureOutput()`, diff against last-posted content, redact via `redactSecrets()`, post to channel. Skip if no new content. Rate-limited to 1 post per 5s per channel.
- **Bot echo prevention:** `isBotMessage()` check is the first gate in message handler. Already implemented in `relay.ts`.

**Definition of Done:**

- [ ] Slack bolt app connects via Socket Mode with configured tokens
- [ ] Channel created on session start with correct naming (via `buildChannelName()`)
- [ ] Channel name collision handled with retry (append counter)
- [ ] All users in `allowed_user_ids` invited to channel on creation
- [ ] `!interrupt` sends Ctrl+C to tmux session via `sendInterrupt()`
- [ ] `!stop` requires confirmation via `ConfirmationStore`, then calls `stopSession()`
- [ ] `!status` captures and posts redacted pane output
- [ ] `!cmd <text>` relays text to tmux via `sendText()` + `sendEnter()`, with optional confirmation
- [ ] `!relay on|off` toggles output relay for the channel
- [ ] `!help` posts command reference
- [ ] Non-allowed users ignored with `slack.message_ignored` journal event
- [ ] Bot's own messages not processed (no echo loop)
- [ ] When `relay_output_enabled: true`, new tmux output posted to channel with redaction
- [ ] Channel map persisted to `~/.aisup/channel-map.json` and restored on start
- [ ] Disabled Slack mode (`slack.enabled: false`) → no Bolt import, no service created
- [ ] Tests cover command dispatch with mocked tmux/session deps

**Verify:**

- `npx vitest run tests/slack/`

---

### Task 5: Add Tmux Timeout Journaling via Callback

**Objective:** Emit `tmux.command_timeout` journal events when tmux commands time out, with sanitized operation and target details.

**Dependencies:** None

**Files:**

- Modify: `src/session/tmux.ts`
- Modify: `src/session/manager.ts` (pass journal callback)
- Modify: `tests/session/tmux.test.ts`

**Key Decisions / Notes:**

- **Problem:** `tmuxWithTimeout()` is a low-level function called from many places. It has no journal access. Adding journal as a parameter to every caller is invasive.
- **Solution:** Module-level `onTmuxTimeout` callback. Set once by the daemon during startup. Default is no-op. When set, called with `{ operation: string, target: string, timeoutMs: number }` on actual timeout (not other exec failures).
- **Distinguishing real timeouts:** `execFileSync` sets `err.killed === true` and `err.signal === 'SIGTERM'` when the process is killed by timeout. Check both before calling the timeout callback. Other exec failures (session not found, permission denied) should NOT emit `tmux.command_timeout`.
- **Sanitization:** Operation is the tmux subcommand (e.g., `send-keys`, `display-message`). Target is the session name (e.g., `aisup-abc12345`). No full command string or arguments — those may contain paths or shell content.
- **Registration:** Export `setTmuxTimeoutHandler(handler)` from `tmux.ts`. Daemon calls it during startup with a handler that appends to journal.

**Definition of Done:**

- [ ] `tmuxWithTimeout()` calls `onTmuxTimeout` callback on actual timeout (killed + SIGTERM), not on other errors
- [ ] Callback receives sanitized `{ operation, target, timeoutMs }` — no full args or paths
- [ ] Default callback is no-op (no journal dependency at module level)
- [ ] Daemon registers handler via `setTmuxTimeoutHandler()` during startup
- [ ] Journal event emitted as `tmux.command_timeout` with operation and target
- [ ] Test verifies callback called on simulated timeout, not called on regular error

**Verify:**

- `npx vitest run tests/session/tmux.test.ts`

---

### Task 6: Wire Everything into Daemon Startup and Verify

**Objective:** Update `src/daemon/index.ts` to pass real deps to LoopManager, register tmux timeout handler, start Slack service, and ensure all integration points work together. Update review document.

**Dependencies:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files:**

- Modify: `src/daemon/index.ts` — full wiring
- Modify: `docs/reviews/2026-05-06-phase1-full-implementation-review.md` — update issue statuses

**Key Decisions / Notes:**

- **LoopManager construction:** Pass `sessionManager`, `accountRegistry`, `config` (thresholds, statusline, session, monitoring), `journal`, `tmuxSocket`, and `performSwitch` callback. LoopManager distributes deps to individual loops.
- **Slack service:** If `config.slack.enabled`, read tokens from env vars, create `SlackService`, call `start()` after server is ready. On session creation events, call `onSessionStart()`. On shutdown, call `stop()`.
- **Tmux timeout handler:** Call `setTmuxTimeoutHandler()` with a handler that appends `tmux.command_timeout` events to journal.
- **Rehydration deps:** Pass `sessionManager`, `accountRegistry`, `config.runner`, `config.statusline`, `journal` to the rehydration function.
- **Recovery handler cursor init:** After rehydration, for each live session, init recovery handler cursor. Live pane → EOF. Dead pane → `max(0, size - 65536)`.
- **Smoke test order:** typecheck → build → test → CLI --help. All must pass.

**Definition of Done:**

- [ ] LoopManager receives real deps and loops read real data
- [ ] Tmux timeout handler registered in daemon startup
- [ ] Slack service started/stopped in daemon lifecycle (when enabled)
- [ ] Rehydration uses SessionManager for recovery actions
- [ ] Recovery handler cursors initialized for rehydrated sessions
- [ ] `tests/daemon/loops/rate-limit-monitor.test.ts` — test verifying tick reads telemetry and calls onBreach with real threshold result
- [ ] `tests/daemon/loops/recovery-handler.test.ts` — test verifying tick detects dead pane and calls onCrash with correct 429 flag
- [ ] `tests/daemon/rehydration.test.ts` — tests covering: live session pipe-pane restore, switch_tx recovery at each phase (snapshot/stopping/source_destroyed/migrating/creating/resuming), state-without-tmux restart
- [ ] `tests/slack/service.test.ts` — tests covering: command dispatch (all 6 commands with mocked tmux/session), allowed-user enforcement, bot-message filtering, channel map persistence
- [ ] `tests/session/tmux.test.ts` — test verifying timeout callback called on simulated timeout, not on regular error
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm test` passes (all tests green)
- [ ] `node bin/aisup.js --help` works
- [ ] Review document updated with all 4 issues marked FIXED

**Verify:**

- `npm run typecheck && npm run build && npm test`

---

## Open Questions

None — all design decisions resolved via plan and user input.

### Deferred Ideas

- Prompt detection for more accurate idle-boundary switching (Phase 2)
- Slack channel archival on session stop (optional, not in Phase 1 plan acceptance criteria)
- Output relay cursor persistence across daemon restarts (optimization)
