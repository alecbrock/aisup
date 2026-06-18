# aisup Full-System Validation + Multi-Provider Failover Plan

Created: 2026-06-17
Author: alec.m.brock@gmail.com (with Claude)
Status: DRAFT — under discussion (not yet approved for execution)
Type: Validation (Part A) + Feature (Part B)
Source of truth: docs/prd/2026-04-29-ai-supervisor.md (Feature Inventory A–L)

## Purpose

A single definition-of-done for confirming the **entire aisup system works as defined across
all phases**, plus the design for the one capability the user wants that is **not yet built**
(unified, usage-aware model failover for orchestrator/implementer/reviewer).

- **Part A** is acceptance validation of every existing feature with **real manual tests — no
  mocks, no stubs** — against the running daemon, real tmux sessions, real Slack, real accounts,
  and (for workers) the real codex CLI.
- **Part B** is a new feature: each role (orchestrator, implementer, reviewer) can be any
  provider/model/config, with usage-aware failover that **prefers switching Claude accounts before
  switching LLMs**.

Nothing in Part A is marked done without **fresh command/Slack/UI evidence** captured in the run.

## How to use this doc

Each Part A item has: **What** · **Expected behavior** · **Where (code)** · **Manual test
(real)** · **Pass criteria** · **Cost tier**. Execution logs results in a `## Validation Results`
table appended at the end (PASS / FAIL / BLOCKED + evidence pointer). A FAIL becomes a `/fix`.

## Current State (verified facts, 2026-06-17)

- Phases 1–3 are implemented; Phase 1/2 VERIFIED, Phase 3 VERIFIED (this session). 569 unit/integration tests pass, typecheck clean, build emits `dist/cli/index.js` + `dist/daemon/index.js`.
- Daemon proven to run end-to-end this session: `daemon start` → `/api/health` ready → authed `/api/status` 200 → `aisup status` clean → `daemon stop` clean.
- **Usage signal**: Claude accounts only, via statusline tap files `/<statusline_dir>/statusline-<uuid>.json` → `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`. Score = `(100-5h%)*0.7 + (100-7d%)*0.3`, ×0.8 if stale (`src/accounts/scorer.ts`). **No equivalent usage signal exists for codex/gemini/ollama.** ← central constraint for Part B.
- **Context handoff is already token-lean**: failover copies the transcript `.jsonl` to the target account, relaunches with `--resume <session_id>`, and injects a tiny templated continuation prompt (skill + plan path; `src/skills/continuation.ts`), configurable via `resume_prompt_mode` (incl. `never`). It does **not** re-summarize — `--resume` loads the existing transcript. Optimization work is therefore about confirming/measuring, not redesigning.
- **Error handling**: auth-failure (6 regexes) → account switch; network (6 regexes) → same-account restart after threshold; 429/rate-limit → failover; dead pane/crash → restart-or-switch; both-exhausted → sleep-until-reset + Slack; circuit breaker after N consecutive failures (`src/recovery/*`, `src/daemon/loops/*`).
- **Workers**: static `codex`/`gemini`/`local` CLI adapters; routing only falls back to same-model degraded among *configured* adapters. **No usage tracking and no account/LLM failover for workers** (the Part B gap).

## Testing Harness & Conventions

### Config for testing (everything is configurable — confirmed)

- **Failover threshold**: `thresholds.soft_pct` (default 85), `thresholds.hard_pct` (default 95). Lower (e.g. `soft_pct: 5`) to trigger the *automatic* path quickly during a live session.
- **Manual failover (cheapest)**: `aisup failover --to <account>` exercises the full switch + context-handoff path with ~no extra model spend. Use this for mechanism tests; use lowered thresholds for the *trigger* test.
- **Error injection (cheap)**: most recovery paths are testable by writing matching strings into the captured tmux output log, `kill -9` of the in-pane process, or pointing an account at an invalid `config_dir` — no real API spend. (PRD "Failure Injection Scenarios".)
- A dedicated test config (`~/.aisup/config.testing.yaml`, loaded via `loadConfig(path)`) keeps test thresholds out of the real config. Decision to confirm: separate file vs temporary edits.

### Cost tiers (per user)

- **Lean** — manual failover, injected errors, low thresholds, short sessions. Default for mechanism checks.
- **Moderate** — realistic-length sessions, a few real automatic failover cycles, real worker dispatches.
- **Exhaustive** — stress: large contexts, repeated cycles, long sessions, realistic end-to-end flows. Run last, only for what lean/moderate can't prove.

