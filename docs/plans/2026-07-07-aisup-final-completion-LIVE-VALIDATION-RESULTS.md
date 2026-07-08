# aisup — Final-Completion LIVE VALIDATION · RESULTS

**Run owner:** fresh Claude Code session (Opus 4.8) · **Started:** 2026-07-07 · **Directive:** `docs/prompts/2026-07-07-live-validation-final-completion.md`

Validates the `2026-06-30-aisup-final-completion.md` changeset (uncommitted working tree) against the **live** running system. Mirrors the evidentiary bar of `2026-06-26-aisup-FULL-MANUAL-SYSTEM-VALIDATION-RESULTS.md`.

Status legend: **PASS** (ran the real thing, read real output this session) · **FAIL** · **GAP** (couldn't fully prove; reason stated) · **BLOCKED** (names exact blocker) · **UNIT_VERIFIED** (only mock/unit coverage — does NOT count as validated here).

> **No git writes.** The entire changeset is uncommitted; the commit decision is the operator's. This run performs zero git write commands.

---

## §1 Preflight & environment (recorded this run — real values)

| Item | Value | Status |
|------|-------|--------|
| node | v22.22.1 | OK |
| claude | **2.1.203** (Claude Code) — NEWER than 2.1.193 in the 2026-06-26 run; hook detectors + keystroke mapping re-checked | OK |
| codex | codex-cli 0.142.0 | OK |
| tools | tmux 3.x, jq, lsof, openssl, uuidgen present; `timeout` ABSENT on macOS (used Bash-tool/`sleep+kill` bound) | OK |
| build | `npm run build` (tsup) → exit 0, "Build success in 243ms" | PASS |
| typecheck | `npm run typecheck` (= `tsc --noEmit`) → **exit 2, 4 errors** (see FV-2) — NOT clean | **FAIL vs plan claim** |
| vitest | `npx vitest run` → **PASS(870) FAIL(0) skipped(12)** | PASS |
| Claude acct ~/.claude (primary) | `CLAUDE_CONFIG_DIR=~/.claude claude -p "Reply with exactly: OK"` </dev/null → exit 0, `OK` | AUTHED |
| Claude acct ~/.claude-account2 | exit 0, `OK` | AUTHED |
| Claude acct ~/.claude-account3 | exit 0, `OK` | AUTHED |
| codex auth | `~/.codex/auth.json` present (4.4K); CODEX_HOME=~/.codex | AUTHED |
| Slack bot token | `auth.test` → ok, team `bsys` (T0BAW056K99), bot user `aisup` (U0BBX99QRMW), bot_id B0BAZJQJ813 | VALID |
| Slack app token | `apps.connections.open` → ok, wss url present (Socket Mode works) | VALID |
| Slack bot scopes | `chat:write, groups:write, groups:write.invites, groups:history, groups:read` | see FV-3 |
| Slack `files:write` scope | **MISSING** → D4 file-upload path blocked; `doctor` should flag it | BLOCKED (D4 upload) |
| Slack interactivity toggle | Not readable via Web API; proven only by a live button tap (see TS-001) | pending live |
| repo | branch `main` @ `fc7678d`; final-completion changeset uncommitted (52 mod + untracked) | OK |

## §2 Operator-state isolation baseline (assert UNCHANGED after every isolated run)

- `~/.aisup/config.yaml` sha256 = `1d61b7a5400307753154b27abc35b8a5e2f3756409f3814afbb0440ba05e07c8`  *(byte-identical to the 2026-06-26 baseline — operator config untouched since)*
- `~/.aisup/journal.jsonl` mtime:size = `1781889680:95413`  *(byte-identical to 2026-06-26 — operator journal untouched since)*
- All isolated runs: `AISUP_HOME=/private/tmp/aisup-val-*`, dedicated ports (7401/7402/7403/7405), per-run api-token, isolated tmux sockets (`aisup-val1`/`aisup-wval`/`aisup-d3`).
- **Closing assertion — HELD.** After all isolated daemon/session/worker runs (incl. a real failover, threshold taps, and codex workers), operator `~/.aisup/config.yaml` sha256 = `1d61b7a5…07c8` and `journal.jsonl` mtime:size = `1781889680:95413` — **byte-identical to the baseline**. The real Claude account telemetry (`/tmp/pilot-failover`) is shared, not operator `~/.aisup` state.
- **Live surfaces still running for operator completion:** the isolated **val-1** daemon (port 7401) + the **val-lead** Claude session + its Slack channel are intentionally left up so the operator can complete the PENDING-OP taps (TS-002 Expand modal, `!notify`, `!accounts`/`!cost`/`!health`/`!worker providers`, worker Approve). Tear down with `AISUP_HOME=/private/tmp/aisup-val-1-* aisup stop --force && … daemon stop` when done.

---

## §3 Results by area

_(filled as each check runs; every PASS carries the exact command + real output evidence)_

### Priority-0 scenarios

#### TS-001 — Permission card: tap-to-approve, never times out (Critical)
- **Part 6 (host-gated resolver mechanism) — PASS.** `AISUP_TEST_LONG_PERMISSION=1 npx vitest run tests/permissions/long-permission.hostgated.test.ts` → `1 passed (8180ms)`; drives the REAL `resolveHookPermissionViaKeystroke` → real tmux `send-keys` against a Claude-shaped `read`-blocking pane, with a real `promptStillActive` re-scan; asserts the dialog is still detectable at the wait boundary and the keystroke resolves it (`permission.granted`, sentinel→RESOLVED).
- **Part 2/6 (never-times-out, canonical ≥5 min) — PASS.** `AISUP_TEST_LONG_PERMISSION_WAIT_MS=360000 AISUP_TEST_LONG_PERMISSION=1 npx vitest run …` → `resolves a dialog left open 360000ms via the real hook resolver 360202ms` — `1 passed`. A dialog left open **6 minutes** was still detectable and resolved by a keystroke through the real path; the resolution mechanism does not time out. (Corroboration of the mechanism; the full real-Claude-dialog + real-Slack-card + real-tap parts 1/3/4/5 are in the TS-001 live section below.)
- **Part 1 (card posts) — PASS.** Real Claude 2.1.203 lead session (isolated val-1, Slack on, manual mode) given a Bash-write task → real permission dialog blocks in the pane AND the PermissionRequest hook fired (`permission.detected{source:hook}` + `permission.routed_to_slack{tool:Bash}`). Block Kit card posted to the channel ROOT: `:lock: *Permission requested* — Bash` + command preview code block + **Approve**(primary)/**Deny**(danger) buttons, each carrying opaque `request_id` (`0e42c336…`). **No "Approve for session"** button (correct — A0 keystroke unconfirmed), **no "!permit" text**. Read back via `conversations.history`.
- **Part 2 (never times out, real Claude dialog) — PASS.** Card left untouched 45s → 0 `permission.keystroke_timeout`/`auto_denied`/`expired`; pane dialog still `❯ 1. Yes`; card still Approve/Deny (not annotated). Combined with the ≥5-min host-gated mechanism proof.
- **Part 3 (tap Approve → resolves) — PASS (operator tap).** Operator tapped Approve → daemon sent `approval_key` (`y`)+Enter → **the real numbered dialog resolved**: `probe.txt` was written with "hello-aisup", pane showed "Done. Wrote hello-aisup to probe.txt", card updated in place to `:white_check_mark: Approved by <@U0BB4624YN5>`, journal `permission.granted`. **This confirms the configured `approval_key` 'y' actually resolves the real Claude 2.1.203 numbered permission menu** (previously only proven against a shaped `read` prompt).
- Parts 4 (out-of-order id-routing) & 5 (restart-survival tap) — see live section (id-routing mechanism proven; 2 truly-concurrent live cards hard to force from one session).

#### TS-002 — Activity feed: meaningful rows, expandable diff (High)
- **Part 1 (PostToolUse fires on 2.1.203) — PASS.** Installed `claude-hooks.json` has `PostToolUse → http://127.0.0.1:7401/api/hooks/activity`; a real Bash tool use fired `activity.posted` → a threaded row posted. Hook-primary path is live.
- **Part 2 (rows; Read suppressed) — PASS.** Activity thread root `:satellite: *Activity* — Claude's actions appear in this thread`; a Bash produced `:arrow_forward: \`echo hello-aisup > probe.txt\``; an Edit produced `:pencil2: edit \`…/README.md\`` (with an `activity_expand` Expand button). A `Read` of `.gitignore` produced **no** row (journal `activity.posted` = 2, one each for Bash/Edit, none for Read) — Read suppressed at `normal` verbosity. Read back via `conversations.replies`.
- **Part 4 (redaction in row) — PASS.** A Bash command `echo loading; export DEMO_TOKEN=xoxb-2222222222-ZZZfakeSECRET…` posted as `:arrow_forward: \`echo loading; export DEMO_[REDACTED]\`` — raw `xoxb-…` appears 0 times in the thread.
- **Part 3 (Expand → modal with diff) — PASS (operator tap, 2026-07-07).** Operator tapped Expand on all three rows: bash → modal `echo hello-aisup > probe.txt`; edit → unified diff `--- a//…/README.md / +++ b//…/README.md / -return 1 / +return 2`; secret → `echo loading; export DEMO_[REDACTED]`. **Part-4-modal redaction — PASS:** the secret modal shows `[REDACTED]`, no raw `xoxb-…`.
- **Part 5 (`!notify verbose` → Read row) — PASS (operator + driven).** Operator sent `!notify verbose` → "Activity feed: verbose."; then a driven `Read` of README.md posted `:mag: read \`…/README.md\`` (activity.posted tool=Read) — a Read row now appears (was suppressed at `normal`).
- **TS-002 overall: LIVE_PASS** (all three plan steps proven live).
- (Cosmetic note: the edit-diff modal renders the file path as `a//private/…` — a doubled slash from `a/` + an absolute path; harmless.)

### Phase C — observability & control CLI (live vs isolated daemon `val-1`, port 7401, AISUP_HOME=/private/tmp/aisup-val-1-*, 3 accounts, Slack enabled + interactivity, permissions enabled)

- **C1 (`/api/overview` + `aisup health`) — PASS.** `GET /api/overview` returns ONE composed object with keys `accounts`(3), `cost_today`, `daemon`, `recent_events`(3), `recovery_guidance`, `session`, `workers`. `aisup health` renders it: "aisup daemon: running / session: none / accounts primary,account2,account3 HEALTHY / workers: disabled / cost today: $0.00 / recent events…". Single overview call, no 5-call stitch.
- **C4 (`explain` + `log` filters) — PASS.** `aisup explain account.switch` → bespoke description ("A failover moved the session…reason and per-candidate rationale"); `permission.granted` bespoke; `daemon.reloaded`/`worker.security_denied` use a category fallback (still covered). Unknown → "`bogus.event` is not a recognized event type". Coverage test `tests/cli/explain.test.ts` → 4 passed (every EventType covered). `aisup log --details --since <iso>` renders `details` payloads; `--type daemon.ready` filters. (`--account`/`--session` filters deferred to the live-session section.)
- **C5 (doctor guardrails + port preflight) — PASS (one gap: no live scope check, FV-4).** Real `aisup doctor`: `✗ Daemon port 7401 available — Error: port 7401 in use by PID 14148` (port preflight works, reports occupying PID), `✓ ≥2 accounts configured — 3 accounts`, telemetry F-7 hint present, `✓ Slack interactivity — enabled in config`, exit **1**. Negative `<2 accounts`: `✗ ≥2 accounts configured — only 1 configured — failover needs ≥2`, exit 1. Occupied-port `daemon start`: `aisup daemon start failed: port 7401 is already in use (PID 14148). Stop the other process or change daemon.port.` — clear error, NOT a silent detached exit; no rogue daemon bound the port. **Gap:** doctor's Slack check is config-only (`checkSlackInteractivity`), it does NOT query live bot scopes, so the missing `files:write` scope is NOT flagged — see FV-4.
- **C7 (runtime account overrides) — PARTIAL PASS.** `aisup accounts --exclude primary --exclude account2` → dry-run selection moves primary→account3; overrides persist to `~/.aisup/account-overrides.json` (`{"primary":{"excluded":true},"account2":{"excluded":true}}`); `--pin`/`--enable`/`--disable` write flags; `--clear` empties the file and selection returns to `primary`. The CLI applies via `POST /api/accounts/:name/override` (requires the daemon → live, no restart). **Gaps:** (1) the account views (`/api/accounts`, `aisup accounts`, Slack `!accounts`) never surface pin/exclude state — no operator feedback (FV-5); (2) live-daemon-honors-override-on-real-failover and the circuit-breaker-UNAVAILABLE safety case deferred to the live-session section.
- **C13 (`daemon reload` / SIGHUP) — PASS (mechanics; session-survival deferred to live-session section).** Mutated val-1 config (soft_pct 85→80, verbosity normal→verbose = hot; daemon.port = restart-required). `aisup daemon reload` → "reload requested (PID 14148)", exit 0; daemon stays alive on the ORIGINAL port (health 200 — port change not applied live); journal `daemon.reloaded` details = `applied:[thresholds.soft_pct, notifications.verbosity]`, `restart_required:[daemon.port]`. Config restored after.

- **C2 (failover "why") — PASS (journal + CLI); Slack rendering gap (FV-8).** A real hard-threshold failover (primary→account2) journaled `account.switch` with `rationale{reason_code:"hard_threshold", candidates:[{primary, score 17.8, excluded_reason:"is_current"},{account2, chosen},{account3, eligible}], chosen:"account2"}`. `aisup log --details` rendered it: "why: hard_threshold → chose account2 / - primary: 18% (is_current) / - account2: no data (chosen) / - account3: no data (eligible)". **Gap:** no Slack switch message posts for a lead-session account switch (only `notifyWorkerFailover` exists) — the C2 DoD's "Slack switch message renders the rationale" is unmet (FV-8).
- **C9 (`pause`/`resume`) — PASS (state machine); process-suspension unverifiable on macOS.** `aisup pause` → status PAUSED + "Session paused (runner SIGSTOPped)"; `aisup resume` → ACTIVE + "SIGCONTed". Code (`manager.ts:317-319`) resolves the correct pane pid and `process.kill(pid,'SIGSTOP')` (returns ok). **Caveat:** `ps -o stat=` shows `Ss+` before AND after SIGSTOP — but a MANUAL `kill -STOP` on the same pid also fails to show `T`, and `claude` is a native Mach-O binary, so this is a macOS ps limitation, not evidence the signal failed. Loops-skip-PAUSED confirmed by code (`manager.ts:306` "A PAUSED session is not monitored").
- **C11 (session naming + timeline) — PARTIAL PASS.** `aisup start --name "val-lead"` → name shows in `aisup status` (`session: "val-lead" (…) ACTIVE`). `aisup session timeline` prints the ordered lifecycle (start → channel_created → telemetry.absent → permission.detected/routed → granted → activity×3 → failover.no_target_available → account.switch hard_threshold → account2). **Gap (FV-9):** the name is NOT rendered in `aisup log`/`health`/`timeline` (they show the raw id), though the C11 DoD says the name shows in status/log/health.

- **C6 (worker retry) — PASS.** `aisup worker retry <failed-id>` → "retried → new worker f1aef37f…"; the new worker's `state.json` has `retry_of=<parent>`. `aisup worker retry <awaiting-approval-id>` → "retry failed (not_retryable: worker is AWAITING_APPROVAL)" (rejected).
- **C10 (worker cleanup; undo) — cleanup PASS (FV-10 flag note); undo — see below.** Bare `aisup worker cleanup` lists orphaned worktrees (correctly listed only the terminal/orphaned worktree, not the running/awaiting ones); `--force` → "Removed 1 orphaned worktree(s)" (only that aisup worktree; the running worker's worktree + the main workspace were untouched). **FV-10:** the DoD's `--list` flag doesn't exist (`cleanup --list` → "unknown option '--list'") — bare `cleanup` is the list path. Undo validated on wval — see below.
- **C12 (`worker logs --follow`) — PASS.** On a terminal (FAILED) worker, `--follow` streamed the full codex JSON stream (thread.started → reasoning → command_execution → file_change → turn.completed) and exited on the terminal state (`[worker FAILED]`); on an AWAITING_APPROVAL (non-terminal) worker it correctly keeps following. Redaction confirmed via B3's secret worker (below).
- **C8 (cost breakdown) — GAP (no cost data in isolation).** `aisup cost --by provider|skill|task` render the correct grouped output ("Cost by provider/skill/task:") but every window is "(no cost recorded)" — the isolated daemon receives no cost telemetry (statusline taps carried rate-limits, not cost; no `cost.snapshot` events). The **grouping/rendering is exercised**; the actual Claude-vs-codex split could not be validated without a cost-emitting session. Needs a synthetic cost-bearing statusline tap or a real metered session.
- **C3 (tried_candidates) — GAP (single-candidate runs).** The FAILED workers here failed on `boundary_violation`, not candidate exhaustion, so `state.json.tried_candidates` was `absent` (never populated). Populating it needs a genuine multi-candidate failover / all-exhausted run (e.g. an unauth-claude implementer → codex fallback, or an over-budget codex), as the 2026-06-26 PB harness did. Not forced this run. The field exists in `WorkerState`; live population unverified.

### Phase A — interactive Slack remote-control (live)

- **A8 (threshold alerts + warning band + de-dup) — PASS.** Synthetic statusline taps into the daemon's own monitor (no event injection). warning band (80% > warning_pct 75) → 1 alert; soft (88% ≥ 85) → `:warning: *SOFT* usage on \`primary\` — 5h 88% · 7d 50% · resets <ETA>`; hard (96% ≥ 95) → `:red_circle: *HARD* …`. Exactly **1 alert per band** despite 3 soft ticks (de-dup by band). Each alert has account + headroom + reset ETA. ntfy mirrored each (`primary: soft threshold crossed.`). The hard crossing also drove a real failover (→ C2).
- **A5 verbosity — FULL PASS.** `!notify verbose` → a driven Read posts a `:mag: read` row (suppressed at `normal`). `!notify silent` → bot replies "Activity feed: *silent*. Permission cards and threshold alerts still post."; a driven Edit **executed** (README gained `silent-test`) but posted **no** activity row (thread unchanged), while a driven Bash **still posted a permission card** (`permission.routed_to_slack` 1→2, card "Claude is requesting permission to use Bash" + Approve/Deny) — the silent-exception guardrail holds.
- **A6 observability parity — PASS.** Operator sent `!accounts`/`!cost`/`!health`/`!worker providers`; numbers match the CLI at the same state: `!worker providers` codex `2594574 tok` == CLI `2594574 tokens left`; `!cost` 0/0/0 == CLI; `!health` (ACTIVE@account2, 2/3 healthy, awaiting 1) == CLI; `!accounts` showed primary UNAVAILABLE 5h 96% **score 17.80** (matching the C2 rationale) — later decayed to HEALTHY as its reset passed (a telemetry-timing difference, not a parity gap). Same aggregations as the HTTP/CLI readers.
- **A7 worker diff card — PASS (both paths, operator taps).** Operator tapped Approve on the worker card → `:white_check_mark: Approved & merged by @Alec Brock` (real merge via the integrity-anchored handler; verified separately via CLI approve→merge in C10). A second worker whose patch no longer applied cleanly → `:warning: apply_conflict` — the merge correctly REFUSED to force-apply and reported the conflict (double-apply-safe guardrail) rather than corrupting the tree. Card posts carried `Expand diff` + `Approve`/`Deny`.
- **A1/A2 card registry — PASS (round-trip).** The live permission card + activity rows + worker card all persist their `request_id`→{channel,ts} mapping in `~/.aisup/slack-cards.json` (val-1 home); interactivity startup probe: no `slack.interactivity_unverified` warning journaled (interactivity live — confirmed by the working Approve tap).

### Phase D — dashboard + daemon enhancements (continued)

- **D2 (ntfy) — PASS.** With `notifications.ntfy` pointed at a real local HTTP catcher, a real **session-start** POSTed `POST /aisup-val` title "Session started" body "aisup session val-lead on primary."; real **threshold** crossings POSTed title "Usage threshold crossed" body "primary: soft/hard threshold crossed." Real HTTP endpoint, read back from its request log — not a mock. (Disabled-path + failure-journaling covered by the D2 unit test.)

### Phase B — CLI-behavior fixes (live)

- **B1 (F-1/F-2) — PASS.** Daemon up + workers disabled: `aisup worker providers` and `aisup worker list` → "workers not enabled" (NOT "Daemon not running"). `aisup log --json` → valid JSON object (`jq type` = object).
- **B3 (redact_denied_prompts) — PASS.** Worker-only daemon with `workers.security.redact_denied_prompts:true`; dispatched a task instructing codex to write `api_key=sk-…`/`aws_secret=AKIA…` → `worker.security_denied`. Persisted `state.json`: `task.prompt = "[redacted: security-denied]"`, `task.title = "[redacted]"`; 0 raw secret bytes in any persisted artifact. (Default-off behavior is the prior verbatim-retention path.)
- **B4 (docs reconciliation) — PARTIAL PASS (FV-11).** Closure plan Task 13 is `[x]` with an evidence pointer to the 2026-06-26 RESULTS doc; PRD documents Feature L (minimal read-only dashboard), R-UX-04 + R-UX-05 explicitly out-of-scope, and Option C as a future PRD; README documents Slack interactivity + Approve/Deny cards + the observe-only dashboard + token→cookie (never-in-URL). **FV-11:** `docs/runbook.md:429` still says "aisup does not hot-reload config. Restart the daemon." — directly contradicting the shipped C13 `aisup daemon reload`/SIGHUP. (README line 3 also still calls the dashboard "the remaining roadmap item" though it shipped.)
- **B2 (F-3/F-5/F-6) — PASS.** F-5: `aisup gate run` with a passing required gate → "Gates: PASSED", exit **0**; with a failing required gate → "Gates: FAILED", exit **1** (CI-gateable). F-6: a non-existent gate binary → "Gates: FAILED", exit 1, journal `gate.failed` `stderr_tail = "gate spawn error: spawn /usr/bin/definitely-not-here-xyz ENOENT"` (ENOENT surfaced; exit_code null). F-3: absolute `workers.worktree_dir` → `aisup daemon start` exits **1** with `aisup daemon start failed: Config validation error: workers.worktree_dir must be relative (no leading "/")` — clear stderr message, NO blank daemon.out, no rogue daemon bound the port. (See also FV-6: a gate config missing `timeout_seconds` crashes `gate run` with an uncaught `ERR_OUT_OF_RANGE` instead of a load-time validation error.)

### Phase D — dashboard + daemon enhancements

- **D1 (dashboard security guardrails) — PASS.** `GET /dashboard` → 200 HTML shell (5586 B, title "aisup dashboard"), bearer token NOT embedded (grep 0). `/api/overview` no-cred/bad-bearer → 401. Token exchange (token in POST **body**, never a URL/query — shell uses `fetch('/api/dashboard/session',{method:'POST'})`) → `{"ok":true}` + `Set-Cookie: aisup_dash=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`. Read-only cookie: `GET /api/overview`→200; `POST /api/failover`→401; `POST /api/sessions`→401; `POST /api/accounts/account2/override`→401. Real-failover-reflection deferred to live-session section (TS-003 already got a browser pass 2026-07-01).
- **D3 (log rotation + health self-check) — PARTIAL: health self-check PASS, daemon.log rotation PASS, journal rotation FAIL (FV-7).** Fresh isolated daemon with NON-default `daemon.log_max_size_mb: 0.004` and `journal.max_size_mb: 0.004` (~4 KB each), then drove events via a `daemon reload` loop. **daemon.log rotation — PASS:** `daemon.log.1` (4.1 KB) appeared at ~the configured 4 KB, current daemon.log truncated to 732 B. **health self-check — PASS:** `/api/health` returns per-loop `last_tick` + `stale` for rate_limit/recovery/health/idle; a `daemon.health_check` event is journaled each tick with the loop liveness (observed populating from `null`→timestamps as loops fired). **journal rotation — FAIL:** journal.jsonl grew to 9.0 KB — 2×+ over the 4 KB config — with NO rotated file and NO `journal.rotated` event. Root cause **FV-7**: the loader drops `journal.max_size_mb` (returns `undefined`), so `createJournalWriter` gets `Infinity`. Isolated proof: the real `createJournalWriter(path, 0.004)` driven directly DOES rotate (journal.jsonl.1 = 4466 B, 2 `journal.rotated` events) → the writer is fine; the plumbing is broken. **The old P-5 GAP is closed for daemon.log but NOT for the journal.**

---

## §3b Post-validation fixes applied (2026-07-08)

The three substantive defects were fixed at the operator's request and re-verified. `tsc --noEmit` is now **clean (exit 0)**; `npm run build` clean; `npx vitest run` **871 pass / 0 fail / 12 skipped** (added an FV-7 loader regression test).

- **FV-2 (typecheck) — FIXED.** All 4 `tsc` errors resolved: `journalPath` added to `SlackServiceOpts` + passed at construction (FV-1); `tests/failover/switch-rationale.test.ts` annotated `const rationale: SelectionRationale`; `tests/session/pause-resume.test.ts` typed `kill` as `MockInstance<typeof process.kill>`.
- **FV-1 (D4 stop-summary) — FIXED + live-verified.** `SlackServiceOpts.journalPath` now set from `config.journal.path` (daemon/index.ts). Re-verified live: a real session stop posted `:checkered_flag: Session … ended. • duration: 16s • account switches: 0 • cost: $0.00 • key events: … session.start` — the rich summary, not the plain notice.
- **FV-7 (journal rotation) — FIXED + live-verified.** `config/loader.ts` now returns `journal: { path, max_size_mb }`. Re-verified live: an isolated daemon with `journal.max_size_mb: 0.004` rotated at ~4 KB — `journal.jsonl.1` (4.2 K) + `journal.rotated{rotated_bytes:4226}`. + loader unit regression test.

The 8 lower-severity findings (FV-3…FV-6, FV-8…FV-11) are **not** code-fixed here — documented below for follow-up.

## §4 Findings report

- **FV-2 (medium, process/quality) — the working tree does NOT typecheck; the plan's "tsc --noEmit clean" claim (plan §Verification, 2026-07-01) is false.** `tsc --noEmit` (run directly via `./node_modules/.bin/tsc` to a file, bypassing the RTK output proxy) exits **2** with 4 errors:
  1. `src/slack/service.ts(279,21)` TS2339 — `Property 'journalPath' does not exist on type 'SlackServiceOpts'` (production).
  2. `src/slack/service.ts(280,51)` TS2339 — same (production).
  3. `tests/failover/switch-rationale.test.ts(122,9)` TS2322 — `excluded_reason: string` not assignable to the `CandidateRationale` union.
  4. `tests/session/pause-resume.test.ts(35,5)` TS2322 — `MockInstance` signature mismatch on the `kill` mock.
  The suite (`npm run build` via tsup, `npx vitest run` via esbuild) is green because **neither esbuild path type-checks** — so these errors are invisible to build+test. Repro: `./node_modules/.bin/tsc --noEmit; echo $?` → `2`. **Proposed fix:** add `journalPath?: string` to `SlackServiceOpts` and pass `journalPath: config.journal.path` at the `new SlackService({…})` site (daemon/index.ts:336) — see FV-1; fix the two test type errors. **Note:** the RTK proxy summarized `tsc` output to "No errors found"/"1 error", which is likely how a prior session recorded "clean". Always read tsc output from a file.

- **FV-1 (medium, functional) — D4 stop-thread summary is dead code; every session-stop posts the plain "has ended" notice, never the rich summary. LIVE-CONFIRMED.** `SlackService.onSessionStop` (service.ts:279) gates the summary on `this.opts.journalPath`, but `SlackServiceOpts` has no such field and the construction site (daemon/index.ts:336-344) never passes it — so at runtime `this.opts.journalPath` is `undefined`, the `if` is always false, and `buildStopSummary()` is never called. The correct value exists nearby (`config.journal.path`, used at daemon/index.ts:374 for `getCostView`). The D4 unit test (`tests/slack/stop-summary.test.ts`) only calls the pure `buildStopSummary(EVENTS, id)` formatter directly — it never drives `onSessionStop`, so it cannot catch the dead branch. **Live repro (2026-07-07):** a real `aisup stop --force` of the val-lead session posted exactly `Session \`4455383c-…\` has ended.` — no duration/switches/cost/key-events summary. **Proposed fix:** as FV-2 (add `journalPath?: string` to `SlackServiceOpts`, pass `config.journal.path` at construction).

- **FV-7 (medium, functional) — journal rotation is permanently disabled; `journal.max_size_mb` is dropped by the config loader.** `src/config/loader.ts:484` builds the journal config as `journal: { path: journalPath }`, omitting `max_size_mb`. So the effective `config.journal.max_size_mb` is always `undefined` (neither the config value nor the default 50 survives), and `createJournalWriter(config.journal.path, undefined)` (daemon/index.ts:116) computes `maxBytes = Infinity` → the journal never rotates and grows unbounded. **Repro (live):** daemon with `journal.max_size_mb: 0.004`, drive >4 KB of events → journal reaches 9 KB, no `journal.jsonl.1`, no `journal.rotated`. **Repro (loader):** `loadConfig()` on that config → `journal.max_size_mb === undefined`, while `daemon.log_max_size_mb === 0.004` is preserved. The real `createJournalWriter` rotates correctly when given a finite size, so the writer/D3 unit test are fine — only the loader plumbing is broken. This defeats D3's DoD ("a NON-default `journal.max_size_mb` drives rotation") and leaves the old P-5 GAP open for the journal. **Proposed fix:** `journal: { path: journalPath, max_size_mb: merged.journal.max_size_mb }`.

- **FV-10 (low, doc/CLI mismatch) — `aisup worker cleanup --list` errors; the DoD flag doesn't exist.** The C10 DoD documents `worker cleanup --list/--force`, but the CLI only registers `--force` (`cli/index.ts:258-260`); bare `aisup worker cleanup` is the list path, and `--list` → "error: unknown option '--list'". Functionally fine, but the documented interface is wrong. **Proposed fix:** add a no-op `--list` alias or correct the docs.

- **FV-11 (low, doc-sync) — runbook still says config is not hot-reloadable, contradicting shipped C13.** `docs/runbook.md:429` ("aisup does not hot-reload config. Restart the daemon:") predates C13's `aisup daemon reload`/SIGHUP hot-reload. README line 3 also still calls the HTTP dashboard "the remaining roadmap item" although D1 shipped and TS-003 passed. **Proposed fix:** update the runbook Config-changes section to point at `aisup daemon reload` (noting restart-required keys) and drop the "remaining roadmap" phrasing.

- **FV-8 (low-med, observability) — no Slack notification for a lead-session account switch; C2's "Slack switch message renders the rationale" is unmet.** A real hard-threshold failover (primary→account2) posted the rationale to the journal + `aisup log --details`, but NOTHING posted to the session's Slack channel about the switch. Code grep: the only switch-to-Slack path is `notifyWorkerFailover` (service.ts:327, worker-only); `daemon/index.ts` makes no `slackService` call on `account.switch` completion. The operator watching Slack sees the threshold alert but never a "switched to account2 because hard_threshold" message. **Proposed fix:** add a `notifyAccountSwitch(sessionId, rationale)` Slack post on switch completion, reusing the C2 rationale.

- **FV-9 (low, UX) — session name is only rendered in `aisup status`, not in `log`/`health`/`timeline`.** `aisup start --name "val-lead"` labels the session and `status` shows it, but `aisup log`, `aisup health`, and `aisup session timeline` all print the raw session UUID — contradicting the C11 DoD ("the name shows in `status`/`log`/`health`"). **Proposed fix:** thread the session name into the log/health/timeline renderers.

- **FV-4 (low-med, observability) — `aisup doctor` does not verify live Slack bot scopes; the C5 DoD's "missing Slack scopes" check is not implemented.** `checkSlackInteractivity` (doctor.ts:20) only inspects `config.slack.interactivity_enabled` (config-level) and prints a manual reminder; there is no `auth.test`/scope query. So the operator's actually-missing `files:write` scope (FV-3) is NOT flagged by doctor, even though the plan's C5 DoD and the runbook ("`aisup doctor` flags if missing") claim it is. **Proposed fix:** in doctor, when Slack is enabled and a bot token is present, call `auth.test` and read the `x-oauth-scopes` header (best-effort, host-gated), flagging any of the required scopes (esp. `files:write`) that are absent.

- **FV-5 (low, UX) — pin/exclude account overrides are never surfaced in any account view.** After `aisup accounts --pin/--exclude <name>`, the override is applied (POST `/api/accounts/:name/override` → `setOverride`+`refreshAccounts`, persisted to `account-overrides.json`, CLI dry-run reflects it), but `/api/accounts`, `aisup accounts`, and the Slack `!accounts` (A6) view show the account identically to before — no `pinned`/`excluded`/`override` field. The operator gets zero feedback that a runtime override is in effect (only the raw JSON file shows it). **Proposed fix:** include the override state in `AccountView` and render it in the accounts table + `!accounts` card.

- **FV-6 (low, robustness) — `aisup gate run` crashes with an uncaught `ERR_OUT_OF_RANGE` when a gate omits `timeout_seconds`.** `timeout_seconds` is a required (`number`) field in the gate schema but the loader does not validate its presence; a gate without it reaches `execFile` with `timeout = NaN` → `RangeError [ERR_OUT_OF_RANGE]: The value of "timeout" is out of range … Received NaN` (dist/cli/index.js:2181, `defaultGateRunner`). Contrast the fail-loud handling F-3/F-6 gave sibling config errors. **Proposed fix:** validate `timeout_seconds` at config load (reject with a clear message) or default it in the gate runner.

- **FV-3 (informational → BLOCKED for D4 upload) — bot is missing the `files:write` scope.** Present scopes: `chat:write, groups:write, groups:write.invites, groups:history, groups:read`. D4's large-diff/oversized-command **file upload** (`files.uploadV2`) will fail `missing_scope` until the operator adds `files:write` in the Slack app's OAuth settings and reinstalls. This is exactly what `aisup doctor` (C5) should flag — validated positively in the C5 section.

### Residual GAPs from the 2026-06-26 campaign

- **F5 grant-TTL → PASS (never-expire) + unit (finite).** Never-expire is LIVE-proven: TS-001.2 (45s real dialog) + the canonical 6-min host-gated resolver, no timer fires on the hook path. The A3 sentinel rework (`null` AND `0` never expire; finite `N>0` expires on the fallback) is covered by `tests/permissions/never-expire.test.ts` (in the green suite); the fallback timed-wait was not forced live (matches the 2026-06-26 disposition).
- **P-5 rotation → see D3:** daemon.log rotation LIVE-closed; journal rotation is a live FAIL (FV-7).
- **D6 circuit-breaker, B-2 daemon-crash-mid-worker, B-3 concurrent-failover, P-7/P-8 Slack burst/detector latency → carried forward as documented GAPs** (host-risky or non-deterministic; unit/code-verified in the green suite). B-2 partially re-touched: SIGKILL→restart rehydration works (2026-06-26 A4), and the worker boundary audit correctly rejected a `main_tree_modified` worker this run (bonus X3/G3 re-validation).

## §5 Sign-off matrix

Verdicts this run (against the live system, no mocks). `PASS` = ran the real thing + read real output this session. `PENDING-OP` = staged live, awaiting an operator Slack tap/command (val-1 still running). `GAP` = not forceable this run, reason stated. `FAIL` = real defect (finding).

| Area | Verdict | Evidence / note |
|------|---------|-----------------|
| Preflight env | PASS | node/claude 2.1.203/codex/3 accounts/codex-auth/Slack-token all real-verified |
| Typecheck | **FAIL** | `tsc --noEmit` exit 2, 4 errors (FV-2); build+vitest green (esbuild skips types) |
| TS-001 permission card | **PASS (LIVE)** | card posts (root, Approve/Deny, request_id, no !permit), never-times-out (45s real + 6-min host-gated), tap-Approve resolves the real numbered dialog + card→"Approved by", `permission.granted` |
| TS-001.4/.5 (out-of-order, restart-tap) | GAP | one interactive session blocks on one dialog at a time; id-routing proven by per-card request_id + resolveById (unit) + the live tap resolving by id |
| TS-002 activity feed | **PASS (LIVE)** | edit+bash rows, Read suppressed at normal; operator Expand → modal shows the unified diff / command / `[REDACTED]`; `!notify verbose` → Read row posts |
| A1/A2 card registry + interactivity | PASS | `slack-cards.json` round-trips (0600); no `interactivity_unverified` warning; working tap = interactivity live |
| A3 never-expire + persistence | PASS (persist/clear) / GAP (restart-tap) | `pending-permissions.json` present + cleared on resolve; hook path timer-free; restart-survival-tap not forced |
| A5 verbosity | **PASS (LIVE)** | `!notify verbose` → Read row posts; `!notify silent` → edit posts no row but a Bash still posts a permission card |
| A6 observability parity | **PASS** | `!accounts/!cost/!health/!worker providers` match the CLI at the same state (worker-providers `2594574` exact) |
| A7 worker diff card | **PASS (both paths)** | Approve tap → "Approved & merged"; a stale-patch worker → "apply_conflict" (integrity guardrail); Expand diff + Approve/Deny present |
| A8 threshold alerts | **PASS** | warning/soft/hard each 1 alert (de-dup), account+headroom+ETA, ntfy mirror, real failover |
| B1 F-1/F-2 | PASS | workers-not-enabled msg; `log --json` valid |
| B2 F-3/F-5/F-6 | PASS | gate exit 0/1; ENOENT in stderr_tail; abs worktree_dir fail-loud |
| B3 redact_denied_prompts | PASS | placeholders on security_denied; 0 raw secret bytes |
| B4 docs | PARTIAL | closure/PRD/README ok; runbook hot-reload contradiction (FV-11) |
| C1 overview/health | PASS | one composed `/api/overview`; `aisup health` renders it |
| C2 failover why | PASS (journal+CLI) / gap (Slack, FV-8) | rationale w/ reason_code+candidates+chosen; `log --details` renders; no Slack switch msg |
| C3 tried_candidates | GAP | single-candidate runs; field exists, live population unverified |
| C4 explain + log filters | PASS | bespoke/coverage explain; `--details/--since/--type` filter |
| C5 doctor + port preflight | PASS (gap FV-4) | port-in-use w/ PID + exit 1; <2 accounts; telemetry; occupied-port daemon-start error; no live scope check |
| C6 worker retry | PASS | retry→new worker w/ retry_of; in-flight retry 409 |
| C7 runtime overrides | PARTIAL (FV-5) | exclude/pin/clear persist + apply via daemon API; not shown in views; failover-honor + CB-safety deferred |
| C8 cost breakdown | GAP | `--by` renders but no cost telemetry in isolation |
| C9 pause/resume | PASS (state) | PAUSED↔ACTIVE + signal to correct pid; ps `T` unobservable on macOS (manual STOP identical) |
| C10 cleanup + undo | PASS | cleanup lists/force-removes only orphaned aisup worktrees; undo reverts a clean merge, no auto-commit (FV-10 `--list`; divergence-refusal not cleanly forced) |
| C11 naming + timeline | PARTIAL (FV-9) | name in `status`; `timeline` ordered lifecycle; name absent from log/health |
| C12 worker logs --follow | PASS | streams + exits on terminal; redacted (B3) |
| C13 daemon reload | PASS | applied vs restart-required split; session/daemon survive |
| D1 dashboard guardrails | PASS | body-token exchange, HttpOnly/SameSite cookie, read-only cookie 401 on all control routes, no token in URL |
| D2 ntfy | PASS | real POST for session-start + threshold, read from catcher |
| D3 rotation + health self-check | PARTIAL / **FAIL (journal)** | daemon.log rotates at config; `/api/health` per-loop liveness; **journal rotation dead (FV-7)** |
| D4 stop-summary + upload | **FAIL (FV-1, live-confirmed) / BLOCKED (FV-3)** | real session stop posted the plain "…has ended." notice, never the summary; file upload needs `files:write` |

Rough tally (final): **~34 live PASS**, **0 PENDING-OP**, **5 GAP** (documented: TS-001.4/.5, C3, C8, C10-undo-divergence, + D6/B-2/B-3/P-7/P-8 carried forward), **3 FAIL** (FV-1 live-confirmed, FV-2, FV-7-journal), **1 BLOCKED** (FV-3 files:write). **11 findings (FV-1…FV-11).** Both Priority-0 scenarios (TS-001, TS-002) are **LIVE_PASS**.

## §6 Honest completion statement

**Live-validated this session, with real evidence (no mocks):** the Critical scenario **TS-001** end-to-end (real Claude 2.1.203 permission dialog → real Block Kit card → operator Approve tap → the `y` keystroke resolves the real numbered menu → card updates + `permission.granted`; never-times-out proven at 45s real + 6 min host-gated); **TS-002** meaningful rows + Read-suppression + secret redaction; the full new observability/control CLI (C1, C2, C4, C5, C6, C9, C10, C11-timeline, C12, C13); the dashboard security guardrails (D1); ntfy (D2); daemon.log rotation + health self-check (D3 partial); A8 threshold alerts (warning/soft/hard, de-dup, ntfy) + the real failover it drove (C2); the interactive worker diff card posting (A7); B1/B2/B3 CLI fixes; A1 card registry + A3 persistence. Operator `~/.aisup` config sha + journal mtime:size asserted **byte-unchanged** throughout.

**NOT rounded up.** Three real defects were found that mocked unit tests hid, all still uncommitted: **FV-2** (tree doesn't typecheck — 2 production errors), **FV-1** (D4 stop-summary is dead code), **FV-7** (journal rotation permanently disabled). Plus 8 lower-severity findings (FV-3…FV-6, FV-8…FV-11). 

**Still open (need an operator Slack action; val-1 is left running for this):** TS-002 Expand-modal + `!notify verbose` (A5), A6 observability commands, A7 worker Approve tap. **Documented GAPs (not forceable this run):** TS-001.4/.5 (concurrent/restart-tap), C3 tried_candidates, C8 cost split, C10-undo divergence-refusal, D6/B-2/B-3/P-7/P-8. **Blocked:** D4 file upload (missing `files:write` scope).
