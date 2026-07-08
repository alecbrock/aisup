# aisup — Live Manual Validation of the Final-Completion Feature Set (no mocks, no stubs, no fakes)

**Paste this whole file as the opening prompt of a fresh Claude Code session.** It is self-contained: it tells you what aisup is, what state it is in, exactly what still needs to be proven, the evidentiary standard you must hold, and how to prove each item against the *real* running system.

---

## 0. Mission (read this first, then read it again)

The `2026-06-30-aisup-final-completion.md` implementation plan is **code-complete and its automated suite is green**, but its new features have **only been proven by mocked unit tests plus two live E2E scenarios (dashboard + doctor).** The plan's own verification section honestly marks the two most important operator-facing scenarios — **TS-001 (permission card tap-to-approve, never times out)** and **TS-002 (activity feed → expand-to-diff)** — as `UNIT_VERIFIED`, not `LIVE_PASS`.

Your job: **drive every not-yet-live-validated feature of the final-completion plan against the real, running system — real daemon, real Claude sessions, real codex, real Slack app — read the real output with your own eyes this session, and capture the evidence.** No mocks. No stubs. No fakes. No "the unit test covers it, so it works." A feature is validated only when *you ran the actual thing and saw the actual result in this session.*

Then produce a **results document** (see §9) with a per-check PASS/FAIL/GAP verdict, each PASS carrying the exact command and the real output that proves it.

**Hard rule — this is the whole point of the exercise:** if a feature or mechanism cannot be proven with real, unmocked, end-to-end evidence, it is **NOT** validated. Mark it GAP with the exact blocker; never paper over it. If a *past* validation claimed a pass without real end-to-end evidence (e.g. "code-verified", "unit-tested", "documented"), it does **not** count as validated here — re-do it live or record it as an open GAP with the reason.

**Do NOT commit anything and do NOT run any git write command** (`add`, `commit`, `push`, `stash`, `checkout`, `reset`, …). The entire final-completion changeset — 52 modified + 56 untracked files, including the plan file itself — is uncommitted in the working tree, and the commit decision belongs to the operator. Read git state freely; never write it. If you believe a commit is warranted, say so and stop for the operator.

---

## 1. Read these files before doing anything (contextual sources of truth)

| File | Why you need it |
|------|-----------------|
| `docs/plans/2026-06-30-aisup-final-completion.md` | **The plan under validation.** Every task A0–A8, B1–B4, C1–C13, D1–D4, its Definition-of-Done, its E2E scenarios (TS-001…TS-004), and its 2026-07-01 verification section. This is your backlog's source of truth. |
| `docs/plans/2026-06-26-aisup-FULL-MANUAL-SYSTEM-VALIDATION-RESULTS.md` | **The gold-standard evidentiary bar** and the record of what the *pre-final-completion engine* already had live-validated (96 checks PASS, no mocks). Do not redo what is genuinely PASS here — but note it validated commit `01bfc92`, which predates the entire final-completion plan. |
| `docs/plans/2026-06-26-aisup-FULL-MANUAL-SYSTEM-VALIDATION.md` | The *directive* that produced the above — the methodology, isolation discipline, and check taxonomy you will mirror for the new features. |
| `docs/runbook.md` | Operator runbook: `AISUP_HOME` full-isolation override (§State directory), Slack app setup incl. the **Interactivity toggle** (§Slack App Setup), the never-timeout permission behavior + per-option keystroke mapping (§Permission Resolution), the dashboard token-exchange flow, live gate checklist. |
| `docs/prd/2026-04-29-ai-supervisor.md` | Product intent + the deferment rationale (Feature L dashboard, R-UX-04/R-UX-05 out-of-scope). |
| `docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md` | The applied blocking review — architectural constraints you must not reopen. |
| `CLAUDE.md`, `AGENTS.md` | Repo engineering rules. Note: `~/.claude*`, Slack tokens, codex auth, and Pilot session IDs are **user-local runtime config, not repo content** — verify them, don't invent them. |
| `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` | Prior worker-failover validation + the deferred **Option C** design (do NOT build/validate it — see §8). |