### Evidence rules

Real execution only. Each PASS needs captured evidence: command + output, journal lines (`aisup log`), Slack screenshot/message, or API response. "Tests pass" is never sufficient for a runtime feature.

---

# Part A — Full-System Validation (Definition of Done)

## Phase 1 features

### A. Supervisor Daemon (tmux pipe-pane, runner abstraction)
- **Expected**: `daemon start/stop` clean; runner runs in a tmux pane; output captured via `pipe-pane` to a per-session log; `runner.command` switches pilot↔claude with no code change; daemon survives terminal close.
- **Where**: `src/cli/commands/daemon.ts`, `src/daemon/index.ts`, `src/session/tmux.ts`, `src/runner/builder.ts`.
- **Manual test**: (1) `daemon start` → health ready, journal `daemon.started`/`daemon.ready`; (2) start a session, confirm the output log file grows with pane output; (3) set `runner.command: claude` and `aisup start --dry-run` → printed command reflects `claude`; (4) close the launching terminal, confirm daemon + tmux persist.
- **Pass**: all four. **Cost**: lean.

### B. Smart Account Selection (registry, scoring, best pick)
- **Expected**: `aisup accounts` shows each account's 5h/7d usage, score, health; `aisup start` picks the highest-headroom healthy account.
- **Where**: `src/accounts/{scorer,registry,refresh,circuit-breaker}.ts`.
- **Manual test**: `aisup accounts` (confirm live %); then `aisup start --dry-run` and confirm the selected account = best score (this session: primary 5h 100% → account2 chosen). Force a tie-break by lowering one account's headroom (low threshold or real usage).
- **Pass**: selection matches scoring; unhealthy/cooldown excluded. **Cost**: lean.

### C. Proactive Rate-Limit Failover (soft/hard)
- **Expected**: at soft% (idle switch) / hard% (interrupt+switch) the daemon snapshots, scores, stops gracefully, migrates transcript, relaunches `--resume` under the target account, injects continuation, notifies Slack + journal.
- **Where**: `src/daemon/loops/rate-limit-monitor.ts`, `src/failover/{switcher,migrator}.ts`.
- **Manual test (trigger)**: live session; set `soft_pct` below current 5h usage → observe auto-switch at idle. **Manual test (mechanism)**: `aisup failover --to <acct>` → verify migration + resume + continuation + `account.switch` journal + Slack post.
- **Pass**: session continues on the new account with prior context intact. **Cost**: moderate (trigger), lean (manual).

### D₁/D₂. Reactive Recovery (the "Claude error handling" focus)
- **Expected**: each failure routes correctly — 429 → failover; auth-failure → switch; network → same-account restart after threshold; process crash/dead pane → restart-or-switch; both-exhausted → sleep-until-reset + Slack ETA; circuit breaker after N consecutive failures → stop + Slack.
- **Where**: `src/recovery/{patterns,exhausted}.ts`, `src/daemon/loops/{recovery-handler,health-checker}.ts`.
- **Manual test (mostly lean, injection-based)**:
  1. Write a 429/rate-limit string to the captured output log → failover fires.
  2. Write each auth-failure pattern (e.g. `Invalid API key`, `Please run /login`) → account switch.
  3. Write a network pattern (e.g. `ECONNRESET`) repeatedly → same-account restart after threshold.
  4. `kill -9` the in-pane runner process → recovery restarts/switches.
  5. Set all accounts' thresholds to 0 (or mark exhausted) → EXHAUSTED → sleep-until-reset + Slack notify with ETA.
  6. Force N consecutive failures → circuit breaker trips, stops retrying, Slack alert.
- **Pass**: every row produces the defined transition + journal event + (where defined) Slack message. **Cost**: lean (mostly), moderate for a real end-to-end recovery.

### E. Slack Remote Control (full capability sweep)
- **Expected**: every Slack capability works both directions. Inbound commands: `!status`, `!cmd <text>`, `!interrupt`, `!stop`→`!confirm`, `!relay on|off`, `!permit`/`!deny` (permissions), `!gate`/`!gate status`, `!worker status`, `!worker approve <id>`→`!confirm`, `!worker deny <id>`→`!confirm`. Outbound: per-session private channel created + user invited + session info posted; output relay; switch/failure/approval notifications.
- **Where**: `src/slack/*`, `src/daemon/index.ts` wiring.
- **Prereq (human)**: Slack app **Event Subscriptions → message.groups** must be enabled, else inbound commands won't arrive.
- **Manual test**: start a real session → confirm private channel + invite + info post; from Slack run each inbound command and confirm effect in-session + reply; trigger a failover and confirm the switch notification arrives.
- **Pass**: every documented command works; every defined outbound message arrives. **Cost**: moderate.

