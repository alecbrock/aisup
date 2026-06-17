# aisup — AI Supervisor / Orchestrator

Created: 2026-04-29
Author: alec.m.brock@gmail.com
Category: Infrastructure
Status: Final
Research: Deep

## Problem Statement

Long-running AI coding sessions across multiple Claude accounts break when rate limits, auth failures, crashes, or remote-control gaps occur. The operator loses context, wastes time manually switching accounts and resuming conversations, and cannot effectively supervise sessions when away from the laptop on phone-only remote access. There is no unified control plane for session lifecycle, account management, failure recovery, multi-LLM orchestration, or cost visibility.

aisup is a daemon-based supervisor that wraps Pilot Shell (or Claude Code directly) in managed tmux sessions, automatically fails over across accounts, preserves workflow skill state, provides Slack-based remote control, and exposes a CLI + HTTP API for full session observability.

## Core User Flows

### Flow 1: Start a Supervised Session

1. User runs `aisup start`
2. Daemon scores all configured accounts by remaining headroom (5-hour and 7-day usage)
3. Daemon creates a tmux session, launches Pilot (or Claude) inside the tmux pane (output captured via tmux `pipe-pane`) under the best account's CLAUDE_CONFIG_DIR
4. Daemon starts monitoring loops (rate-limit, health, recovery)
5. Daemon creates a Slack channel for the session and posts session info
6. User interacts with the session via `aisup attach` or Slack

### Flow 2: Automatic Account Failover

1. Rate-limit monitor detects usage at 85% (soft) or 95% (hard) of 5-hour cap
2. Daemon snapshots session state: session_id, transcript_path, active workflow skill, plan file path
3. Daemon scores remaining accounts and selects the best
4. Daemon gracefully stops the current session (SIGTERM → 2s → SIGKILL)
5. Daemon copies transcript .jsonl to target account's project directory
6. Daemon creates a new tmux session under the target account's CLAUDE_CONFIG_DIR
7. Daemon resumes with `pilot --resume <session_id>` (or `claude --resume`)
8. Daemon injects a continuation prompt referencing the active workflow skill and current task
9. Daemon posts switch notification to Slack channel
10. User continues working — potentially without noticing the switch

### Flow 3: Reactive Failure Recovery

1. Recovery handler detects: 429 string in the captured tmux output log, process exit (dead pane), or an externally destroyed tmux session
2. If rate-limit: triggers the same failover sequence as Flow 2
3. If process crash: restarts session on same account (if healthy) or switches
4. Circuit breaker: after 3 consecutive failures, stops retrying and notifies user via Slack
5. Event logged to journal

### Flow 4: Remote Operation from Phone

1. User opens the session's Slack channel on their phone
2. User sends a message — Slack Socket Mode relays it as keystrokes to the tmux session
3. Claude's response appears in the Slack channel
4. Control commands: `!stop` (Ctrl+C), `!status` (current output), `!cmd <text>` (verbatim relay)
5. When the session needs approval, the user sees the prompt in Slack and responds

### Flow 5: Check Status from Another Terminal

1. User runs `aisup status` — shows current session, active account, usage percentages, active skill, uptime
2. User runs `aisup log` — shows recent events (switches, failures, recoveries)
3. User runs `aisup accounts` — shows all accounts with usage bars and health status

## Scope

### In Scope

**MVP (Phase 1):**
- Daemon process with manual start (`aisup daemon start`)
- Session controller: tmux session management, tmux `pipe-pane` output capture
- Account registry: YAML config, usage scoring from statusline tap data, best-account selection
- Proactive rate-limit failover: 85% soft switch, 95% hard switch, full migration sequence
- Reactive recovery: 429 regex detection on captured tmux output, process crash restart, circuit breaker (3 failures)
- Slack integration: per-session channel, bidirectional message relay, control commands
- Event journal: JSONL log of all supervisor events
- Status CLI: `aisup start`, `status`, `log`, `accounts`, `stop`, `attach`, `daemon start/stop`
- Workflow skill propagation: detect active skill (/prd, /spec, /fix, /review, /security-review), propagate on resume
- Runner abstraction: configurable command (pilot or claude), detachable via config change