Also skim the older validation plans (`2026-06-17-aisup-full-system-validation.md`, `2026-06-19-*failover*.md`) only to confirm they are superseded by the 2026-06-26 RESULTS doc; do not re-run their checks.

---

## 2. Current state of the world (as of 2026-07-07)

- **Branch `main`**, last commit `fc7678d` (2026-06-30) = the *previous* plan's work. The final-completion plan and all its code are **uncommitted** (working tree). The plan file is untracked.
- **Automated suite is green right now:** `npx vitest run` → 870 pass / 0 fail / 12 skipped; `npx tsc --noEmit` clean (only the pre-existing `tsconfig` `esModuleInterop` deprecation); `npm run build` (tsup) clean. Re-confirm this at the start of your run; do not trust this paragraph.
- **What is already live-validated (DO NOT REDO):** the pre-final-completion *engine* — daemon lifecycle/rehydration, account selection + ledger, proactive + reactive failover (C1–C5, D1–D7), the **text-command** Slack path (`!status`, `!worker status`, `!cmd`+`!confirm`, `!permit`/`!deny` as text), permission broker text path, gates, workers/multi-provider failover (G/PB suites, real codex, approve→merge), statusline, cost, 3-day idle resilience, and the exploit/break-it guards. All captured in the 2026-06-26 RESULTS doc against commit `01bfc92`.
- **What is NOT live-validated (your backlog):** essentially every feature the final-completion plan added — the interactive Slack **card/button/feed** surface (Phase A), the new observability/control **CLI commands** (Phase C), and the **dashboard/ntfy/rotation/stop-summary** work (Phase D), plus the Phase B CLI-behavior fixes. Their only current proof is **mocked unit tests** (`tests/slack/*.test.ts` stub the Slack client with `xoxb-test`; there is no live Slack E2E harness). Dashboard (TS-003) and doctor (TS-004) are the *only* two that got real live E2E on 2026-07-01.

**In one sentence: the engine is battle-tested live; the new remote-control/observability skin on top of it is not. Prove the skin.**

---

## 3. The evidentiary standard (non-negotiable — mirror the 2026-06-26 campaign)

A check is **PASS** only if, *this session*, you:

1. **Ran the real thing** — the real CLI binary, the real daemon (`node dist/daemon/index.js` or `aisup daemon start`), a real Claude/codex session, real Slack API calls. Not a unit test. Not a mock. Not a dry-run standing in for the real path.
2. **Read the real output** — captured the actual stdout / journal event / Slack message / HTTP response / pane content, and it matches the expected behavior exactly (right field, right value — apply the one-character-bug check: would a subtly wrong implementation still produce this output? If yes, your assertion is too weak).
3. **Recorded the evidence inline** in the results doc — the exact command + the real output snippet that proves it.

**Anti-patterns that DO NOT count as validation** (and if a prior doc used them, they are re-opened here): "the unit test passes", "code-verified", "the handler is wired", "documented behavior", "should work", asserting a mock was called, reading only the DOM/config without exercising the live path, or inferring a Slack post happened without reading it back from the channel.

**Critical-review obligation:** for each feature, don't just run the happy path — probe the boundary the plan's DoD names (e.g. two concurrent permission cards resolving out of order by `request_id`, a tap on a *closed* prompt returning `keystroke_unconfirmed`, the dashboard cookie being *rejected* by a control route, `silent` verbosity still letting a permission card through). A feature is "truly validated" only when both its intended path and its guardrail are observed live.