### I. Event Journal + Status CLI
- **Expected**: `status`, `log`, `accounts` show correct live data; journal records every event type from the PRD schema.
- **Manual test**: run each CLI; cross-check journal lines against actions taken in other tests.
- **Pass**: data correct; event coverage present. **Cost**: lean.

### J. Workflow Skill Propagation
- **Expected**: active skill (/spec, /prd, /fix, /review, /security-review) detected from pane output; on failover the continuation references the **latest** active skill + plan path.
- **Where**: `src/skills/{detector,tracker,continuation}.ts`.
- **Manual test**: start a `/spec` session, confirm `aisup status` shows the skill; failover; confirm continuation prompt names `/spec` + the plan file.
- **Pass**: correct skill carried across the switch. **Cost**: moderate.

## Phase 2 features

### F. Permission Fallback Broker
- **Expected**: permission prompt detected → posted to Slack → `!permit`/`!deny` resolves it → session unblocks; policy allowlist auto-approves, denylist auto-denies; all requests logged.
- **Where**: `src/permissions/{detector,broker,policy}.ts`.
- **Manual test**: drive the session into a permission prompt → confirm Slack post → `!permit` → session proceeds; configure an allowlist entry → confirm auto-approve; a denylist entry → confirm auto-deny.
- **Pass**: observability + grant + policy all work. **Cost**: moderate.

### H₁. Validation Gate Engine — supervisor
- **Expected**: configured gates (test/lint/typecheck) run after task completion; failures reported; `aisup gate` / `!gate` show latest run.
- **Manual test**: configure a passing and a failing gate; run; confirm pass/fail surfaced via CLI + Slack.
- **Pass**: gate results correct. **Cost**: lean.

### K. Cost / Token Tracking
- **Expected**: `aisup cost` shows rolling `today`/`last_7d`/`last_30d` token + cost; aggregated from statusline tap.
- **Where**: `src/cost/aggregator.ts`, `src/cli/commands/cost.ts`.
- **Manual test**: `aisup cost`; cross-check against statusline `cost.total_cost_usd` and account totals.
- **Pass**: numbers reconcile. **Cost**: lean.

## Phase 3 features

### G. Multi-LLM Worker Orchestration (REAL codex run)
- **Expected**: dispatch → detached worktree → diff capture → boundary audit → sanitize → validation gate → cross-model review → AWAITING_APPROVAL → approve → working-tree merge (no commit). PRD AC1–AC7.
- **Where**: `src/workers/*`.
- **Manual test**: real `aisup worker dispatch --task-type implement --prompt "<bounded task>" --workspace <scratch repo>`; walk `list`/`status`/`review`/`logs`; `approve`→`!confirm`; confirm patch applied to the scratch repo working tree, no auto-commit. Also: seed a bug that passes gates but should fail review (AC3); attempt a write outside the worktree (AC4); a failing gate blocks merge (AC5).
- **Pass**: AC1–AC7 with real codex. **Cost**: moderate (codex quota). **Note**: validates the *current* same-model codex config; Part B changes routing.

### H₂. Validation Gate Engine — workers
- **Expected**: gates run in the worktree (cwd=worktree, isolated HOME); a failing required gate → REJECTED, merge blocked; fail-closed with no required gate.
- **Manual test**: dispatch with a gate that fails → confirm REJECTED + merge blocked.
- **Pass**: as defined. **Cost**: lean–moderate.

## Special-Attention Deep Dives (user-flagged)

### S1. Account-switching reliability under varied thresholds
Run C + D across threshold settings: default (85/95), low (5/10), and zero (force exhausted). Confirm correct trigger point each time, no double-switch, no lost session, slot/state consistency. **Cost**: lean→moderate.

### S2. Context-handoff optimality (detail + token cost)
- **Detail**: after a switch, ask the resumed session something only answerable from pre-switch context → confirm continuity.
- **Token cost**: measure tokens consumed by the switch itself (compare statusline cost before/after the resume turn). Confirm the handoff uses `--resume` (transcript) + the small continuation prompt and does **not** trigger a re-summarization pass. Record the actual token delta as the baseline; flag if it exceeds a small budget.
- **Pass**: continuity intact AND switch token cost ≈ continuation-prompt size (not a full re-summarize). **Cost**: moderate.