**Phase 2:**
- Full reactive recovery: auth failure detection, both-exhausted sleep-until-reset, network retry (remote-control reconnect is **deferred** — see the reconciliation note in Technical Context)
- Permission fallback broker: observability (log all permission requests), one-time grant via Slack, policy allowlist/denylist
- Approval routing: Slack-based approve/deny for pending permission prompts
- Validation gate engine: configurable gates (test suite, lint, type check) after task completion
- Cost/token tracking: aggregation from statusline tap, `aisup cost` CLI with rolling `today`/`last_7d`/`last_30d` windows (itemized calendar summaries deferred)

**Phase 3:**
- Multi-LLM worker orchestration: Codex CLI, Gemini CLI, local LLM adapters
- Task contract: input artifact → isolated git worktree → output artifacts
- Cross-model review: reviewer model ≠ implementer model
- Merge gate: user approval required, validation gates on worker output
- Routing heuristic: task-type → preferred-model mapping (configurable)

**Phase 4:**
- Mobile status dashboard: HTTP `/dashboard` endpoint, auto-refreshing, token auth for remote access
- ntfy as lightweight notification fallback (optional alternative to Slack)
- Daemon enhancements: log rotation, health self-check
- Enhanced Slack features: thread summaries, file sharing, rich formatting

### Explicitly Out of Scope