**Operator-state isolation (mandatory every run — from the 2026-06-26 discipline):**
- Record a baseline first: `sha256` of `~/.aisup/config.yaml` and `mtime:size` of `~/.aisup/journal.jsonl`. **Assert both UNCHANGED after every isolated harness run.**
- Run everything isolated: `AISUP_HOME=/private/tmp/aisup-val-<n>`, a dedicated daemon port (the prior campaign used 7397–7405), and a per-run api-token. `AISUP_HOME` relocates aisup state only — set account `config_dir`s and `statusline.directory` explicitly in the throwaway config (see runbook §State directory).
- Live-Slack checks that must post into a real channel are the exception: they touch a real Slack workspace, not the operator's `~/.aisup` — still keep the daemon itself isolated.
- Clean up: no orphaned `node`/`tmux` processes, no leftover `.aisup-worktrees`, remove throwaway channels/sessions you created solely for validation (or note them explicitly).

---

## 4. Environment & preflight (verify — do not assume; these were present 2026-06-26, re-check now)

Run a preflight and record actual values (mirror §2 of the RESULTS doc):

- `node -v`, `claude --version` (**note the exact version — hook detectors F/J and the permission-keystroke mapping are version-sensitive; if newer than last validated, re-verify the hook fires and the per-option keystrokes**), `codex --version`, presence of `tmux jq lsof openssl uuidgen` (`timeout` is absent on macOS — use the Bash-tool timeout).
- `npm run build && npm run typecheck && npx vitest run` — capture the real counts.
- Claude accounts: `~/.claude`, `~/.claude-account2`, `~/.claude-account3` — prove each authed (`claude -p "Reply with exactly: OK"` → exit 0, `OK`). At least 2 authed accounts are needed for failover-adjacent checks.
- codex: `~/.codex/auth.json` present; `CODEX_HOME=~/.codex`.
- **Slack (required for all Phase A live checks):** `AISUP_SLACK_BOT_TOKEN` + `AISUP_SLACK_APP_TOKEN` available (the operator keeps them in `~/.aisup/secrets.env`). The bot needs scopes `chat:write`, `commands`, `channels:manage`/`groups:write`, `chat:write.public`, `files:write`. **The Slack app's "Interactivity & Shortcuts" toggle MUST be ON** (Socket Mode needs no Request URL) — without it, buttons render but taps are never delivered, so every card/button check would silently no-op. Confirm via the Slack app settings and via `aisup doctor`. Set `slack.interactivity_enabled: true` in the test config to match.
- You read Slack results back with the **Slack Web API** using the bot token (`conversations.history`, `conversations.info`, `reactions`/`views` as needed) — this is how you *prove* a card posted, a button updated it in place, and a modal opened. This mirrors the E-suite readback method.