### S3. Claude error-handling completeness
The full D₁/D₂ matrix above, executed exhaustively (every auth + network regex, 429, crash, exhausted, circuit breaker), since the user emphasized "continue the session no matter what happens." **Cost**: lean (injection) + one moderate end-to-end.

### S4. Slack capability completeness
The full E sweep above — every action issuable from Slack works, every message that should reach Slack does. **Cost**: moderate.

---

# Part B — New Feature: Unified, Usage-Aware Multi-Provider Failover

## Goal (from user)

Each role can be **any provider / any model / any config**, with reliable per-role usage tracking
and failover that **prefers switching Claude accounts before switching LLMs**.

**Scope decision (2026-06-17):** Part B is **worker-only** multi-provider failover (implementer +
reviewer). The **orchestrator stays Claude and only switches Claude accounts** (already built;
validated in Part A — features C/D). Cross-LLM orchestrator handoff is out of scope.

| Role | Default | Failover priority |
|------|---------|-------------------|
| Orchestrator (lead session) | claude opus 4.8[1m], xhigh effort (current config) | **Claude accounts only** (existing; no cross-LLM) |
| Implementer (worker) | claude opus 4.8[1m], xhigh | Claude accounts first → then other LLMs |
| Reviewer (worker) | codex (gpt-5.5, xhigh) | stay codex; if codex budget exhausted → an open Claude account |

## Current state vs. required

- Orchestrator **already** fails over across Claude accounts; it has **no** cross-LLM path, and the lead runner is Claude/pilot-only.
- Implementer/reviewer are static CLI adapters with **no usage tracking and no failover**.
- Usage is readable **only** for Claude accounts (statusline tap). Codex/gemini/ollama expose no comparable usage signal that aisup reads today.

## Per-provider usage — standardized **usage ledger** (2026-06-17)

**Research finding:** there is **no universal "remaining quota" API** across providers in the auth
modes we use, so we cannot read live headroom uniformly:

| Provider | Live "remaining %" available? | What we CAN get | Reset semantics |
|----------|-------------------------------|-----------------|-----------------|
| Claude (subscription) | Only via statusline tap **while active** | 5h/7d `used_percentage` + `resets_at` | known reset timestamps |
| Codex (ChatGPT-subscription auth) | **No** (`codex doctor` = auth only; OpenAI `x-ratelimit-remaining-*` headers are **API-key only**, not ChatGPT) | per-run consumption (`codex exec --json`) | not exposed → budget/period |
| Gemini | **No** per-request readout (tier limits in AI Studio / GCP quota API) | per-response `usageMetadata` (tokens) | not exposed → budget/period |
| Ollama | n/a (local) | n/a | unlimited |

The only signals reliable everywhere: **(a) exact usage while a session is active, (b) deterministic
rolling-window resets, (c) reactive 429/quota errors.** The ledger turns these into a best-estimate
of every account's headroom even when idle (user's design, adopted):

