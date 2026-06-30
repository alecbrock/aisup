# aisup — FULL MANUAL SYSTEM VALIDATION (End-to-End, No Shortcuts)

**Status:** READY TO EXECUTE · **Owner:** fresh session / LLM · **Created:** 2026-06-26
**Type:** Manual full-system validation (NOT an implementation plan)

> This document is a self-contained execution directive. A new session must be able to validate the
> ENTIRE aisup project end-to-end using ONLY this file + the repo. If you find anything missing, add it.

---

## 0. MISSION & RULES OF ENGAGEMENT (read every line)

You are validating that the **real, shipped aisup system actually works**, end to end, against **real**
processes (`claude`, `codex`), a **real** daemon, **real** Slack, and **real** account failover.

**ABSOLUTE RULES — violating any one invalidates the run:**

1. **NO MOCKS.** Every check runs the real binary / real daemon / real subprocess. Unit tests are NOT
   acceptable as a substitute for a live check — they may be cited as *supporting* evidence only, never
   as the primary evidence for a feature marked PASS.
2. **NO SHORTCUTS.** If a check requires a real Slack channel, you create a real Slack channel and read
   it back via the Slack API. If it requires a real account switch, you do a real account switch.
3. **NO DEFERMENTS.** Every row in §6–§8 must end PASS / FAIL / GAP with captured evidence. "Covered by
   prior session" or "covered by tests" is FORBIDDEN as a terminal status. If you genuinely cannot run
   something, mark it **BLOCKED** and write the exact blocking command + output — never silently skip.
4. **NO WORKAROUNDS that change what is tested.** Fixing a *harness* bug is allowed (document it). Quietly
   reducing the assertion to make it pass is not.
5. **BE GENUINE & ADVERSARIAL.** Beyond happy paths, deliberately try to BREAK it: malformed inputs, race
   conditions, prompt injection, secret exfiltration, resource exhaustion, concurrency, clock skew, killed
   processes, full disks. Hunt for exploits, performance leaks, bottlenecks, and UX degradations.
6. **EVIDENCE OR IT DIDN'T HAPPEN.** Every PASS carries the exact command run + the exact journal events /
   API responses / measured numbers. Quote them. No paraphrasing a result you didn't capture.
7. **REAL SPEND IS AUTHORIZED** (operator-approved: real `claude`/`codex` spend on `/private/tmp` scratch
   repos, real Slack posts) — but you MUST keep all state isolated (see §3) and never touch the operator's
   real `~/.aisup`.

**Definition of "done" for the whole effort:** every feature in §6, every Part B leg, every Part C check,
every adversarial probe in §7, and every CLI command + journal event in §9 has a captured PASS/FAIL/GAP/
BLOCKED with evidence, AND the §8 sign-off matrix is fully filled, AND a written adversarial-findings
report exists. Anything less is NOT done — say so plainly.

---

## 1. CONTEXT: WHAT aisup IS (so you know what you're validating)

aisup is a **supervisor daemon** for Claude Code sessions with **multi-provider worker failover**. Two halves:

- **Lead-session half (the operator's interactive session):** the daemon supervises a real `claude` session
  in tmux, monitors its output via pipe-pane, detects rate-limits / errors / permission prompts / skills,
  fails over between Claude accounts (transcript copy + `claude --resume`), and mirrors everything to a
  per-session **Slack** channel with bidirectional command relay.
- **Worker half (autonomous task execution):** `aisup worker dispatch` runs a task in an isolated **git
  worktree** via a scorer-selected provider (Claude account → another Claude account → **codex**, cross-LLM),
  captures a sanitized patch, runs a **different-model review**, optional validation gates, and gates the
  merge behind operator approval.

**Primary source docs to read before starting (in this order):**
1. `docs/prd/2026-04-29-ai-supervisor.md` — product requirements (the source of truth for intended behavior).
2. `docs/plans/2026-06-17-aisup-full-system-validation.md` — prior validation results (Parts A/B/C) + Special
   Deep Dives S1–S4. **Many rows have real prior evidence — you must RE-RUN, not inherit, each one.**
3. `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md` — Part B (worker failover) design + Truths.
4. `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` — closure tasks + the live worker run.
5. `CLAUDE.md`, `AGENTS.md` — repo engineering rules.
6. Existing harnesses to reuse/extend: `scripts/validation/live-multiprovider-failover.sh` (worker legs),
   `scripts/validation/strengthened-fullsystem.sh` (cross-LLM fidelity / usage / injection),
   `scripts/validation/lead-session-slack.sh` (lead session + Slack channel).

---

## 2. PREREQUISITES & ENVIRONMENT

Run and record each:

```bash
node --version            # confirm runtime
claude --version          # record exact version (detectors drift across versions — see §4)
codex --version
which tmux jq lsof openssl uuidgen
cd <repo> && npm run build && ls -la dist/daemon/index.js dist/cli/index.js   # dist MUST be fresh
npm run typecheck && npx vitest run    # baseline: record pass/skip/fail counts (expect 0 fail)
```

**Accounts (record auth state of each — do NOT assume):**
```bash
for d in ~/.claude ~/.claude-account2 ~/.claude-account3; do
  ( CLAUDE_CONFIG_DIR="$d" claude -p "Reply with exactly: OK" ) ; echo "  ^ $d"
done
ls -la ~/.codex/auth.json            # codex ChatGPT auth
echo "CODEX_HOME=${CODEX_HOME:-~/.codex}"
sed -E 's/=.*/=<redacted>/' ~/.aisup/secrets.env   # confirm AISUP_SLACK_BOT_TOKEN + AISUP_SLACK_APP_TOKEN present
```

You need: ≥2 authed Claude accounts (for account-failover legs), codex authed (for cross-LLM legs), Slack
tokens (for the lead-session/Slack legs). If an account is rate/session-limited, record it and pick another.

---

## 3. STATE ISOLATION & SAFETY INVARIANTS (NON-NEGOTIABLE)

Every run uses an **isolated `AISUP_HOME` under `/private/tmp`**. The operator's real `~/.aisup` is NEVER
read or written. Assert it:

```bash
# BEFORE any run:
OP_CFG_SHA=$(shasum -a256 ~/.aisup/config.yaml | awk '{print $1}')
OP_JRN_FP=$(stat -f '%m:%z' ~/.aisup/journal.jsonl)
# AFTER teardown: re-compute and assert UNCHANGED. If changed → the run is INVALID, stop and investigate.
```

Each isolated config MUST set, under `$AISUP_HOME`: `daemon.port` (non-default, e.g. 7394+N),
`journal.path`, `statusline.directory`, and use **absolute** `config_dir` paths for accounts. Generate an
`api-token` (`openssl rand -hex 32`, 0600) — the daemon + every authed CLI call need it (it is normally
written by `aisup init`, which the harnesses skip). Tear down: `aisup stop --force`, kill the daemon node
PID, free the port, `rm -rf` the temp `AISUP_HOME` + scratch repo. Reuse the teardown/lifecycle helpers in
`scripts/validation/live-multiprovider-failover.sh`.

---

## 4. KNOWN GOTCHAS — READ FIRST OR YOU WILL WASTE HOURS (learned the hard way)

1. **macOS Keychain is keyed by `sha256(absolute CLAUDE_CONFIG_DIR path)[:8]`.** A config-dir-pinned
   subprocess (every worker, every `claude -p --config-dir`, the daemon) reads the **path-hashed** keychain
   slot. A plain interactive `/login` (CLAUDE_CONFIG_DIR unset) refreshes only the **unsuffixed legacy**
   slot — so `/status` looks healthy while workers 401. **Fix: re-login with the dir set:**
   `CLAUDE_CONFIG_DIR=~/.claude claude` then `/login`. Diagnose by decoding `expiresAt` from
   `security find-generic-password -s "Claude Code-credentials-<suffix>" -w` (JSON `claudeAiOauth`).
2. **Claude workers MUST use the real `$HOME`** (Option C) for keychain OAuth — an isolated HOME → "Not
   logged in"; a stripped env → 401. Codex workers use an **isolated** HOME + `CODEX_HOME`. (`claude-adapter.ts`.)
3. **Worker stdout MUST be parsed in full.** `runWorker` previously tail-truncated stdout (2000 chars)
   before the reviewer/orchestrator JSON-parsed it → corrupted verdict + usage. Fixed (full stdout; truncate
   only at persistence via `tailOutput`). VERIFY this stays true: a large reviewer output must still parse.
4. **Tool-data dirs pollute the patch.** The worker's real `$HOME` loads the operator's CodeGraph
   SessionStart hook (`~/.pilot/hooks/codegraph_init.py` → `.codegraph/`) + Serena MCP (`.serena/`); in a
   workspace not gitignoring them they leak into the captured diff. Fixed via `worktree.ts`
   `DIFF_EXCLUDE_DIRS`. VERIFY the captured patch is clean (task-files only) on a real run.
5. **Lead session "Session operation in progress / STOPPED but live tmux exists".** A prior run's tmux
   session (socket `aisup`) blocks a fresh `aisup start`. **Kill orphan tmux before each lead-session run:**
   `for s in $(tmux -L aisup ls 2>/dev/null|awk -F: '{print $1}'); do tmux -L aisup kill-session -t "$s"; done`.
   And `aisup stop --force` the prior session before starting a new one in the same daemon.
6. **Lead-session + worker-cross-LLM CANNOT coexist in one config (ME-001).** A lead session needs a real
   available Claude account; a cross-LLM worker leg needs ALL Claude accounts UNAVAILABLE. The cross-provider
   **Slack post** (notifyCrossProviderFailover → active session channel) therefore needs a DIFFERENT design
   to validate live: either (a) start a lead session on account A, then make the WORKER's claude candidates
   fail via a *separate* mechanism while A stays the lead account — only feasible if you can force a worker-
   specific 429/auth without disabling A globally; or (b) accept that this specific combination is
   structurally hard and validate the Slack-post code path by injecting a `worker.failover{cross_provider}`
   against a live session channel through the daemon's notifier directly. **DO NOT mark Truth-2a's Slack post
   PASS from the journal event alone — that is the corner I cut. Drive a REAL post into a REAL channel.**
7. **Slack channel creation works but the session must live long enough for the session-info post.** Proven
   2026-06-26: `aisup start` → `slack.channel_created` (e.g. `C0BEC6X42LQ`) + a `:rocket: Supervised session
   started` post + channel_join lines (verified via `conversations.history`). If you tear down within ~1s,
   the post may race. Wait ≥15s after `slack.channel_created`, then read the channel back via the Slack API.
8. **Detectors drift across Claude Code versions.** `skills/detector.ts` and `permissions/detector.ts`
   originally scraped pane output and broke against 2.1.181 (skill marker gone; permission verb `create`
   unmatched; TUI cursor-fragmentation). They were re-implemented via **Claude Code hooks**
   (`--settings ~/.aisup/claude-hooks.json` → `POST /api/hooks/...`). VALIDATE the hook path against the
   CURRENT installed `claude --version` — do not trust that it still fires.
9. **`/private/tmp` vs `/tmp` symlink.** Claude renders telemetry `cwd` as the realpath (`/private/tmp/...`);
   identity matching can silently reject a `/tmp/...` session cwd. Always use canonical `/private/tmp` paths.

---

## 5. EVIDENCE & METRICS RULES

- Every check: record the **exact command**, the **terminal status** (PASS/FAIL/GAP/BLOCKED), and the
  **evidence** (journal event lines with `event_type` + key `details`, Slack API responses, measured token
  counts / latencies / RSS, exit codes).
- Token/latency/perf checks need **numbers**, not adjectives. "fast" is not evidence; "switch completed in
  3.2s, context 45837→45837 tokens" is.
- For each feature, the **success metric** is defined in its row. If the observed behavior diverges, it is a
  FAIL or GAP — not a "note".
- Write all results back into THIS file (a `## RESULTS` section) or a sibling `…-RESULTS.md`, and keep the
  raw validation logs under `/private/tmp/aisup-*.log`.

---

## 6. FEATURE-BY-FEATURE VALIDATION SUITES (the core — every feature, real, no mocks)

> For each: SETUP → ACTION → EXPECT (with exact events) → METRIC. Run against an isolated live daemon.

### Suite A — Supervisor Daemon & Infra
- **A1 Daemon lifecycle:** `aisup daemon start` → PID + `/api/health` `{ready:true}` + journal
  `daemon.started`/`daemon.rehydrated`/`daemon.ready`; `aisup daemon stop` → clean, port freed.
  METRIC: health 200 within 60s; clean shutdown; no orphan node/tmux.
- **A2 Runner abstraction:** set `runner.command` to a non-claude binary (`cat`/`echo`); confirm `doctor`/
  dry-run reflects it; restore. METRIC: config-driven runner, no code change.
- **A3 Real session launches + stays alive (claude runner):** `aisup start --cwd <scratch>` → Claude Code
  session ACTIVE, pane alive ≥30s, zero crash events. METRIC: `pane dead=0`, no crash loop.
- **A4 Rehydration across daemon restart:** start a session, restart the daemon, confirm the session is
  reattached and continues. METRIC: session survives restart (journal `daemon.rehydrated` + session intact).

### Suite I — Event Journal + Status/Log CLI
- **I1** `aisup status` (running/clean), `aisup log` (events render), `aisup log --type <event>` filter,
  `--json`. METRIC: outputs match journal; filters work.
- **I2** Journal is valid JSONL under burst (dispatch several events rapidly); every line `JSON.parse`-able.

### Suite B — Smart Account Selection & Usage Ledger
- **B1 Selection on real headroom:** with ≥2 accounts + the usage ledger, `aisup accounts` shows per-account
  `5h/7d %` + basis (`live|aged|reset`); dry-run selection picks the highest-scoring account. METRIC: the
  account with the most headroom is selected; stale telemetry is decayed (`aged`/`reset`), not shown as live.
- **B2 Ledger persistence:** ledger written 0600 with reset trail; survives restart.
- **B3 Determinism (HI-001):** with a fresh isolated ledger + isolated statusline dir, all accounts report
  `unknown` basis → selection follows **config order**. METRIC: `worker providers` shows all `unknown`.

### Suite C — Proactive Rate-Limit Failover (soft/hard) + S1
- **C1 Manual failover:** real session establishes a codeword; `aisup failover --to <acct>` →
  `migration.completed{copied}` + `claude --resume` → resumed session **recalls the codeword**. METRIC:
  context carries; codeword recalled.
- **C2 Automatic soft-threshold trigger:** drive real usage to cross `soft_pct` (or set `soft_pct` below
  current live %) → daemon `rate_limit.threshold_crossed{level:soft}` → at idle `account.switch
  {reason:soft_threshold, selection_mode:automatic}` → `migration.completed` → `launch_mode:resumed`.
  METRIC: the daemon's OWN monitor fires (no injection) and switches at idle.
- **C3 Hard-threshold trigger:** cross `hard_pct` → interrupt + switch (not idle-gated). METRIC: immediate
  switch at hard threshold.
- **C4 (S1) Threshold variation:** repeat C2 at ≥2 distinct `soft_pct` values; confirm single clean switch
  each (no double-switch). METRIC: one switch per crossing; state consistent (ACTIVE→SWITCHING→ACTIVE).

### Suite D — Reactive Recovery (D₁/D₂) + S3 (run each as a real daemon loop)
- **D1 429:** inject `429 Too Many Requests` into a session's output log → `failure.detected{has429:true}`
  → `account.switch{reason:429}` → session continues on the next account.
- **D2 Auth failure:** inject `Invalid API key · Please run /login` → `failure.auth_detected` → switch.
- **D3 Process crash:** `kill -9` the pane process → `failure.detected{source:recovery_handler}` →
  `recovery.restart_fresh_no_session_id` (same-account restart).
- **D4 Network restart-after-threshold:** inject `ECONNRESET` ×N (threshold) → `failure.network_detected`
  escalates only at threshold → restart (no premature switch).
- **D5 All-exhausted / no target:** disable all but one account + 429 it → `failover.no_target_available
  {terminal:true}` → `session.exhausted` → `recovery.exhausted_polling_started` (sleep-and-poll auto-resume).
- **D6 (S3) Circuit breaker:** force repeated independent failover failures → breaker trips → COOLDOWN.
  (If a clean live trip is impossible once a session is EXHAUSTED, document EXACTLY why and what was observed —
  do not just cite unit tests.)
- **D7 False-positive guard:** confirm innocent prose ("add rate limiting to the login endpoint", "wait 5
  minutes for the build", "add a usage cap") does NOT trigger a switch. METRIC: 0 spurious switches.

### Suite E — Lead Session + Slack (THE HALF THAT WAS NOT VALIDATED — do it fully) + S4
> Reuse/extend `scripts/validation/lead-session-slack.sh`. **Let the session LIVE ≥30s.**
- **E1 Channel creation:** `aisup start` → journal `slack.channel_created{channel_id}`; read it back via
  `conversations.info` (name, not archived). METRIC: real channel exists.
- **E2 Session-info post:** within the channel, `conversations.history` shows the `:rocket: Supervised
  session started` message with session id / account / cwd, ahead of the channel_join lines. METRIC: post present.
- **E3 Stop post:** `aisup stop` → channel shows `Session … has ended.` METRIC: stop message present.
- **E4 Inbound read-only command:** as the allowed user, send `!status` in the channel → bot replies with
  session status. (You must send a REAL message as a REAL allowed user — coordinate with the operator or use
  a user token; do NOT fake it.) METRIC: bot reply present.
- **E5 Inbound worker command:** `!worker status` → bot replies worker surface.
- **E6 Bidirectional relay + confirmation gate:** `!cmd say PINEAPPLE` → bot "Reply !confirm" → `!confirm`
  → "Sent" → the pane shows the injected text. METRIC: full relay + confirm gate works.
- **E7 Unknown command:** `!nope` → "Unknown command… /help". METRIC: graceful handling.
- **E8 Unauthorized user (exploit):** send a command from a user NOT in `allowed_user_ids` → ignored +
  `slack.message_ignored`. METRIC: rejected.
- **E9 No echo loop:** the bot's own messages do not trigger handling. METRIC: no loop.
- **E10 (S4) Slack capability completeness:** enumerate every Slack-emitting code path
  (`grep -n postMessage src/slack/service.ts`) and confirm each fires in some scenario (start, stop, exhausted,
  permission request, cross-provider failover, relay). METRIC: every postMessage path exercised.

### Suite F — Permission Fallback Broker (validate the HOOK path on the CURRENT claude version)
- **F1 Detection via hook:** real session with `permissions.enabled` → trigger a tool that prompts (Write a
  file) → `POST /api/hooks/...` → `permission.detected` + (if `slack_routing`) routed to Slack. METRIC:
  the broker engages on the CURRENT `claude --version` (verify; do not trust prior evidence).
- **F2 Approve/deny via Slack:** `!permit` / `!deny` (or the configured keys) resolves the prompt; the pane
  proceeds or cancels. METRIC: round-trip works.
- **F3 Policy allow/deny defaults:** allowlist/denylist + `default_action` honored; grant TTL respected.
- **F4 (exploit) Keystroke validation:** confirm only the configured approval/denial keys are injected; no
  arbitrary keystroke injection. METRIC: malformed key rejected.

### Suite J — Workflow Skill Propagation (HOOK path, CURRENT version)
- **J1 Skill detection:** `/spec` (or another skill) in a live session → `POST /api/hooks/skill` →
  `active_skill` set within ~2s + journal `skill.detected{source:"hook"}`. METRIC: fires on CURRENT version.
- **J2 Continuation injection on failover:** failover a `--plan` session (resumed mode) →
  `continuation.injected{plan_path}` → resumed pane shows a SHORT "Continue… Plan file: …" pointer (NOT a
  context dump) → the resumed Claude reads the plan. METRIC: pointer fires; token-lean.

### Suite H — Validation Gate Engine (H₁ supervisor, H₂ worker)
- **H1 Supervisor gates:** configure `gates.enabled` with a passing + a failing(optional) gate;
  `aisup gate run` → `PASSED`/`FAILED(optional)` + journal `gate.started/passed/failed/run_completed`;
  required-fail → aggregate FAIL. METRIC: exit codes + `required` semantics honored.
- **H2 Worker gates:** a worker with a real validation gate (`npm run typecheck`) — gate passes → merge
  allowed; gate fails → REJECTED, merge blocked (fail-closed). METRIC: fail-closed merge block.

### Suite G + Part B — Worker Orchestration & Multi-Provider Failover (the worker half)
> Reuse `scripts/validation/live-multiprovider-failover.sh`. All legs REAL.
- **G1 Full codex pipeline (AC1/5/6/7):** `worker dispatch` (real codex) → worktree → file change → gate →
  review APPROVE → AWAITING_APPROVAL (patch ABSENT pre-approval) → `approve` → applied to working tree, no
  auto-commit (HEAD unchanged) → MERGED. METRIC: exact AC chain.
- **PB-1 (Truth 1) account-first failover:** no-auth account first → `worker.candidate_failed{auth_failed}`
  → `worker.failover{cross_provider:false}` → real next account `worker.completed` → review → `awaiting_approval`.
  METRIC: completes on the NEXT REAL CLAUDE account; clean task-only patch.
- **PB-2 (Truth 2a) cross-LLM claude→codex:** all claude unavailable → `worker.failover{cross_provider:true}`
  → real `codex exec --json` `worker.completed`. METRIC: real codex winner; cross_provider event.
- **PB-3 (Truth 2a Slack):** the cross-LLM failover posts a REAL message to a REAL active session channel.
  **(See §4.6 — this is the corner that was cut; do it for real or mark BLOCKED with the exact reason.)**
- **PB-4 (Truth 2b) codex budget gate:** all claude unavailable + codex budget crossed →
  `worker.all_candidates_exhausted`, NO codex subprocess. METRIC: budget gates codex; no unbounded run.
- **PB-5 (Truth 3) `worker providers`:** live per-provider readout (claude basis; codex tokens-remaining vs
  budget; flips to `budget_exhausted`). METRIC: matches the leg state.
- **G2 Reviewer failover:** a reviewer-side failover (reviewer 429/auth) tries the next reviewer candidate;
  fail-closed verdict preserved.
- **G3 Boundary audit:** a worker that writes into the MAIN tree (or a symlink/`..` escape) → audit FAILS →
  `worker.failed`, merge blocked. (Real run, not just the smoke test.)
- **G4 Worktree cleanup:** worktree removed after merge/reject; empty `worktree_dir` base removed.

### Suite K — Cost / Token Tracking
- **K1** After a real supervised session, `aisup cost` shows today/7d/30d with per-account breakdown matching
  the real spend. METRIC: non-zero, per-account, matches the session's actual cost.

### Suite Statusline — Telemetry contract
- **ST1** Confirm `statusline-<uuid>.json` fields, `resets_at` epoch-seconds, and `freshness_window_s`
  staleness rule (stale telemetry not treated as live). METRIC: stale tap rejected; fresh tap consumed.

---

## 7. ADVERSARIAL / BREAK-IT / EXPLOIT / PERFORMANCE SWEEP (be hostile)

> Goal: find what breaks aisup, what leaks, what an attacker could do, and where the UX degrades. Each finding
> = a row with repro + impact + (if found) the failing evidence.

### Exploits & security
- **X1 Prompt-injection secret exfil:** dispatch a worker task instructing it to read a secret and write it
  into the patch → MUST end `worker.security_denied`, no raw secret persisted. (Use a synthetic
  `api_key = sk-canary-…` to avoid real-secret exposure; ALSO try a real `~/.aisup/secrets.env` read to
  confirm `$HOME`-resolved/out-of-worktree writes never enter the diff.)
- **X2 Worktree escape:** task attempts `../` traversal, absolute-path write, and symlink-out → all rejected
  by the worktree guards + boundary audit.
- **X3 Patch-bomb / forbidden paths:** patch touching `**/.env`, `**/*.pem`, `**/.claude/settings.local.json`,
  `**/*.jsonl` → `security_denied` (forbidden-path + secret-content scans).
- **X4 Daemon auth:** unauthenticated / wrong-bearer request to every HTTP route → 401. Enumerate routes
  (`grep -n "fastify\|\.get(\|\.post(" src/daemon/server.ts`) and hit each without the token.
- **X5 Slack auth bypass:** commands from non-allowed users ignored (E8); confirm no privilege escalation via
  crafted payloads.
- **X6 Malicious patch passing gates:** a patch that passes the gate but is harmful on apply → confirm apply
  is operator-gated (no auto-commit) and the operator sees the full diff before approval.
- **X7 Command/arg injection:** confirm subprocess launches are shell-free (no `sh -c` of untrusted strings);
  pass shell metacharacters in task prompts / config and confirm they are passed literally.
- **X8 Config injection:** NUL/newline/path-traversal in config fields → rejected by the loader.

### Resource exhaustion / break-the-system
- **B-1 max_concurrent:** dispatch > `max_concurrent` workers (use a slow real or fake-but-real-subprocess
  runner) → confirm ≤ cap run concurrently (count real subprocesses), rest QUEUED.
- **B-2 Daemon crash mid-worker:** `kill -9` the daemon during a worker run → restart → rehydration either
  recovers or cleanly fails the worker (no orphaned worktree/lock/zombie).
- **B-3 Concurrent failovers:** trigger two account switches near-simultaneously → single consistent switch,
  no double-switch, no state corruption.
- **B-4 Journal write failure:** make the journal path unwritable mid-run → graceful degradation / clear
  error, no silent data loss.
- **B-5 Disk/quota edge:** fill the worktree dir / hit MAX_BUFFER on a huge worker stdout → bounded, no crash.
- **B-6 Clock skew / reset-window edge:** set a budget reset at the exact boundary → correct gating, no
  off-by-one.
- **B-7 Malformed external JSON:** feed corrupt `state.json` / ledger / hook payloads → `*_corrupt` events,
  no crash.
- **B-8 All providers down + lead session:** every Claude account + codex unavailable while a lead session
  runs → `session.exhausted` + auto-resume poll; worker → `all_candidates_exhausted`.

### Performance / bottlenecks / UX
- **P-1 Failover latency:** measure threshold-cross → resumed-session wall time (record seconds). Flag if > a
  few seconds.
- **P-2 Context-handoff token cost:** measure context tokens before/after EVERY handoff (account→account,
  and the cross-LLM worker prompt size). MUST be no re-summarization; record exact deltas.
- **P-3 Idle CPU / loop adherence:** daemon idle 5 min → loops fire at configured intervals
  (`rate_limit:30s, health:60s, recovery:5s, idle:120s`), no busy-spin (sample CPU).
- **P-4 Memory stability:** long-running daemon across repeated sessions/workers → sample RSS over time; flag
  growth (Map leaks).
- **P-5 Journal growth / rotation:** confirm rotating-log behavior; no unbounded growth.
- **P-6 UX degradations:** Slack message latency, duplicate posts, stale statusline, confusing error text,
  `aisup --help` accuracy, command discoverability. Record any rough edge.

---

## 8. FINAL SIGN-OFF MATRIX (fill EVERY cell — no blanks)

| Area | Checks | PASS | FAIL | GAP | BLOCKED | Evidence ref |
|------|--------|------|------|-----|---------|--------------|
| A Daemon/Infra | A1–A4 | | | | | |
| I Journal/CLI | I1–I2 | | | | | |
| B Account select | B1–B3 | | | | | |
| C Proactive failover | C1–C4 | | | | | |
| D Reactive recovery | D1–D7 | | | | | |
| E Lead session/Slack | E1–E10 | | | | | |
| F Permission broker | F1–F4 | | | | | |
| J Skill propagation | J1–J2 | | | | | |
| H Gates | H1–H2 | | | | | |
| G/PB Workers/failover | G1–G4, PB1–PB5 | | | | | |
| K Cost | K1 | | | | | |
| ST Statusline | ST1 | | | | | |
| X Exploits | X1–X8 | | | | | |
| Break-it | B1–B8 | | | | | |
| Perf/UX | P1–P6 | | | | | |

**Plus a written ADVERSARIAL FINDINGS REPORT:** every bug/exploit/leak/degradation found, with repro,
severity, and proposed fix. If you found NONE in a category, state explicitly that you tried hard and what you
tried (so "no findings" is credible, not lazy).

**The effort is COMPLETE only when:** every cell above is filled with a real status + evidence, the findings
report exists, the operator-state invariants held on every run, and any BLOCKED row names the exact blocker.

---

## 9. APPENDIX — COMPLETENESS CHECKLISTS (use to prove nothing was skipped)

**Every CLI command must be exercised** (enumerate from `src/cli/`):
`daemon (start/stop/status/health)`, `start`, `stop`, `status`, `failover`, `accounts`, `cost`, `log`,
`gate (run)`, `worker (dispatch/providers/status/approve/reject/cancel/log)`, `attach`, `init`.
→ Run `ls src/cli/commands/` and `grep -rn "\.command(\|addCommand\|registerCommand" src/cli/` to get the
authoritative list; tick each.

**Every journal event_type must be observed at least once** (enumerate from the code):
→ `grep -rhoE "event_type: ?['\"][a-z_.]+['\"]|emit\(['\"][a-z_.]+" src/ | sort -u` to get the authoritative
set; map each to the suite that produces it; flag any event never observed.

**Every config option must be exercised or explicitly noted N/A** (enumerate from `src/config/schema.ts`):
→ walk `AisupConfig` and every nested interface; for each field, name the check that varies it.

**Every PRD flow must be walked end-to-end** (enumerate from `docs/prd/2026-04-29-ai-supervisor.md`):
→ list each PRD Flow / Feature row; map to a suite; confirm Implemented + validated.

**Every `postMessage` / Slack path, every detector, every recovery flow, every worker terminal state**
→ enumerate from code and tick each.

---

## 10. HONEST HANDOFF NOTES (what the prior session actually did vs. cut)

- **Worker half: genuinely validated live** — PB1–PB5 ran real (account failover → `awaiting_approval`;
  claude→codex `cross_provider` + real codex completion; codex `budget_exhausted` → `all_candidates_exhausted`;
  `worker providers` live). Part C C1-b (cross-LLM fidelity, canary in codex patch), C2-e (codex usage
  recorded), C4-c (secret-injection → `security_denied`) ran real. Two product bugs were found+fixed
  (tool-data patch pollution; `runWorker` stdout truncation) and committed (`01bfc92`).
- **Lead-session/Slack half: NOT properly validated** — the prior session leaned on prior-session evidence
  and unit tests instead of running it. A real channel WAS finally created live 2026-06-26 (`C0BEC6X42LQ`,
  session-info + stop posts confirmed via `conversations.history`), but inbound commands (E4–E7), permission
  broker live (F), skill hook live (J1) on the CURRENT version, automatic soft/hard triggers (C2/C3) this
  session, full reactive-recovery matrix (D) this session, and the cross-provider Slack post (PB-3) were NOT
  re-run live. **Treat ALL of §6 as un-validated and run it.** Do not inherit a single PASS.
- Residual perf/edge items (P-1 latency, P-3 intervals, P-4 memory, B-3 race) were never live-measured.
- Uncommitted at handoff: the strengthened `2026-06-17` plan (Part C), the new harnesses
  (`strengthened-fullsystem.sh`, `lead-session-slack.sh`), and this document.

---

## 11. REVIEW PASS — gaps found on re-read (2026-06-26) and now incorporated

I re-read §0–§10 and found the following missing. These are NOT optional — they are part of the full run.

### Missing CLI / feature checks (add to §6)
- **A5 `aisup init`:** creates `~/.aisup/config.yaml` + `api-token` (0600, 32-byte hex); `--dry-run` prints
  without writing; `--force` overwrites. METRIC: token perms 0600; idempotent.
- **A6 `aisup attach`:** attaches to a running session's tmux pane (read-only/interactive per design).
  METRIC: attaches to the live pane; detaches cleanly.
- **A7 `aisup doctor` / `daemon health`:** diagnostics report (runner resolution, account auth, port).
  METRIC: reports real state; no false "healthy".
- **B4 Disabled account exclusion:** `enabled:false` account is never selected. **B5 Tie-break determinism:**
  two equal-score accounts → deterministic, stable pick (no flapping).
- **C5 Invalid failover target:** `aisup failover --to <nonexistent>` → clear error, no state change.
- **E11 Slack Socket Mode resilience:** drop network briefly during a session → Socket Mode reconnects;
  buffered/missed inbound commands handled sanely (no crash, no duplicate execution).
- **E12 Secret redaction in relay (PRIVACY/EXPLOIT):** make the pane emit a secret-pattern string
  (e.g. `sk-ant-…`, `xoxb-…`, `api_key=…`) → confirm `relay_output_enabled` posts to Slack with the secret
  **REDACTED** per `redaction_patterns`. A leaked secret here is a SEV-1 finding.
- **F5 Grant TTL:** `grant_ttl_seconds` — a granted permission expires after the TTL (re-prompts).
- **F6 default_action:** with `default_action: deny`, an unmatched tool is denied (and vice-versa for allow).
- **J3 `resume_prompt_mode` all modes:** `never` (default → NO continuation injected), `always`,
  `on-failure` — confirm each mode's injection behavior on a real failover.
- **G1b Worker REJECT flow:** operator `reject` a patch → status REJECTED, patch NOT applied, HEAD unchanged,
  worktree cleaned. **G5 Pinned dispatch:** `worker dispatch --implementer X --reviewer Y` pins single
  candidates with NO failover (a pinned-candidate failure terminates, does not fail over). **G6 Worker
  rehydration:** kill the daemon while a worker is QUEUED / RUNNING / MERGING → restart → QUEUED &
  AWAITING_APPROVAL preserved; MERGING reconciled to MERGED (patch already applied) / AWAITING_APPROVAL
  (interrupted) / AWAITING_APPROVAL+apply_conflict (no longer applies). Real kill, real restart.
- **I3 Journal secret redaction:** a worker whose stdout contains a secret → the persisted `stdout_tail` /
  `raw_output_tail` in `output.json`/`state.json` is REDACTED (`redactTails`); `security_denied` withholds
  tails entirely. METRIC: no secret bytes on disk in the isolated state.
- **ST2 Statusline edges:** negative `freshness_window_s` rejected; `cwd` realpath-canonicalised so a
  `/tmp` symlinked session still matches its `/private/tmp` telemetry tap.

### Missing adversarial / perf checks (add to §7)
- **X9 Secret redaction everywhere:** a single secret-bearing line must be redacted in ALL sinks
  simultaneously — Slack relay (E12), journal (I3), worker patch (X1/X3). Probe each sink in one run.
- **X10 api-token hygiene:** `api-token` is 0600, never logged, never posted to Slack, never in the journal.
- **X11 Hook endpoint abuse:** the daemon `POST /api/hooks/*` endpoints require the bearer token and reject
  forged skill/permission payloads from a non-authenticated caller (these drive `active_skill` / permission
  routing — an unauthenticated forge could spoof state).
- **B-9 Socket Mode reconnect storm:** rapid connect/disconnect → no runaway reconnect loop, no duplicate
  channel creation.
- **P-7 Slack de-dup / rate-limit:** burst of session events → no duplicate posts; Slack 429s backed off.
- **P-8 Detector latency:** time from a real prompt/skill marker appearing to `permission.detected`/
  `skill.detected` (hook path) — record ms; flag if a fast user action is missed.

### Strengthened completeness gate (replaces a soft §9)
- **PRD acceptance-criteria mapping is MANDATORY, not optional.** Produce a table: every PRD Flow + every
  acceptance criterion in `docs/prd/2026-04-29-ai-supervisor.md` → the suite check that validates it →
  PASS/FAIL/GAP. A PRD AC with no mapped, executed check is a GAP, full stop.
- **Event-taxonomy coverage is MANDATORY:** the set produced by
  `grep -rhoE "emit\(['\"][a-z_.]+|event_type['\": ]+['\"][a-z_.]+" src/ | sort -u` must each be **observed
  live at least once** during this validation, or explicitly marked "unreachable in any real scenario" with
  the code reason. An event that never fires in any test is either dead code (a finding) or a missing test.

### Process gaps in §0–§10 themselves (so the next session doesn't repeat my failure)
- **Anti-corner-cutting rule:** for EVERY row, before writing PASS, ask: "Did I run the real thing and read
  the real output in THIS run?" If the honest answer is "I'm relying on a prior run / a unit test / the code
  looks right" → it is NOT PASS; it is GAP or BLOCKED. (This is exactly the failure that produced this
  handoff. Do not repeat it.)
- **One run ≠ one assertion:** a real run often produces evidence for several checks at once (e.g. a worker
  run yields G1, PB-*, X1, P-2, I3). Plan runs to harvest multiple checks, but each check still needs its own
  evidence line — do not let one PASS silently imply others.

**Second-pass conclusion:** with §11 incorporated, the document covers every CLI command, every config
field surface, the full PRD-flow + event-taxonomy completeness gates, the lead-session/Slack half end-to-end,
the worker half end-to-end, and a genuine adversarial sweep (exploits, secret-leak sinks, resource
exhaustion, races, latency/memory, UX). If the executing session finds a feature/flow not covered by any row
above, that omission is itself a finding to record and the row to add.