If any prerequisite is genuinely unavailable (e.g. the operator can't flip interactivity right now), record it as a documented BLOCKED with the exact command + output, and continue with everything else — do not silently skip.

---

## 5. Priority-0 checks — the two named scenarios (do these first, most rigor)

These are the plan's own critical/high E2E scenarios currently at `UNIT_VERIFIED`. Prove them `LIVE_PASS`.

### TS-001 — Permission card: tap-to-approve, never times out (Critical)
**Mechanism:** structured `PermissionRequest` hook → `hookPermissions` queue (keyed by `request_id`) → Block Kit card in the channel → button tap → unified broker resolver → `promptStillActive` re-scan → keystroke into the tmux pane. Files: `daemon/index.ts` (`resolveHookPermissionViaKeystroke`), `permissions/{pending-queue,broker,types}.ts`, `slack/{service,blocks,interactions}.ts`.

Prove, live, all of:
1. Start a real supervised session (isolated `AISUP_HOME`, Slack enabled + interactivity ON) that triggers a permission-gated tool (e.g. a `Bash` write). A **Block Kit card** appears in the channel root (not the thread) with tool name, one-line summary, command/diff preview, and `Approve` / `Deny` buttons (plus `Approve for session` **only if** the A0-confirmed "don't ask again" keystroke is set — otherwise it must be correctly *absent*, not guessed). Read the card back via `conversations.history`. **No "type `!permit`" text.**
2. **Never times out:** leave the card untouched for a real, long interval (use the runbook's canonical wait; `AISUP_TEST_LONG_PERMISSION_WAIT_MS=360000` for the host-gated proof of the resolver, ≥5 min). Assert no `permission.keystroke_timeout`/auto-deny event fired and the Claude dialog is still detectable (`PermissionDetector.scan`) at the wait boundary. Then tap `Approve` → card updates in place to "✅ Approved by <user>", session proceeds, journal `permission.granted`.
3. **Safety guard:** on a *closed/gone* prompt, a tap must NOT inject a keystroke — it returns `keystroke_unconfirmed` and the card annotates "prompt no longer active". Force this and observe it.
4. **id-routing:** two concurrent cards with different `request_id`s, tapped **out of order**, each resolve the correct request (not FIFO). Observe both resolve correctly.
5. **Restart survival (A3):** with a card pending, kill -9 the daemon and restart it (same `AISUP_HOME`); tapping the original card re-binds and completes the still-pending request with **no operator re-send**; a genuinely-dead request is annotated, not silently dropped.
6. Run the host-gated resolver test as corroboration (not a substitute): `AISUP_TEST_LONG_PERMISSION=1 npx vitest run tests/permissions/long-permission.hostgated.test.ts`.

### TS-002 — Activity feed: meaningful rows, expandable diff (High)
**Mechanism:** `PostToolUse` hook → `POST /api/hooks/activity` → `onActivityHook` classify → `slackService.postActivity` → threaded rows in the channel's "Activity" thread → `activity_expand` → modal with the unified diff/command. Files: `hooks/claude-hooks.ts`, `daemon/server.ts`, `daemon/index.ts`, `slack/activity.ts`, `slack/service.ts`.

Prove, live, all of:
1. **Confirm the source path first** (plan A4 precondition): does the installed Claude version actually emit `PostToolUse`? Inspect a real session's hook firing. Record which path shipped (hook-primary is what the plan shipped) — if the hook does not fire on this version, that is a real finding, not a pass.
2. Let Claude edit a file and run a bash command → **two compact threaded rows** appear (✏️ edit `path`, ▶️ `command`); a `Read` produces **no** row at `normal` verbosity. Read the thread back via the API.
3. Tap `Expand` on the edit row → a **modal opens with the correct unified diff**; on a bash row, the exact command. Confirm the modal actually opened (view id via API / observed).
4. **Redaction:** a tool input containing a secret (e.g. `export TOKEN=xoxb-…`) is redacted in **both** the row and the modal — read both back and confirm `[REDACTED]`, zero raw secret bytes.
5. `!notify verbose` then trigger a `Read` → a `Read` row now appears; `!notify normal` → it stops again (ties to A5 below).

---

## 6. The full validation backlog (everything the final-completion plan added, proven live)

For each, the pattern is identical: run the real command/flow, read the real result, record evidence, probe the named guardrail. Cross-reference each task's Definition-of-Done in the plan for the exact acceptance bar. **Prefer real daemon + real session + real Slack readback over any test harness.** Where a `.sh`/`.mts` harness from `scripts/validation/` exists and drives real code, reuse it; where none exists for a new feature, drive it by hand against a live isolated daemon.

### Phase A — interactive Slack remote-control (all currently mock-only)
- **A5 verbosity** — `!notify silent|normal|verbose`: `silent` stops feed rows **but a permission card and a threshold alert still post** (prove the exception live); `verbose` makes a `Read` post a row; persists across a daemon restart. Read the channel back each time.
- **A6 Slack observability** — `!accounts` / `!cost` / `!health` / `!worker providers`: each posts real numbers that **match** the corresponding `aisup accounts` / `cost` / `health` / `worker providers` CLI output for the same live state (run both, diff the numbers).
- **A7 worker diff cards** — a real worker reaching `awaiting_approval` posts a card with `Expand diff` (modal shows the **sanitized** patch) + `Approve`/`Deny`; tapping `Approve` merges via the existing integrity-anchored handler and updates the card to the outcome; `Deny` symmetric; `!worker diff <id>` works. Use a real codex/claude worker (reuse the G/PB harness pattern). Confirm the merge actually applied (tree diff) and no auto-commit.
- **A8 threshold alerts** — crossing soft/hard (and `thresholds.warning_pct` if set) pushes **exactly one** Slack alert per band crossing (account + headroom + reset ETA); no spam across repeated ticks. Drive with a synthetic statusline tap (as C2/C3 did) so the daemon's own monitor fires it — do not inject the event.
- **A1/A2/A3** — covered by TS-001 above; additionally confirm the card registry round-trips through `~/.aisup/slack-cards.json` and the interactivity startup probe journals a warning when interactivity is unavailable.

### Phase C — new observability & control CLI (mock/unit only)
Drive each against a live isolated daemon; capture real output:
- **C1** `aisup health` (one-shot unified snapshot) and `aisup watch` (auto-refresh) render `GET /api/overview`; confirm the overview returns session+accounts+workers+cost-today+recent-events in one response.
- **C2** an `account.switch` event carries reason code + per-candidate scores + chosen target; `aisup log --details` and the Slack switch message render the rationale. Force a real switch (manual `failover` and/or a threshold tap) and read it back.
- **C3** an exhausted worker's `status`/API shows `tried_candidates[]` with per-candidate reason (drive a real all-exhausted worker as PB-4 did).
- **C4** `aisup log --details --account X --session Y --since <iso>` filters and shows the details payload; `aisup explain <event_type>` prints a description for a real event type; confirm every event type has a description.
- **C5** `aisup doctor` flags <2 accounts, no telemetry, missing Slack scopes/interactivity, and an occupied port, with non-zero exit on hard failures; `aisup daemon start` with the port occupied prints a **clear** error (not a silent detached exit). (Doctor got a live pass on 2026-07-01 — re-confirm the **port-preflight** and the interactivity/scopes checks specifically, which are the newer parts.)
- **C6** `aisup worker retry <id>` on a real failed/denied worker creates a new QUEUED worker with `retry_of` set and the original task; retrying an in-flight worker is rejected (409). Also Slack `!worker retry`.
- **C7** `aisup accounts --pin/--exclude/--enable/--disable <name>` (and `!account …`) change live selection **without a restart**, persist across restart, and **never override a circuit-breaker-UNAVAILABLE account** (prove the safety case: pin an unhealthy account, confirm it is still not selected). `--clear` resets.
- **C8** `aisup cost --by provider|skill|task` splits correctly against a real cost-emitting session/worker (Claude vs codex); no double-counting of lead vs worker streams.
- **C9** `aisup pause` moves the session to PAUSED and actually SIGSTOPs the runner pid (verify the process state); `aisup resume` SIGCONTs it; **the idle/recovery loops skip PAUSED** (confirm a paused session does not trip a false failover/recovery).
- **C10** `aisup worker undo <id>` reverts a clean approved merge and **refuses on divergence** with clear guidance (prove both); `aisup worker cleanup --list` is read-only, `--force` removes only aisup-created worktrees under `worktree_dir` (never the main workspace).
- **C11** `aisup start --name "X"` labels the session and the name shows in `status`/`log`/`health`/Slack; `aisup session rename`; `aisup session timeline` prints the ordered lifecycle (start → switches → recoveries → stop) for a real session.
- **C12** `aisup worker logs <id> --follow` streams incremental output **during** a running worker (not just post-run) and exits on terminal state; streamed output is **redacted** (drive a secret-bearing worker and confirm no raw secret streams).
- **C13** `aisup daemon reload` (and SIGHUP) applies changed thresholds/intervals/accounts/verbosity **without dropping the active session**; journals `daemon.reloaded` listing applied vs restart-required keys. Prove the session survives.

### Phase D — dashboard + daemon enhancements
- **D1** dashboard — TS-003 got a live browser pass on 2026-07-01. Re-confirm the **security guardrails** live: token is exchanged in-page for a read-only cookie and **never appears in any URL**; `/api/overview` without a valid cookie/bearer → 401; the dashboard cookie is **rejected** by a control route (e.g. `POST /api/failover` → 401). Also confirm it reflects a real failover after one refresh.
- **D2** ntfy — with `notifications.ntfy` enabled against a real (or self-hosted) ntfy topic, a real session-start/threshold/permission event POSTs to the topic; disabled → no POST; a failing POST is journaled, not thrown. Prove with a real HTTP endpoint you can read (not a mock).
- **D3** log rotation + health self-check — set a **non-default** `daemon.log_max_size_mb` and `journal.max_size_mb`, drive enough real output to exceed it, and confirm rotation happens **at the configured size** (this closes the old **P-5 GAP** which was never forced live because it needed >1MB of pane output — force it now). `/api/health` reports per-loop liveness/last-tick; a stalled loop is visible in `health`/overview.
- **D4** stop-thread summary + large-diff file upload — a real session stop posts a summary (duration, account switches, cost-for-session, key events); an oversized diff in the activity/worker flow is delivered as a **file upload** (read it back via `files.list`/the message) rather than a truncated modal.

### Phase B — CLI-behavior fixes (verify the fix live, not just the unit test)
- **B1** — with the daemon up but `workers.enabled:false`, `aisup worker providers` prints "workers not enabled" (not "Daemon not running"); with the daemon down it prints the unreachable message. `aisup log --json` emits valid JSON.
- **B2** — absolute `workers.worktree_dir` → config load prints a clear "must be relative" error to **stderr** and exits non-zero (no blank `daemon.out`); `aisup gate run` exits **1** on failure, **0** on pass; a non-existent gate binary records the ENOENT in `stderr_tail`.
- **B3** — with `workers.security.redact_denied_prompts` on, a `security_denied` task's persisted `prompt`/`title` are placeholders; off (default) → unchanged. Drive a real security-denied worker.
- **B4** — docs-only bookkeeping; verify by inspection that the closure plan / PRD / README / runbook reflect reality (no live run needed) and record it as such.

### Residual GAPs from the 2026-06-26 campaign to close where they now overlap new work
The prior campaign left 4 documented GAPs. Re-attempt the ones the final-completion plan touches, to the live standard:
- **F5 grant-TTL** → now governed by A3's `grant_ttl_seconds: null` (never-expire) semantics. Prove: `null` (default) AND `0` both never expire; a finite `N>0` still expires after N seconds on the fallback path.
- **P-5 rotation** → now D3 (above) — force it live.
- **D6 circuit-breaker**, **B-2/B-3** (daemon-crash-mid-worker / concurrent-failover races), **P-7/P-8** (Slack burst-dedup / detector latency), **B-5/B-6/B-9** (disk-full/clock-skew/socket-storm): attempt if safely forceable; otherwise carry them forward as documented GAPs with the exact reason (some are host-risky or non-deterministic — that is an acceptable *documented* GAP, not a silent skip).

---

## 7. What is already live-validated — do NOT re-run (reference, don't repeat)

Per `docs/plans/2026-06-26-aisup-FULL-MANUAL-SYSTEM-VALIDATION-RESULTS.md` (commit `01bfc92`, no mocks, captured evidence): Suite A daemon/infra A1–A7, I journal/CLI I1–I3, B account-select B1–B5, C proactive failover C1–C5, D reactive recovery D1–D5/D7, E lead-session/Slack **text path** E1–E12, F broker F1–F4/F6 (text path), J skill propagation J1–J3, H gates H1–H2, G/PB workers+multi-provider G1–G6/PB1–PB5, K cost K1, ST statusline ST1–ST2, X exploits X1–X11, Break-it B-1/B-4/B-7/B-8, Perf P-3/P-4 + 3-day idle.

**Caveat that defines your scope:** all of the above validated the **text-command** Slack surface and the **pre-final-completion** engine. The final-completion plan replaced the permission/worker text prompts with **interactive cards/buttons** and added the **activity feed, the new C* CLI commands, and the dashboard/ntfy/rotation** — none of which existed at `01bfc92`. So a prior "E/F suite PASS" does **not** transfer to the new button path. Validate the new surfaces fresh.

---

## 8. Deferments — explicitly DO NOT build or validate these (out of scope)

Confirm they remain unbuilt (a quick grep is fine); do not implement or test them:
- **Option C — in-aisup orchestration/workflow subsystem** (durable phase graph, read-only workers, coordinator edit-scope enforcement). Deferred to its own future PRD + plan. Design preserved in `docs/plans/2026-06-22-…closure-validation.md`. The final-completion plan deliberately left only latent seams (`roles.orchestrator`, the activity hook, the worker store) — confirm no conductor logic was added (the 2026-07-01 seam audit found none).
- **R-UX-04 — multi-session supervision.** Single-session is a deliberate Phase-1 boundary; not built.
- **R-UX-05 — launchd/systemd auto-start.** Explicitly out-of-scope in the PRD ("user-controlled lifecycle"). Do-not-build.

If during validation you find any of these were *partially* built, that is a finding — report it; do not extend it.

---

## 9. Output — the results document you must produce

Create `docs/plans/2026-07-07-aisup-final-completion-LIVE-VALIDATION-RESULTS.md` (mirror the structure of the 2026-06-26 RESULTS doc):

1. **Preflight & environment** (§4 values, recorded this run — real versions, real auth checks, real suite counts).
2. **Operator-state isolation baseline** (config sha256 + journal mtime:size) and a closing assertion that it is byte-unchanged.
3. **Results by area** — one entry per backlog item in §5/§6, each with: **verdict** (PASS / FAIL / GAP / BLOCKED), the **exact command(s)**, the **real output evidence** (journal event, Slack message read-back, HTTP response, pane capture), and — for the guardrail probes — the negative-case evidence.
4. **Findings report** — every bug/leak/degradation you hit, with repro + severity + proposed fix (mirror the F-* format). A feature that fails is a finding, not a footnote.
5. **Sign-off matrix** — per-area PASS/FAIL/GAP counts, like §8 of the 2026-06-26 doc.
6. **Honest completion statement** — what is now live-validated with real evidence, and an explicit list of any remaining GAPs with the exact reason each was not closed. If anything is still only unit/mock/code-verified, say so plainly — do not round up to "100% validated."

Update the final-completion plan's `## Verification` section: flip TS-001/TS-002 to `LIVE_PASS` **only** with real evidence, and append a pointer to this results doc.

---

## 10. Guardrails (repeat, because they matter)

- **No git writes. No commit.** The whole changeset is uncommitted; the commit is the operator's decision. Stop and tell them when validation is complete.
- **No mocks/stubs/fakes count as validation.** Real thing, real output, this session, or it's a GAP.
- **Isolate every run** (`AISUP_HOME` + dedicated port + per-run token); assert operator `~/.aisup` state unchanged after each.
- **Never invent values** — account names, ports, tokens, event names, keystrokes, file paths must be read from the code/config/live system or the operator, never guessed. If the "Approve for session" keystroke or the `PostToolUse` availability can't be confirmed on the installed Claude version, that is a documented finding, not a guess.
- **Fix-forward is out of scope unless asked** — you are validating, not implementing. If a check fails, record the finding and its proposed fix; do not silently patch production code mid-validation unless the operator directs it. (If you do fix a blocking defect to unblock further validation, document the deviation and keep it minimal.)
- **Critically review, don't rubber-stamp.** For every mechanism, ask "what would a subtly-broken version still pass, and did I rule that out?" If you didn't rule it out, the check isn't done.

**Begin by reading §1's files and running the §4 preflight. Then do §5 (TS-001, TS-002) with maximum rigor, then work §6 top to bottom. Produce §9. Do not commit.**