**Usage ledger — persistent, `~/.aisup/usage-ledger.json`:**
- Per account/provider: `{ windows: {'5h':{used_pct,reset_at,captured_at}, '7d':{...}} OR budget:{tokens_used,cap,period_reset_at}, last_seen_active, source }`.
- **Capture**: while a session is active on an account, and **before switching away**, record live usage + reset times (Claude tap) or metered consumption (codex/gemini).
- **Decay (the key idea)**: once `now >= reset_at`, set that window to **0%** — a rolling window provably resets and an idle account accrues nothing. Between capture and reset, hold the last captured value (idle = no change).
- **Refresh**: on re-entry to an account, overwrite with fresh live data.
- **Backstop**: any 429/quota/auth error marks the account UNAVAILABLE immediately, regardless of ledger (covers usage we couldn't observe).

**Selection** consumes the ledger's best-estimate; entries are tagged `live | aged | unknown` so the UI
never prints yesterday's number as if it were live (the Part A B-bug). This ledger **fixes the Part A
freshness bug** and is the **per-provider foundation for Part B**.

**Accepted caveat**: usage of an idle account *outside aisup* between capture and reset is invisible
to the ledger — the reactive 429 backstop covers it. Documented, not silently ignored.

**First implementation steps**: (1) ledger store + decay; (2) capture-on-switch + capture-while-active
hooks; (3) rewrite `accounts` display + scorer to consume the ledger with `live/aged/unknown` tags;
(4) verify `codex exec --json` emits per-run usage for the codex budget meter.

## Other open questions

- **B2 — Cross-LLM orchestrator handoff**: switching the *lead session* from Claude to a non-Claude model mid-task is a major undertaking (different runner, cross-model context translation, Pilot-Shell skills are Claude-specific). Account-first priority means cross-LLM is the rare fallback. Scope options: (a) account-switch only for the orchestrator now, cross-LLM later; (b) full cross-LLM orchestrator now.
- **B3 — Role/model config schema**: define `roles.{orchestrator,implementer,reviewer}` as ordered candidate lists of `{provider, account|config, model, effort, ...}` with the account-first-then-LLM ordering encoded. Implementer/reviewer become first-class "model providers," not just worker CLI adapters.
- **B4 — Worker cross-LLM handoff**: re-dispatching a bounded worker task to a different provider on failure is far easier than orchestrator handoff (the task prompt is the contract). Confirm re-dispatch semantics (fresh worktree vs. carry partial work).
- **B5 — Claude-as-worker adapter**: implementer=Claude means a Claude worker adapter (claude CLI in `exec`/print mode) with account selection reusing the existing scorer. Define its non-interactive invocation + auth (per-account `CLAUDE_CONFIG_DIR`).

## Suggested Part B sequencing (after questions resolved)

1. Role/model config schema + per-role candidate lists (B3).
2. Provider abstraction with a `usageSignal()` per provider (Claude=tap %, others=reactive/budget per B1).
3. Claude worker adapter reusing account scorer (B5); make implementer default Claude.
4. Worker-level failover (account-first → cross-LLM) with re-dispatch (B4).
5. Orchestrator cross-LLM fallback (B2) — scope TBD.
6. Validate all of the above with the same real-test discipline as Part A.

---

## Decisions locked (2026-06-17)

- **Sequencing**: validate Part A first, then build + validate Part B. (was Q-B3)
- **Orchestrator scope**: Claude-account switching only; no cross-LLM orchestrator. Multi-provider failover is worker-only. (was Q-B2)
- **Per-provider usage**: real usage reader per provider (Claude = remote %, codex = local consumption meter vs configured budget) + configurable per-provider limit + reactive on-error backstop. Gemini/ollama deferred (not installed); provider abstraction makes them config-only later. (was Q-B1)

## Open Questions — still needed before/at execution

- **Q-A1**: Test config — separate `~/.aisup/config.testing.yaml` vs temporary edits to the live config? (recommend a separate file)
- **Q-A2**: Worker live validation (G) — which scratch repo + which bounded task, and confirm it's OK to spend codex quota for it?
- **Q-A3**: Slack **Event Subscriptions → message.groups** confirmed added in the app? (blocks inbound `!command` tests in E/F)

## Validation Results (filled during execution)

| ID | Item | Result | Evidence | Notes |
|----|------|--------|----------|-------|
| A | Daemon start/stop + health + journal | PASS | `daemon start`→PID; `/api/health` `ready:true`; journal `daemon.started/rehydrated/ready`; `daemon stop` clean, port freed | Detached-survival is an env artifact in this assistant shell; works in a real terminal. |
| A | Build emits daemon entry | FIXED | tsup only built cli/index → daemon couldn't start; added `daemon/index` entry; `dist/daemon/index.js` now emitted (commit 1d46673) | Pre-existing build gap. |
| Infra | API token bootstrap | FIXED | `~/.aisup/api-token` missing (only `aisup init` creates it, which overwrites config) → all authed CLI/daemon calls 401/"not responding"; generated token (32-byte hex, 0600) | Candidate: daemon should self-generate if missing. |
| B | Smart Account Selection — usage freshness | FAIL → FIXED | `aisup accounts` showed stale `5h 100%` (27h-old tap, reset 23h past) as current; selection ran on stale artifacts | Root cause: tap only fresh while a session renders; no on-demand usage API (claude/pilot/codex/gemini confirmed). |
| B | Fix: usage ledger (decay + basis) | PASS | After ledger: primary `5h 0% (reset)`, account2 `5h 38% (live)`; dry-run now selects primary (score 100 > 67) on real headroom; ledger persisted 0600 with reset trail; 578 tests pass | Fixes the bug + is the Part B per-provider foundation. |
| I | status / log | PASS | `status` running/clean; `log` shows events | — |
| I/K | `aisup cost` | PASS (note) | shows $0 today/7d/30d | Reads journal (aisup-supervised sessions); $0 is correct since no token-spending session has run *under aisup* yet — re-verify after a real session. |
| Q-A1 | Test config override | GAP | `loadConfig()` always uses `~/.aisup/config.yaml`; no `--config`/`AISUP_CONFIG` | Use backup→edit→restore for low-threshold tests; candidate enhancement: honor `AISUP_CONFIG`. |
| A | Runner abstraction (pilot↔arbitrary) | PASS | set `runner.command: cat`; `doctor` → "/bin/cat", dry-run → `exec '/bin/cat'`; restored to pilot after | Confirms config-driven runner, no code change (used as the no-token test harness). |
| D₁ | Reactive recovery — 429 | PASS | injected `429 Too Many Requests` into a real session's output.log → `failure.detected{has429:true}` → `account.switch{reason:429, primary→account2}` → session continued on account2 | Real daemon loops, fake runner, zero tokens. |
| D₂ | Reactive recovery — auth failure | PASS | injected `Invalid API key · Please run /login` → `failure.auth_detected` → `account.switch{reason:auth_failure, account2→primary}` | Auth escalates straight to switch (as designed). |
| D₁ | Reactive recovery — process crash | PASS | `kill -9` the pane process → `failure.detected{has429:false, source:recovery_handler}` → `recovery.restart_fresh_no_session_id{account:primary}` (same-account restart) | Flow 3 crash→restart-on-healthy-account. |
| D₂ | Reactive recovery — network restart-after-threshold | PASS | injected `ECONNRESET` ×3 across ticks → `failure.network_detected{count:1→2→3,threshold:3}` → `recovery.restart_fresh_no_session_id{account:primary}` (same-account restart, no switch) | Transient blips escalate only at threshold, as designed. |
| D₂ | Reactive recovery — all-exhausted / no-target | PASS | account2 disabled + 429 on primary → `failover.no_target_available{terminal:true}` → `session.exhausted` → `recovery.exhausted_polling_started{poll_interval_s:60}` (sleep-and-poll to auto-resume) | EXHAUSTED state + 60s poll confirmed. `earliest_cooldown_eta:null` because the injected 429 carried no structured reset (fake runner). |
| S3 | Circuit-breaker trip → COOLDOWN | UNIT-VERIFIED | no-target records a breaker failure (observed); a full 3-failure trip can't be cleanly forced once a session goes EXHAUSTED (detection halts). Covered by 11 circuit-breaker unit tests. | Live-forcing the trip would need repeated independent failover failures; documented gap. |
| Daemon | Rehydration across restart | PASS (incidental) | a live session survived a daemon restart and was reattached (rehydration), then continued recovery | Bonus confirmation during the recovery tests. |
| E | Slack channel creation on session start | PASS | real session → `slack.channel_created{C0BBG9F0FG9}`; user + bot joined; bot's own join correctly ignored | Outbound channel mgmt works. |
| E | Slack session-info post on start | GAP | `onSessionStart` creates channel + invites but posts **no** session-info message (only joins in channel) | PRD Flow 1 says "posts session info" — minor deviation; stop/exhausted/permission posts ARE wired. |
| F1 | Runner `pilot` (default) cannot start a session | FAIL → FIXED | default runner changed `pilot`→`claude` (`src/config/defaults.ts`); re-ran real session → Claude Code launches and **stays alive** (`pane dead=0`, cmd Claude Code 2.1.181), no crash loop; loader tests + README updated | Modern pilot is hook-integrated; `claude` is the runner. High-impact fix — the shipped default was non-functional. |
| F2 | Crash loop on a launch-then-exit runner | FAIL → FIXED (TDD) | `loop-manager` now counts every crash pass (not just failed restarts), clears only on genuine recovery (pane alive), and at the cap records a circuit-breaker failure + escalates to a switch; new flapping test + corrected recovery test, 34/34 loop-manager tests pass | Bounded loop + breaker trip + (via no-target) Slack alert; runner that exits immediately can no longer loop forever. |
| A | Real session launches + stays alive (claude runner) | PASS | post-F1: `aisup start` → Claude Code session ACTIVE, pane alive 30s+, Slack channel created, zero crash events | Confirms the end-to-end session path works. |
| S2 | Context-handoff continuity + token cost | BLOCKED | needs a working session — blocked on F1 (set `runner: claude`) | Retry after F1 fix. |
