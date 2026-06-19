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
| C/S2 | Failover continuity (real session) | PASS | real Claude session on primary established codeword PURPLE-OTTER-71 → `aisup failover --to account2` → `migration.completed{copied}` + `claude --resume` → resumed session on account2 **recalled the codeword** | Definitive context carry-over across an account switch. |
| S2 | Context-handoff token cost | PASS (optimal) | context 47382 tokens **before** switch → 47382 **after** resume (identical) → +19 for the recall turn; `--resume` loads the transcript with **no re-summarization** pass | Handoff is token-lean exactly as designed; switch itself adds ~0 context tokens. |
| K | `aisup cost` after a real session | PASS | post-session `aisup cost` → today $83.51 with per-account breakdown (account2 $83.08, primary $0.43) | Was $0 with no supervised spend; now reflects real per-account cost. |
| E/F | Slack inbound commands + relay | PASS | operator sent in the session channel: `!status`→session output; `!worker status`→"No workers."; `!cmd say the word PINEAPPLE`→"Reply !confirm"→`!confirm`→"Sent"→pane showed `⏺ PINEAPPLE`; typo `!come`→"Unknown command… /help" | Read-only cmds, worker surface, bidirectional relay + confirmation gate, unknown-cmd handling — all work. |
| G | Real codex worker — full pipeline (AC1/5/6/7) | PASS | `worker dispatch` (real codex) → worktree → `hello.txt` created → gate passed → codex review APPROVE → AWAITING_APPROVAL (patch ABSENT pre-approval, AC6) → `approve` → applied as working-tree change `HELLO_FROM_WORKER`, no auto-commit (HEAD unchanged), status MERGED (AC7) | Real ChatGPT-auth codex via isolated HOME (CODEX_HOME). Review is same-model (degraded) — true cross-model AC3 needs a 2nd model (Part B). |
| H₂ | Worker validation gate (live) | PASS | gate `npm run typecheck` ran in the worktree and passed → merge allowed | Fail-closed path covered by smoke tests. |
| Worker | Worktree cleanup after merge | MINOR | `.aisup-workers/` dir lingered after a merged worker (keep_merged:false removes the worktree, parent dir remained) | Low-priority tidy-up. |
| C | **Automatic soft-threshold failover (the trigger gap)** | PASS | 2026-06-18 lean run: session on account2 at live **5h 79%**, `soft_pct=75` → daemon `rate_limit.threshold_crossed{level:soft,five_hour_pct:79,soft_pct:75}` (17:32:48) → `account.switch{reason:soft_threshold, account2→primary, selection_mode:**automatic**}` (17:33:18, after idle) → `migration.completed{copied}` → `launch_mode:resumed` | Closes the C *trigger* gap: prior runs only exercised the **manual** `aisup failover` path. This is the daemon's own rate-limit-monitor firing on real usage, no injection. account3 added to config as 3rd account; primary (score 87) was the soft target (account3 had no telemetry → not soft-eligible, as designed). |
| S1 | Threshold variation (soft=75) | PASS | automatic trigger fired at the configured `soft_pct=75` against real `five_hour=79%`; single clean switch, no double-switch, session state consistent (ACTIVE→SWITCHING→ACTIVE on primary) | One non-default threshold validated live; default 85 covered by the climb run (below). |
| S2 | Continuity across **automatic** soft failover | PASS | codeword `MAGENTA-WALRUS-88` set on account2 → after automatic soft switch, resumed session **on primary recalled `MAGENTA-WALRUS-88`**; context **45837→46535 tokens** (+ recall turns only, no re-summarization) | Confirms S2 on the automatic path (handoff S2 was the manual path). Token-lean handoff holds for auto failover too. |
| C | **Realistic climb → natural soft trigger** | PASS | 2026-06-18 climb run: real generation turns on account2 raised live **5h 77%→85% organically**; daemon logged `rate_limit.threshold_crossed{level:soft,five_hour_pct:84→85,soft_pct:83}` during active use → marked `SWITCH_PENDING_AT_IDLE` → at idle `account.switch{reason:soft_threshold, account2→primary, selection_mode:automatic}` (17:48:44) → `launch_mode:resumed` → codeword `MAGENTA-WALRUS-88` recalled again | The journal hit `five_hour_pct:85` (the real shipped default) via organic growth; soft_pct was set to 83 only because the integer 5h readout is coarse/sticky and reaching exactly 85 by generation was disproportionately slow/costly. Distinct from the lean run: usage *rose to meet* the threshold during real work (the IDLE-switch flow), not the threshold lowered under static usage. account2 5h spent ~77→85% (user-authorized max-out). |
| Infra | cwd identity matching (/tmp symlink) | MINOR | `aisup start --cwd /tmp/aisup-live-test` → Claude renders tap `cwd=/private/tmp/...` (realpath); identity check silently rejected the tap (scan path emits no `telemetry.session_mismatch`), blocking csid bind + rate-limit reads. Fixed by using the canonical `/private/tmp` path. | Candidate hardening: realpath-canonicalize `session.cwd` (and/or compare via realpath) so symlinked cwds match telemetry. Edge case; real project dirs under /Users are unaffected. |
| H₁ | Supervisor validation gate (`aisup gate` / `gate run`) | PASS (CLI) | config `gates.enabled` with `pass-check`(sh exit 0, required) + `fail-check`(sh exit 1, optional); `aisup gate run` → `PASSED pass-check` / `FAILED fail-check (optional)` / aggregate `Gates: PASSED`; journal `gate.started`/`gate.passed{exit_code:0,required:true,stdout_tail:"gate-ok"}`/`gate.failed{exit_code:1,required:false,stdout_tail:"gate-bad"}`/`gate.run_completed{passed:true,total:2,failed:["fail-check"]}`; `aisup gate` shows latest; `--json` matches | Engine runs configured gates, captures exit code + stdout tail, journals, respects `required` (optional fail ≠ aggregate fail). `!gate` from Slack still needs the operator. Required-fail→aggregate-FAIL is the same code path (proven by required-awareness + H₂'s fail-closed merge-block). |
| **J** | **Workflow skill propagation across failover** | **FAIL (non-functional end-to-end)** | Live: `/prd` invoked in a real session → skill launched (PRD brainstorm text in pane) but **0 `skill.detected` events**, `active_skill` stayed `null`; raw output log has **0 `Launching skill:` markers**. With `resume_prompt_mode: always`, a failover injected **no** `Continue the current session…` continuation prompt. | **Two independent root causes:** (1) `src/skills/detector.ts` matches `Launching skill: <name>`, a marker Claude Code 2.1.181 / Pilot 9.1.3 no longer emits → detection never fires. (2) `buildContinuationPrompt` has **zero callers** and `resume_prompt_mode` is read nowhere in `daemon/`/`failover/`/`session/` → the relaunch only does `claude --resume`, never injects the skill/plan-naming prompt regardless of mode. Unit tests pass on synthetic `Launching skill: spec-plan` input, masking both. Context still carries via `--resume` (transcript), but the *skill/plan continuation* feature is dead. Needs a `/fix` (update the detector marker to current Claude Code output; wire `buildContinuationPrompt`+`resume_prompt_mode` into `createSessionForTarget`). |
| **F** | **Permission fallback broker (live detection)** | **FAIL (detection broken vs Claude Code 2.1.181)** | Config: `permissions.enabled, slack_routing, default_action:deny, approval_key:"1", denial_key:"3"`. Real session (normal mode) → Write tool → genuine prompt rendered: `Do you want to create permtest.txt?` / `1. Yes / 2. Yes-all / 3. No` (confirms 1/3 keys). But **`permission.detected=0`, `routed_to_slack=0`** — the broker never engaged, so `!permit`/`!deny` had nothing to resolve. Read-only `ls` was auto-approved (Pilot PreToolUse hooks) with no prompt at all. | **Two compounding root causes (same detector-drift family as J):** (1) `DEFAULT_PERMISSION_PATTERNS` match `do you want to (proceed\|continue\|make this edit\|run this)` — the current verb **`create`** (and others) isn't covered. (2) Claude Code 2.1.181 renders the prompt **modal** with interleaved cursor-positioning escapes (e.g. `want\x1b[14Gto`); after `stripAnsi` the phrase collapses to `wantto`, so even a broader line pattern matches only on the rare clean redraw frame — detection from the pipe-pane stream is unreliable by construction. The broker/policy/Slack-routing/keystroke chain is correct **by code review** but **could not be exercised live** because nothing reaches it. Fix needs: refresh patterns to current verbs AND make detection robust to cursor-fragmentation (e.g. scan rendered screen state, not the raw pipe delta). Bigger than J's fix. |
| **Theme** | Output-scanning detectors drifted from current Claude Code | FINDING | Three independent instances this session: J skill marker (`Launching skill:` gone), F permission verbs (`create` unmatched), F TUI cursor-fragmentation of prompt text. | aisup's pane-output detectors (`skills/detector`, `permissions/detector`, and by extension any regex over `output.log`) were written against an older Claude Code/Pilot and silently no-op against 2.1.181. Unit tests use synthetic strings, so CI is green. Recommend a host-gated test that drives a *real* current Claude session and asserts each detector fires (the `AISUP_TEST_PERMISSIONS` hook referenced in `detector.ts` is the right shape — extend it to skills + run it). |

---

## Hook-Fix Implementation + Validation (2026-06-19) — J and F FIXED

Built the hook-based detection (TDD; 586 unit/integration tests pass, typecheck + build clean) and **live-validated both end-to-end** against Claude Code 2.1.183.

| ID | Item | Result | Evidence |
|----|------|--------|----------|
| **J** | Skill detection via `UserPromptExpansion` hook | **FIXED ✅** | aisup launches with `--settings ~/.aisup/claude-hooks.json`; `/spec` in a live session → `POST /api/hooks/skill{command_name:"spec"}` → `active_skill=/spec` within 2s + journal `skill.detected{source:"hook"}`. Structured, zero-token, no scraping. `resolveSkillFromCommandName` + `buildHookSettings` unit-tested. |
| **J** | Continuation injection on failover | **FIXED ✅** | `buildContinuationPrompt` + `resume_prompt_mode` wired into `createSessionForTarget`; gated to `launchMode==='resumed'`. Live: manual failover of a `--plan` session → `continuation.injected{plan_path}` → resumed pane shows *"Continue the current session… Plan file: …/PLAN.md…"* and the resumed Claude **read the plan to resume**. |
| **Bug** | Divergent manual-failover launcher | **FIXED ✅** | `/api/failover` had its own inline `createSessionForTarget` (no continuation); now reuses the daemon's canonical launcher via a ref, so manual == automatic failover. |
| **F** | Permission broker via `PermissionRequest` hook | **FIXED ✅** | Live: Write in default mode → `PermissionRequest` hook → `POST /api/hooks/permission` → `permission.detected` + `permission.routed_to_slack` → Slack post; user `!permit` → keystroke to the persistent dialog → file `PERMIT_DEMO.txt=GRANTED-FROM-SLACK` created + `permission.granted{source:"hook"}`. Structured detection, no prompt-scraping. |
| **F** | **No timeout** (user requirement) | **FIXED ✅** | Re-architected to **non-blocking**: the hook posts to Slack and defers to Claude's terminal dialog (which never times out); `!permit`/`!deny` resolves it later via a keystroke. **Proven by a ~12-minute gap** (routed 16:14:40 → granted 16:26:53) that still succeeded. The earlier blocking design auto-denied at the `grant_ttl` / hit Claude's hook-timeout cap — removed. |

**Install mechanism:** `claude --settings ~/.aisup/claude-hooks.json` (0600, literal bearer token) appended to `config.runner.args` once at daemon startup — additive, no edits to account/repo settings. Skill hook always installed; permission hook installed when `permissions.enabled`.

**Files:** `src/hooks/claude-hooks.ts` (NEW), `src/skills/detector.ts` (`resolveSkillFromCommandName`), `src/daemon/server.ts` (`/api/hooks/skill`, `/api/hooks/permission`, `createSessionForTarget` option), `src/daemon/index.ts` (hook install, `onSkillHook`, `onPermissionHook` non-blocking, keystroke resolver, continuation wiring), `src/journal/types.ts` (`continuation.injected`), `tests/hooks/claude-hooks.test.ts` (NEW, 7).

---

## Fix Plan (decided 2026-06-18) — replace output-scraping with Claude Code hooks

**Decision (user):** fix J and F by moving their detection to **Claude Code hooks** (structured, deterministic, ~0 tokens, robust to wording changes) rather than refreshing regexes over scraped terminal output. One mechanism for both (no split responsibilities). **Requirement:** enumerate and wire **every** hook event that can surface a permission or a skill so none is silently dropped.

**Error/recovery detection is explicitly NOT moved to hooks** — hooks don't fire on crashes/429/auth/network. The existing flat-text scanning already detects those (validated live this session) and stays unchanged. Rendered-screen-snapshot (capture-pane) detection is held in reserve, used only if live testing finds a signal that is both garbled *and* not hook-reachable.

**Workstream:**
1. Enumerate all current Claude Code hook events relevant to permissions and skills (from current docs, not memory).
2. **F** — route permission decisions through the `PreToolUse` (+ any notification) hook → aisup daemon → Slack `!permit`/`!deny` → allow/deny. Deletes the brittle prompt-scrape + keystroke layer.
3. **J** — derive the active skill structurally from a hook event; wire the dead `buildContinuationPrompt` + `resume_prompt_mode` into `createSessionForTarget`.
4. Live re-validate F + J end-to-end (TDD throughout).
5. Restore `~/.aisup/config.yaml` to a clean baseline after the fixes.

### Confirmed implementation spec (LIVE-VERIFIED on Claude Code 2.1.181, 2026-06-18)

All events below were fired in a real supervised session and their payloads captured (probe hooks in the test project's `.claude/settings.json`). No assumptions.

- **Install mechanism (non-invasive):** launch with `claude --settings ~/.aisup/claude-hooks.json` — `--settings` loads *additional* settings, no edits to the user's account or repo configs. aisup writes that file and exports `AISUP_API_TOKEN` into the session env (runner `buildEnv`/`buildArgs` in `src/runner/builder.ts`). Hooks are `type:"http"` → `http://127.0.0.1:<port>/api/hooks/*` with header `Authorization: Bearer ${AISUP_API_TOKEN}`, `allowedEnvVars:["AISUP_API_TOKEN"]`.
- **J — skill: `UserPromptExpansion`** (matcher `*`). Real payload: `{hook_event_name, expansion_type:"slash_command", command_name:"prd", command_args, prompt:"/prd", session_id, cwd, transcript_path}`. → `POST /api/hooks/skill` maps `command_name`→tracked skill (`prd`→`/prd`), `sessionManager.patchState(active_skill)`, journal `skill.detected`. Fire-and-forget (exit 0).
- **F — permission: `PermissionRequest`** (matcher `*` or tool name). Real payload: `{hook_event_name, tool_name:"Write", tool_input:{file_path,content}, permission_mode, permission_suggestions, session_id, cwd}`. Per the hooks reference this hook **blocks and can deny (exit 2 / JSON `permissionDecision`)** → `POST /api/hooks/permission` registers the pending request, routes to Slack (reuse `PermissionBroker.routeToSlack`), and **long-polls until `!permit`/`!deny`** (existing `onPermissionGrant/Deny`→`resolveFromSlack`) or the hook timeout, then returns the allow/deny decision JSON. The HTTP hook holds the tool the whole time — no dialog, no keystrokes.
- **Coverage (no silent drops):** primary human-decision gate = `PermissionRequest`; `Elicitation` covers MCP input asks; `PreToolUse`/`Notification(permission_prompt)` are supersets available if a gap is found. Skill gate = `UserPromptExpansion`; `UserPromptSubmit` is a backstop.
- **Continuation wiring (J, second half):** in `createSessionForTarget` (`src/daemon/index.ts`), when `config.session.resume_prompt_mode !== 'never'`, build `buildContinuationPrompt({activeSkill: snapshot.activeSkill, planPath: snapshot.planFilePath})` and inject it into the new pane after launch (tmux send-text). `'always'` = every switch; `'on-failure'` = non-manual switches.
- **Error/recovery detection stays on the existing flat-text scanner** (validated live: 429/auth/network/crash) — hooks can't catch crashes; not moved.

## New bug found during hook-fix validation (2026-06-18)

- **Reactive rate-limit detector false-positives on innocent text.** `src/daemon/loops/recovery-handler.ts` `RATE_LIMIT_PATTERNS` includes `/rate limit/i`, which matches the substring **"rate limiting"**. During J validation, the `/spec` autocomplete showed the example *"/spec add rate limiting to the login endpoint"*; the scanner read it from `output.log` and triggered a **spurious 429 account switch** (account3→account2). Impact: any session output that merely mentions "rate limit" (code, docs, autocomplete, this very plan) can cause a false failover. **Fix:** tighten to real error signatures (`/rate.?limit(ing)? (error|exceeded)/i`, `/429 too many requests/i`, `/rate_limit_error/i`) instead of the bare phrase. Small, separate from J/F but same "scraping pane text is brittle" theme. (J's skill detection is unaffected — it now uses the structured hook, not text scraping.)

## Deferred Features (captured 2026-06-18, not yet scheduled)

- **Auto-documentation + plan breadcrumbs.** Continuously record implementation progress so `/handoff` becomes cheap collation instead of end-of-session reconstruction (today a `/handoff` at ~80% usage can spend the remaining ~20% rebuilding context). Design: **(a)** free/deterministic "facts" breadcrumbs via the same hook + the existing journal (files changed, commands, task transitions, failovers, gate results); **(b)** cheap in-the-moment one-line decision/bug/RCA notes written by Claude as they happen (a behavioral rule), since facts alone cannot capture reasoning; **(c)** handoff collates both. **Why deferred:** separate from the J/F hook fix; main hook work comes first. **Token note:** keep deterministic facts free; reserve inference for a single milestone/handoff summary — never per-message.
- **Context-transfer status (for reference):** account→account failover is already optimal — transcript copy + `claude --resume`, **no re-summarization** (measured live: 45837→45837 tokens across a switch). The expensive `/handoff` is a *separate* human-driven prose-generation path, which the breadcrumbs feature above targets. LLM→LLM orchestrator transfer remains Part B (deferred).