- Web-based terminal (ttyd/gotty) — security risk, tmux + remote-control is sufficient
- OpenTelemetry integration — overkill for single-user system; JSONL event journal suffices
- Proxy-level model routing (Bifrost pattern) — complementary tool, not a supervisor feature
- Auto-approval without explicit policy — security risk
- Multiple simultaneous lead sessions — one lead session at a time; workers are separate
- Windows/Linux support — macOS only (matches operator's platform)
- launchd auto-start — manual daemon start only; user-controlled lifecycle

## Technical Context

> **Implementation Status Reconciliation (2026-06-01).** This PRD predates implementation;
> the following clarifications supersede stale current-behavior wording below:
> - **Session I/O is tmux-native, not `node-pty`.** The runner (pilot/claude) executes
>   directly inside a tmux pane; aisup captures output via tmux `pipe-pane` into a per-session
>   output log and reads that log. There is no `node-pty` dependency. Remaining "PTY"/"node-pty"
>   references describing aisup's own process are historical and superseded by this note; "PTY"
>   references in the Prior Art section describe other projects and remain accurate.
> - **Statusline telemetry is read, not installed.** aisup reads the existing Pilot/Claude
>   statusline tap files (`statusline-<claude_session_id>.json`); it does **not** install its
>   own statusline hook.
> - **The event journal path is configurable** via `config.journal.path` (default
>   `~/.aisup/journal.jsonl`); the literal `~/.aisup/events.jsonl` references are superseded.
> - **Phase 1 implemented:** the Supervisor Daemon, Smart Account Selection, Proactive
>   Failover, core Reactive Recovery, Slack Remote Control (E), Workflow Skill Propagation,
>   and the Event Journal + Status CLI (I) are implemented and verified.
> - **Phase 2 implemented and verified:** D₂ auth/network/exhausted recovery, the Permission
>   Fallback Broker (F), Slack approval routing, the supervisor Validation Gate Engine (H₁),
>   and Cost/Token Tracking (K) are complete and verified (see
>   `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` — `Status: VERIFIED`; the Round 3
>   compliance audit in `docs/reviews/2026-06-02-phase2-spec-verify-findings.md` is CLEAN).
>   **Remote-control reconnect after an account switch is explicitly deferred** pending
>   investigation of Claude Code remote-control behavior; the existing
>   `runner.remote_control_prefix` remains supported but no reconnect orchestration ships in
>   Phase 2.
> - **Phase 3 implemented:** Multi-LLM Worker Orchestration (G) and the worker Validation Gate
>   Engine (H₂) — bounded LLM workers in isolated git worktrees, cross-model review, and
>   approval-gated working-tree merge. Includes the CLI (`aisup worker …`), the localhost worker
>   API, and Slack `!worker` subcommands (`status`/`approve`/`deny`). Real provider CLIs are
>   exercised behind host gates; the always-run suite uses fake adapters.
> - **Cost windows:** `aisup cost` reports rolling `today`, `last_7d`, and `last_30d` windows
>   as the Phase 2 implementation of daily/weekly visibility; itemized calendar summaries
>   remain deferred.

### Technology Stack

- **Language:** Node.js 22+ with TypeScript
- **Session I/O & persistence:** tmux — the runner runs natively in a tmux pane; output is captured via `pipe-pane` to a per-session log (no `node-pty`)
- **Config format:** YAML (js-yaml)
- **HTTP API:** fastify (or plain http module), localhost-only for MVP
- **Slack:** @slack/bolt (Socket Mode), @slack/web-api
- **Event journal:** JSONL (append-only file)
- **Package manager:** npm
- **Testing:** vitest, host-gated integration tests for tmux/Slack/Claude

### Relevant Architecture

- Supervisor owns the process: `aisup daemon` → `tmux session` (pipe-pane → output log) → `pilot/claude`
- Pilot Shell is treated as a black box — the supervisor launches it in a tmux pane and reads its output log, never imports Pilot internals
- Runner abstraction: `runner.command` in config (defaults to `pilot`, set to `claude` to detach Pilot)
- Statusline tap: supervisor reads the existing Pilot/Claude statusline tap files (`statusline-<claude_session_id>.json`); it does not install its own hook
- Account registry: YAML config with config_dir paths, scored by remaining usage headroom
- Event journal: append-only JSONL at the configured `config.journal.path` (default `~/.aisup/journal.jsonl`)
- HTTP API: localhost-bound, powers CLI subcommands and future dashboard

### Constraints

- `CLAUDE_CONFIG_DIR` is evaluated at process start — account switching requires process restart
- `rate_limits` in statusline data may be absent before the first API response in a session
- Transcript-only migration is sufficient for session resume (validated in Phase 3A)
- Workflow skill detection relies on PTY output patterns — if output format changes, regex needs updating
- Slack Socket Mode requires a Slack app with bot + app tokens (free tier sufficient)

### Existing Code and Prior Work

- Phase 3A validation results: `AI_FAILOVER_PHASE_3A_RESULTS.md` — all 4 gates passed
- Phase 3A runbook: `AI_FAILOVER_PHASE_3A_RUNBOOK.md` — test procedures
- Failover Round 5 acceptance: `AI_FAILOVER_ROUND5_ACCEPTANCE.md` — corrections applied
- Token usage validation: `AI_STACK_TOKEN_USAGE_VALIDATION_2026-04-21.md`
- Prior design artifact: `docs/plans/2026-04-23-ai-supervisor-design.md` (Codex-authored, DRAFT)
- Existing statusline tap: `scripts/failover/statusline-tap.sh` → `/tmp/pilot-failover/statusline-<session_id>.json`

### Runner Abstraction (Pilot Detachment)

The supervisor interacts with Pilot (or Claude) exclusively through the CLI interface. No Pilot libraries are imported. Config drives the runner:

```yaml
runner:
  command: pilot          # change to "claude" to detach Pilot
  args:
    - --remote-control
  resume_flag: --resume
  config_dir_env: CLAUDE_CONFIG_DIR
```

To stop using Pilot Shell: change `command` to `claude`, adjust `args` as needed. No code changes required.

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Architecture | Full daemon + session model | Supports all features A-L. Sessions survive terminal close. HTTP API enables CLI, mobile dashboard, and Slack. No half-implementation — build the right thing once. |
| Language | Node.js / TypeScript | Matches Claude Code ecosystem. Session I/O is tmux-native (`pipe-pane` capture), so no `node-pty` is needed. claude-nonstop proves the broader pattern. |
| Notification channel | Slack (MVP), ntfy as optional fallback | Slack provides bidirectional remote control (not just notifications). Free tier sufficient. Channel-per-session gives organized history. |
| Config format | YAML | Human-readable, comments, widely understood. Good for nested account/policy config. |
| Daemon lifecycle | Manual start only | User-controlled. `aisup daemon start` / `aisup daemon stop`. No launchd. |
| Statusline tap | Read existing Pilot/Claude tap files | Supervisor reads `statusline-<claude_session_id>.json` tap files; it does **not** install its own hook. |
| Project location | Separate repo | aisup is a standalone tool, not a feature of any specific project. Installable independently. |
| HTTP API auth | Localhost-only for MVP | Security via network binding. Token auth added in Phase 4 for remote dashboard access. |
| Pilot Shell dependency | Detachable via config | Runner abstraction means Pilot can be replaced with raw Claude (or any wrapper) by changing one config field. No code changes. |
| Workflow skill tracking | Dynamic, tracks transitions | Monitors PTY output for /prd, /spec, /fix, /review, /security-review. Propagates the latest active skill on account switch — not the skill that started the session. Utility skills not tracked. |

## Research Findings

### Ecosystem Tools Evaluated

| Tool | Key Pattern Extracted | Limitation for This System |
|------|----------------------|---------------------------|
| **claude-nonstop** (rchaz) | Usage-API account scoring, PTY rate-limit detection, Slack channel per session, tmux sessions, launchd | Spawns `claude` directly — bypasses Pilot. No workflow skill awareness. |
| **CC Switch** (farion1231) | Provider health monitoring, circuit breaker, proxy with auto-failover, multi-CLI support | GUI-centric desktop app, not a daemon. No session resume or transcript migration. |
| **Bridge ACE** (Luanace-lab) | 16 independent daemon loops (health supervisor, rate-limit resume, context threshold, idle watchdog, scope lock), multi-engine teams, mobile UI, task system with evidence | Full platform — much larger scope. Not Pilot-aware. Pattern of independent monitoring loops is directly applicable. |
| **claude-account-switcher** (ukogan) | CLAUDE_CONFIG_DIR per-profile isolation, symlinked shared config | Manual switching only. No failover automation. |
| **Bifrost CLI** | Multi-model routing through local proxy, provider failover at API level | Works at API level, not account/session level. Complementary, not competitive. |
| **ntfy** | Self-hosted push notifications via HTTP PUT/POST, action buttons, MCP server exists | Notification-only (not bidirectional). Good as lightweight Slack fallback. |

### Architecture Patterns Applied

1. **Independent daemon loops** (Bridge ACE): each monitoring concern gets its own loop with its own interval. Health checker (60s), rate-limit monitor (30s), recovery handler (5s), idle watchdog (120s). Single-responsibility, independently testable.

2. **PTY wrapping + output monitoring** (claude-nonstop): node-pty spawns the CLI tool, passes stdin/stdout through, and regex-matches output for rate-limit strings. Proven pattern.

3. **Account scoring by headroom** (claude-nonstop): query usage data for all accounts, rank by remaining capacity, pick the best. ~200ms per scoring cycle.

4. **Channel-per-session remote control** (claude-nonstop): Slack Socket Mode creates a dedicated channel for each session. Messages in channel → keystrokes to tmux. Claude output → posted back to channel. Control commands (`!stop`, `!status`, `!cmd`).

5. **Circuit breaker** (CC Switch, standard resilience): after N consecutive failures, mark the resource as unavailable for a cooldown period. Prevents crash loops.

## Validation Requirements

### Must Be Validated with Real Integration Tests

| What | Why It Can't Be Mocked |
|------|----------------------|
| PTY passthrough fidelity | Terminal escape codes, SIGWINCH, interactive prompts must work perfectly |
| Account switch + resume sequence | Transcript migration timing and resume must not corrupt state |
| Workflow continuity after switch | Plan files, task state, and active skill must survive correctly |
| Workflow skill detection | PTY output patterns for /prd, /spec, /fix may vary by version |
| Statusline tap data | Supervisor-installed hook must produce expected JSON fields |
| Slack channel creation + message relay | Socket Mode, channel management, and bidirectional messaging end-to-end |
| Rate-limit detection from PTY output | Exact string patterns from real Claude/Pilot output |
| tmux session persistence | Session survives terminal close, daemon restart |
| Circuit breaker behavior | Stops after N failures, doesn't crash-loop |

### Failure Injection Scenarios

| Scenario | Simulation Method |
|----------|-------------------|
| Rate-limit 429 | Config threshold override (set to 1%) |
| Auth failure | Invalid/expired config dir |
| Process crash | `kill -9` the Pilot process in tmux |
| Network interruption | Temporary firewall rule |
| All accounts exhausted | All thresholds set to 0% |
| Stalled session | Let session idle with no output |

### Host Dependencies

| Dependency | Required For | Validation |
|------------|-------------|------------|
| Node.js 22+ | Everything | `node --version` |
| tmux | Session persistence | `tmux -V` |
| _(none — tmux pipe-pane)_ | Output capture | covered by tmux above; no `node-pty` dependency |
| Pilot CLI or Claude CLI | Session running | `pilot --version` or `claude --version` |
| Slack app (bot + app tokens) | Remote control | Token validation API call |
| Multiple Claude config dirs | Account switching | Directory existence check |

## Feature Inventory

| ID | Feature | Phase | Status |
|----|---------|-------|--------|
| A | Supervisor Daemon (manual start, tmux pipe-pane, runner abstraction) | MVP | Implemented (Phase 1) |
| B | Smart Account Selection (registry, scoring, best-account pick) | MVP | Implemented (Phase 1) |
| C | Proactive Rate-Limit Failover (85%/95% thresholds, full switch sequence) | MVP | Implemented (Phase 1) |
| D₁ | Reactive Recovery — core (429 regex, crash restart, circuit breaker) | MVP | Implemented (Phase 1) |
| D₂ | Reactive Recovery — full (auth failure, exhausted, network; RC reconnect deferred) | Phase 2 | Implemented (Phase 2) |
| E | Slack Remote Control (channel per session, bidirectional relay, control cmds) | MVP | Implemented (Phase 1) |
| F | Permission Fallback Broker (observability, one-time grant, policy allowlist) | Phase 2 | Implemented (Phase 2) |
| G | Multi-LLM Worker Orchestration (Codex, Gemini, local; worktrees; review gate) | Phase 3 | Implemented (Phase 3) |
| H₁ | Validation Gate Engine — supervisor (test/lint/type-check after completion) | Phase 2 | Implemented (Phase 2) |
| H₂ | Validation Gate Engine — workers (gates on worker output before merge) | Phase 3 | Implemented (Phase 3) |
| I | Event Journal + Status CLI (JSONL, start/status/log/accounts/stop/attach) | MVP | Implemented (Phase 1) |
| J | Workflow Skill Propagation (detect active skill, propagate on resume) | MVP | Implemented (Phase 1) |
| K | Cost/Token Tracking (aggregation, `aisup cost` CLI, rolling windows) | Phase 2 | Implemented (Phase 2) |
| L | Mobile Status Dashboard (HTTP endpoint, auto-refresh, token auth) | Phase 4 | Approved |

## State Model

### Session States

```
CREATING → RUNNING → SWITCHING → RUNNING
                  ↘ DEGRADED → SWITCHING → RUNNING
                  ↘ STALLED → RECOVERING → RUNNING
                  ↘ CRASHED → RECOVERING → RUNNING
                  ↘ STOPPED (terminal state)
```

### Account States

```
HEALTHY → DEGRADED (soft limit breached)
       → UNAVAILABLE (hard limit / auth failure / circuit breaker)
       → COOLDOWN (after circuit breaker trip)
       → HEALTHY (after cooldown / limit reset)
```

## Account Switching Flow

1. **Trigger**: threshold breach (85%/95%) OR 429 detected in tmux output OR auth failure OR process crash
2. **Snapshot**: `{session_id, transcript_path, active_skill, plan_file_path}`
3. **Score**: rank remaining accounts by headroom, exclude unavailable/cooldown
4. **Guard**: if no account available → EXHAUSTED state → sleep until earliest reset → notify via Slack
5. **Stop**: graceful kill (SIGTERM → 2s timeout → SIGKILL)
6. **Migrate**: copy transcript .jsonl to target account's project directory
7. **Create**: new tmux session (runner in-pane, pipe-pane capture) under target CLAUDE_CONFIG_DIR
8. **Resume**: `runner.command` + `runner.resume_flag` + `session_id`
9. **Inject**: continuation prompt referencing active workflow skill and current task position. Example: "You are continuing a /spec session. Plan file: docs/plans/2026-04-29-feature.md. Resume from the next uncompleted task in the plan. Read the plan file to re-orient."
10. **Notify**: post switch event to Slack channel and event journal

## Daemon Loops

| Loop | Interval | Responsibility |
|------|----------|---------------|
| Rate-limit monitor | 30s | Read statusline tap, check against 85%/95% thresholds |
| Health checker | 60s | Verify account availability, update circuit breaker state |
| Recovery handler | 5s | Watch for process exit (dead pane), destroyed tmux sessions, 429 strings in captured output |
| Idle watchdog | 120s | Detect stalled sessions (no output for configurable duration) |
| Notification emitter | Event-driven | Push events to Slack when they occur |

## CLI Commands

| Command | Description |
|---------|-------------|
| `aisup daemon start` | Start the supervisor daemon |
| `aisup daemon stop` | Stop the supervisor daemon |
| `aisup start` | Create and start a new supervised session |
| `aisup stop [session]` | Stop a session (or the active one) |
| `aisup attach [session]` | Attach terminal to a tmux session |
| `aisup status` | Show current session, account, usage, active skill |
| `aisup log` | Show recent events from the journal |
| `aisup accounts` | Show all accounts with usage and health |
| `aisup cost` | Show token/cost breakdown (Phase 2) |

## Event Journal Schema

File: the configured `config.journal.path` (default `~/.aisup/journal.jsonl`)

```json
{
  "ts": "2026-04-29T12:00:00Z",
  "event_type": "account.switch",
  "session_id": "abc-123",
  "account": "account2",
  "details": {"from": "default", "to": "account2", "reason": "rate_limit_85"},
  "tokens": 0,
  "cost_usd": 0
}
```

Event types: `session.start`, `session.stop`, `session.attach`, `account.switch`, `failure.detected`, `recovery.success`, `recovery.failed`, `circuit_breaker.tripped`, `circuit_breaker.reset`, `approval.requested`, `approval.granted`, `approval.denied`, `worker.dispatched`, `worker.completed`, `gate.passed`, `gate.failed`, `skill.detected`, `skill.transition`.

## Config Schema

File: `~/.aisup/config.yaml`

```yaml
runner:
  command: pilot
  args:
    - --remote-control
  resume_flag: --resume
  config_dir_env: CLAUDE_CONFIG_DIR

accounts:
  - name: default
    config_dir: ~/.claude
    email: user@gmail.com
  - name: account2
    config_dir: ~/.claude-account2
    email: user+2@gmail.com

failover:
  soft_threshold: 85
  hard_threshold: 95
  circuit_breaker_max_failures: 3
  circuit_breaker_cooldown_seconds: 300

slack:
  bot_token: xoxb-...
  app_token: xapp-...
  invite_user_id: U12345ABCDE

notifications:
  ntfy:
    enabled: false
    topic: aisup
    server: https://ntfy.sh

daemon:
  http_port: 9222
  event_journal_path: ~/.aisup/journal.jsonl   # actual config key: journal.path
  state_file_path: ~/.aisup/state.json

monitoring:
  rate_limit_interval_seconds: 30
  health_check_interval_seconds: 60
  recovery_check_interval_seconds: 5
  idle_watchdog_interval_seconds: 120
  idle_timeout_minutes: 10

skills:
  tracked:
    - /prd
    - /spec
    - /fix
    - /review
    - /security-review

permission_policy:  # Phase 2
  auto_approve:
    - "Read(*)"
    - "Bash(ls *)"
    - "Bash(grep *)"
    - "Bash(pytest *)"
  always_deny:
    - "Bash(rm -rf *)"
    - "Bash(git push *)"
    - "Bash(*secret*)"
    - "Bash(*credential*)"
```

## Phase Plan

### Phase 1 — MVP: Core Supervised Sessions

Features: A, B, C, D₁, E, I, J

Acceptance criteria:
1. `aisup daemon start` launches the daemon, `aisup start` creates a supervised session in tmux
2. Best account selected at launch based on usage scoring
3. Auto-switches accounts when rate-limit threshold is breached
4. Conversation resumes on new account with correct session context
5. Active workflow skill (/spec, /prd, /fix) propagated correctly on switch
6. Slack channel created for session with bidirectional message relay
7. `aisup status` shows current session, account, usage
8. `aisup log` shows recent events
9. `aisup attach` connects terminal to active session
10. Changing `runner.command` to `claude` works without code changes
11. Circuit breaker stops retrying after 3 consecutive failures and notifies via Slack
12. tmux session survives terminal close

### Phase 2 — Recovery, Permissions, and Cost

Features: D₂, F, H₁, K

Acceptance criteria:
1. Auth failure on one account → auto-switch to next healthy account
2. All accounts exhausted → sleep until reset, notify user with ETA via Slack
3. Permission prompt detected → posted to Slack → user approves → session unblocked
4. Policy file auto-approves configured safe operations
5. Validation gates block task completion on failure
6. `aisup cost` shows session/daily/weekly token and cost breakdown

### Phase 3 — Multi-LLM Worker Orchestration

Features: G, H₂

Acceptance criteria:
1. Codex worker completes a bounded task in isolated git worktree
2. Gemini worker completes a bounded task in isolated git worktree
3. Cross-model review catches an intentionally seeded bug
4. Worker cannot write outside its allowed workspace
5. Failed validation gate blocks merge
6. User approval required for every merge
7. Approved patch applies cleanly to main workspace

### Phase 4 — Dashboard and Enhancements

Features: L + enhancements

Acceptance criteria:
1. Mobile dashboard accessible via HTTP with token auth
2. Dashboard shows account status, session info, recent events, current task
3. ntfy available as lightweight notification alternative
4. Log rotation configured and working
