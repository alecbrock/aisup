# aisup Final Completion — Slack Remote-Control, Observability, Phase 4 Implementation Plan

Created: 2026-06-30
Author: alec.m.brock@gmail.com
Agent: Claude Code
Status: COMPLETE
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

> The single, consolidated "road to 100%" plan. It absorbs every documented-but-unbuilt item so planning
> stops sprawling across files: PRD Phase 4, the user-perspective UX/R-UX feature set, the F-* adversarial
> findings, the closure-plan reconciliation, and the NEW Slack remote-control redesign. Execution is phased
> (A → D) and expected to span multiple sessions. The plan file is the source of truth.

## Summary

**Goal:** Bring aisup to 100% of its PRD-defined scope by redesigning the Slack control plane to mirror Claude Code's Remote Control feature (per-action permission cards with Approve/Deny buttons that never time out, plus a constant clickable activity feed), closing every deferred UX gap and F-* finding, and shipping PRD Phase 4 (read-only mobile dashboard + daemon enhancements).

## Out of Scope

- **Option C — in-aisup orchestration/workflow subsystem** (durable phase graph, read-only workers, coordinator edit-scope enforcement). Operator decision (2026-06-23, re-confirmed 2026-06-30): stays deferred to its **own future PRD + plan + spec**. The detailed design is preserved in `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` (Check 6 + "Option C — detailed design"). This plan adds NO orchestration code; it only leaves clean seams (the latent `roles.orchestrator`, the activity-feed hook, the worker store) that the future phase reuses.
- **R-UX-04 — multi-session supervision.** The single-session predicate (`cli/pid.ts:71`, `getActiveSession()` singular) is a deliberate Phase-1 architectural boundary. Lifting it is a large change with its own PRD; not built here.
- **R-UX-05 — launchd/systemd auto-start.** Explicitly OUT OF SCOPE in the PRD (`prd:105,203`) — "user-controlled lifecycle." Recorded as a do-not-build item.
- **Replacing tmux/pane I/O.** The runner-in-tmux + `pipe-pane` model and the keystroke-to-pane resolution are kept; the redesign layers structure on top, it does not re-architect session I/O.

## Approach

**Chosen:** Layer a structured, interactive Slack surface on top of the EXISTING daemon primitives — the structured `PermissionRequest` hook (`daemon/server.ts:291`), the per-session pending-permission FIFO (`permissions/pending-queue.ts`), the localhost `/api/*` read endpoints, and the journal event stream — and add the missing observability/control CLI + the read-only HTTP dashboard around the same data.

**Why:** Every Claude-app-like capability the operator wants already has a latent data source in aisup (structured tool input via the hook; tool activity via a `PostToolUse` hook; account/cost/worker state via `/api/*`). The work is surfacing and wiring, not re-architecting — which keeps the large scope tractable and low-risk. The cost is breadth (≈30 tasks across 4 phases), which is why the plan is explicitly phased and multi-session. A blocking-HTTP-hook permission model was rejected because it cannot satisfy the hard "permission prompts must never time out" requirement — Claude's terminal dialog blocking indefinitely + keystroke resolution does.

## Context for Implementer

Three cross-cutting facts every phase depends on:

1. **Permission resolution is keystroke-to-pane, not HTTP-blocking — and there are TWO divergent resolvers today that Phase A must UNIFY.** The `PermissionRequest` hook returns `null` (defers), so Claude's terminal dialog blocks indefinitely. A Slack `!permit`/`!deny` (and the new buttons) drives `onPermissionGrant`/`onPermissionDeny` (`daemon/index.ts:319-322`). That calls **`resolveHookPermissionViaKeystroke` (`daemon/index.ts:294`) → `sendPermissionKey` (`daemon/index.ts:287`)** which dequeues FIFO from `hookPermissions` (a `PendingPermissionQueue`) and sends the key checking only session *status* — **it does NOT re-scan `promptStillActive`, has no `request_id`, no TTL, and no persistence.** The `promptStillActive` re-scan + TTL live ONLY in the legacy fallback `PermissionBroker` (`daemon/index.ts:687-692`, `broker.ts:81`), which is reached only when the hook queue is empty. **The Slack button path is the hook path** — so the safety guard, id-routing, and restart-survival work (A2/A3) must be applied to `resolveHookPermissionViaKeystroke`/`hookPermissions`, ideally by routing both paths through a single broker-owned resolver. Note the hook path already has NO timer, so "never times out" is already true there; the real gaps are the missing re-scan guard, id-routing, and persistence. The `tool_input` from the hook (`server.ts:291-320`) is the rich data for the card.
2. **Slack interactivity is a one-time Slack-app config step.** `@slack/bolt` in Socket Mode (`slack/service.ts:90`) already receives `block_actions`/`view_submission` payloads — but the app's "Interactivity & Shortcuts" toggle must be ON in the Slack app settings (no Request URL needed in Socket Mode). `doctor` (Task C5) checks for it; the runbook documents enabling it.
3. **One feed thread per session.** The activity feed and the session-info root message live in the session's existing private channel (`slack/service.ts:onSessionStart`). Feed rows post as threaded replies to a pinned "Activity" root so the channel root stays readable; permission cards post to the channel root (not the thread) so they are never missed.

## Runtime Environment

- **Start daemon:** `aisup daemon start` (background, detached). Health: `GET http://127.0.0.1:<daemon.port>/api/health` (default port `7394`, `config.daemon.port`).
- **Restart after code change:** `aisup daemon stop && npm run build && aisup daemon start`.
- **Dashboard (Phase D):** `http://127.0.0.1:<daemon.port>/dashboard` once Task D1 lands (paste the token into the page — never in the URL; see D1).
- **Host-gated Slack tests:** require `AISUP_TEST_SLACK=1` + bot/app tokens; pure unit tests must run without them.

## Assumptions

- **`PostToolUse` hook availability is UNCONFIRMED and resolved at implementation time, not assumed.** Task A4 confirms whether the target Claude version emits `PostToolUse` (`tool_name`/`tool_input`/`tool_response`) and picks the source path accordingly: hook-primary if present, transcript-`.jsonl`-tail-primary if absent. The plan does not depend on the hook existing — only on one of the two paths working (the transcript always exists). Task A4 is the gate.
- **The "dialog blocks indefinitely" claim is UNVERIFIED for long waits and is proven by Task A0 before A2/A3 build on it.** Today's keystroke path proves resolution works for short interactive waits, not hours-long ones; A0 is the host-gated test that measures the actual persistence window and records the per-option keystroke. If A0 disproves indefinite blocking, A2/A3 inherit A0's documented pivot (re-issue the decision on tap).
- The operator's Slack app can be granted `chat:write`, `commands`, `channels:manage`/`groups:write`, `chat:write.public`, `files:write`, and interactivity — Tasks A1/A4/A7/D4 (modals via `views.open`, file upload) depend on the bot scopes; `doctor` (C5) surfaces missing scopes/interactivity.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A never-expiring pending permission leaks memory / blocks the session forever if Claude's dialog silently closes | Medium | Medium | Task A2 ADDS the re-scan-before-keystroke guard to the hook path (today only the fallback broker has it, `broker.ts:81`): a tap on a closed prompt returns `keystroke_unconfirmed` and the card updates to "prompt no longer active"; pending set is bounded per-session and cleared on session stop (`pending-queue.ts:clear`). |
| `PostToolUse` feed is too chatty and trips Slack rate limits | Medium | Medium | Task A4/A5: default verbosity = meaningful actions only; coalesce bursts; reuse the existing rate-limit backoff + `slack.rate_limited` journal path (`service.ts:584`). |
| Block Kit button `action_id` collisions across concurrent cards resolve the wrong request | Low | High | Tasks A1/A2: every card carries an opaque `request_id` in the button `value`; the `app.action` handler resolves by id against the `hookPermissions` queue via the unified resolver, never by session alone. |
| Stale cards after a daemon restart point at gone state | Medium | Medium | Task A3: pending permissions + their channel/ts persist under `~/.aisup`; on rehydrate, re-bind is SEAMLESS — tapping the original card resolves the still-pending request with no operator re-send; a genuinely-dead request is annotated, never silently dropped. |

## Goal Verification

### Truths

1. The operator can approve or deny any Claude permission request entirely by tapping a Slack button — never by typing `!permit`/`!deny` — and a request left untouched for hours is still resolvable (never auto-expires or auto-denies on a timer).
2. While a supervised session runs, the operator sees a live Slack feed of Claude's meaningful actions (edits, commands, task/skill milestones) and can open any row to read the exact command or unified diff.
3. Running `aisup doctor` on a fresh, mis-configured host reports every real readiness gap (no telemetry, <2 accounts, missing Slack scopes/interactivity, daemon port in use) instead of passing silently.

## E2E Test Scenarios

### TS-001: Permission card — tap-to-approve, no timeout
**Priority:** Critical
**Preconditions:** Daemon running, Slack enabled + interactivity ON, a supervised session that triggers a tool needing permission (e.g. a `Bash` write).
**Mapped Tasks:** A1, A2, A3
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Trigger a permission-gated tool in the session | A Block Kit card appears in the channel: tool name, one-line summary, command/diff preview, `Approve` / `Approve for session` / `Deny` buttons. No `!permit` instructions shown. |
| 2 | Wait several minutes without acting | Card remains active; no auto-deny; journal shows no `permission.keystroke_timeout`; Claude's dialog still open. |
| 3 | Tap `Approve` | Card updates in place to "✅ Approved by <user>"; the session proceeds; journal `permission.granted`. |

### TS-002: Activity feed — meaningful rows, expandable diff
**Priority:** High
**Preconditions:** Running session, verbosity `normal`.
**Mapped Tasks:** A4, A5
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Let Claude edit a file and run a bash command | Two compact rows appear in the channel's Activity thread (✏️ edit `path`, ▶️ `command`); a `Read` does NOT post a row at `normal`. |
| 2 | Tap `Expand` on the edit row | A modal opens showing the unified diff for that edit. |
| 3 | Send `!notify verbose` then trigger a `Read` | A `Read` row now appears in the thread. |

### TS-003: Read-only mobile dashboard
**Priority:** High
**Preconditions:** Daemon running with a valid `~/.aisup/api-token`.
**Mapped Tasks:** D1, C1
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open `http://127.0.0.1:<port>/dashboard`, then poll `/api/overview` with no/invalid credential | Shell loads but data fetch returns 401; no session data renders. |
| 2 | Paste the valid token into the shell (exchanged for a read-only cookie) | Page renders: active session + account, per-account headroom grid, worker queue, recent events, cost-today; auto-refreshes; the token never appears in the URL. |
| 3 | Trigger a failover, wait one refresh | Dashboard reflects the new active account and a new `account.switch` event without a manual reload. |

### TS-004: doctor catches readiness gaps
**Priority:** High
**Preconditions:** A deliberately mis-configured host (one account, no telemetry, daemon port occupied).
**Mapped Tasks:** C5
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Occupy `config.daemon.port`, then run `aisup doctor` | Output flags: `<2 accounts`, `no telemetry in statusline.directory`, `port <n> already in use`, plus Slack scope/interactivity status; non-zero exit. |
| 2 | Run `aisup daemon start` with the port occupied | A clear "port in use" error is printed (not a silent detached exit). |

## Progress Tracking

**Phase A — Slack Remote-Control Redesign (operator priority)**
- [x] A0: Verify the never-timeout keystroke-resolution assumption (host-gated, de-risks all of Phase A)
- [x] A1: Slack interactivity foundation (Block Kit + app.action/app.view + card store)
- [x] A2: Structured permission cards with Approve / Approve-for-session / Deny buttons
- [x] A3: Never-expire pending permissions + restart survival
- [x] A4: Live activity feed (PostToolUse hook → threaded rows → expand-to-diff modal) — SHIPPED source path: **hook-primary** (PostToolUse → `/api/hooks/activity`). Transcript-`.jsonl`-tail = documented follow-up (see `claude-hooks.ts`).
- [x] A5: Notification verbosity control (`!notify silent|normal|verbose`)
- [x] A6: Slack observability parity (`!accounts` `!cost` `!health` `!worker providers`) (UX-02)
- [x] A7: Worker diff preview + approve/deny buttons in Slack (UX-06)
- [x] A8: Proactive threshold/budget Slack alerts + `warning_pct` band (UX-05)

**Phase B — Adversarial F-* findings + closure reconciliation**
- [x] B1: CLI surface fixes — F-1 (workers-disabled vs daemon-down) + F-2 (`log --json`)
- [x] B2: Gate/config robustness — F-3 (worktree_dir fail-loud) + F-5 (gate exit code) + F-6 (ENOENT surfaced)
- [x] B3: F-4 — optional prompt/title redaction for security-denied worker tasks
- [x] B4: Closure-plan reconciliation (tick Task 13, record F-1..F-7 disposition, PRD/docs sync)

**Phase C — Operator observability & control**
- [x] C1: UX-01 — `aisup watch` / `aisup health` unified live view + `/api/overview`
- [x] C2: UX-03 — failover "why" explainability (reason codes + candidate scores)
- [x] C3: UX-04 — worker failure transparency (`tried_candidates[]`)
- [x] C4: UX-07 — `aisup log --details`/filters + `aisup explain <event>`
- [x] C5: UX-08 — onboarding/doctor guardrails + daemon port preflight
- [x] C6: UX-09 — `aisup worker retry <id>` + Slack `!worker retry`
- [x] C7: UX-10 — runtime account control (`accounts --pin/--exclude/--enable/--disable`)
- [x] C8: UX-11 — cost breakdown by skill / task-type / provider
- [x] C9: UX-13 — `aisup pause` / `aisup resume` (PAUSED state)
- [x] C10: UX-14 — worker merge undo/revoke + `worker cleanup --list/--force`
- [x] C11: UX-15 — session naming/labels + `aisup session timeline`
- [x] C12: R-UX-01 — live worker progress (`worker logs <id> --follow`)
- [x] C13: R-UX-02 — hot config reload (`aisup daemon reload` / SIGHUP)

**Phase D — PRD Phase 4 (dashboard + enhancements)**
- [x] D1: Minimal read-only HTTP mobile dashboard (Feature L, token auth)
- [x] D2: ntfy notification fallback
- [x] D3: Daemon log rotation + health self-check (closes P-5 GAP)
- [x] D4: Enhanced Slack residue (stop-thread summary, large-diff file upload)

## Implementation Tasks

---

### Task A0: Verify the never-timeout keystroke-resolution assumption (host-gated)

**Objective:** De-risk the foundational assumption that ALL of Phase A rests on before any UI is built: that Claude's terminal permission dialog blocks indefinitely (no client-side timeout) and is still answerable by a keystroke many minutes/hours later. This is the single largest unknown — if Claude's dialog self-closes after N minutes, the entire keystroke-resolution model must change. Prove it with a host-gated end-to-end test and document the observed behavior; the result is a precondition gate for A2/A3.

**Files:**
- Create: `tests/permissions/long-permission.hostgated.test.ts` (gated by `AISUP_TEST_LONG_PERMISSION`)
- Modify: `docs/runbook.md` (record the measured dialog-persistence behavior + the keystroke that answers each dialog option)

**Key Decisions / Notes:**
- The test must exercise the **actual Slack-button resolution path** — `onPermissionGrant`/`onPermissionDeny` → `resolveHookPermissionViaKeystroke` (`daemon/index.ts:294`) → `sendPermissionKey` — NOT only the legacy `PermissionBroker.resolveFromSlack`. Codex flagged that A0 could otherwise pass against the wrong resolver while the real button path is unguarded.
- The test: start a supervised session with a permission-gated tool, capture the pane showing the open dialog, wait a configurable interval (default 5+ min, overridable), then drive the hook resolver and assert the session proceeds; separately assert the dialog is still detectable (`PermissionDetector.scan`) at the wait boundary.
- **Pivot recorded if disproven:** if the dialog self-closes, the fallback is to re-issue the permission decision on button tap (the hook is re-invoked) rather than relying on a persistent dialog; A2/A3 inherit whichever model A0 proves. Document the chosen model in the runbook.

**Definition of Done:**
- [ ] The host-gated test drives the real hook resolution path (not just the broker) and demonstrates a dialog left open ≥5 min is still resolvable by keystroke (or, if disproven, documents the actual timeout window + records the pivot in the runbook + A2/A3 notes).
- [ ] The keystroke for each dialog option (approve / approve-and-don't-ask / deny) is observed and recorded (feeds A2's button mapping — do not guess).
- [ ] Verify: `AISUP_TEST_LONG_PERMISSION=1 npx vitest run tests/permissions/long-permission.hostgated.test.ts` (host-gated; the always-run suite skips it).

---

### Task A1: Slack interactivity foundation

**Objective:** Add the Block Kit + interactivity plumbing the rest of Phase A builds on: register NEW `app.action()` and `app.view()` handlers in `SlackService` (today only `app.message()` is registered — `service.ts:91`; these are net-new handler registrations, not edits to existing routing), a small Block Kit builder module, an in-memory + persisted "interactive card" store keyed by opaque `request_id`, and config + doctor surfacing for the required Slack-app interactivity toggle.

**Files:**
- Create: `src/slack/blocks.ts` (Block Kit builders: permission card, activity row, expand modal, status blocks)
- Create: `src/slack/interactions.ts` (card registry: request_id → {channel, message_ts, kind, payload}; persisted to `~/.aisup/slack-cards.json`, 0600)
- Modify: `src/slack/service.ts` (register `app.action`/`app.view`; `ack()` fast; route by `action_id`)
- Modify: `src/config/schema.ts` (`SlackConfig.interactivity_enabled: boolean`) + `src/config/defaults.ts`
- Test: `tests/slack/interactions.test.ts`

**Key Decisions / Notes:**
- The handler registration is NEW code: add `app.action(/^perm_/, …)`, `app.action(/^worker_/, …)`, `app.action(/^activity_/, …)`, and `app.view(…)` blocks alongside the existing `app.message` registration in `start()` (`service.ts:90-98`). Each handler: `await ack()` first (<3s), then dispatch async by `action_id`.
- Every interactive element carries `value = request_id` (opaque uuid); handlers resolve by id against the registry, never by channel/session alone (collision risk — see Risks).
- Card registry persists so Task A3 (restart survival) and Task A2 (resolve-after-hours) work; mirror the 0600 + atomic-write pattern in `service.ts:saveChannelMap` (`service.ts:526`).
- Modals use `views.open` with the `trigger_id` from the button payload (valid ~3s) — open immediately in the handler, populate from the registry.
- `interactivity_enabled` is a CONFIG flag (what aisup expects the Slack app to support), NOT the live Slack-side state. Add a startup pre-check: on `start()`, journal a `slack.interactivity_unverified` warning if a trivial interactive capability probe fails, so button routing never fails silently; `doctor` (C5) consumes this.

**Definition of Done:**
- [ ] A Block Kit message with a button posts and its NEW `app.action` handler fires, ack'd <3s, and routes by `action_id` to the correct `request_id` (test drives a synthetic `block_actions` payload through the handler).
- [ ] Card registry round-trips through `~/.aisup/slack-cards.json` (write → reload → same entries).
- [ ] `interactivity_enabled` defaults true and is read by the service; the startup probe journals a warning when interactivity is unavailable; unit tests cover the builders' block shape.
- [ ] Verify: `npx vitest run tests/slack/interactions.test.ts tests/slack/blocks.test.ts -q`

---

### Task A2: Structured permission cards with Approve / Approve-for-session / Deny buttons

**Objective:** Replace the plain-text `!permit`/`!deny` permission prompt (`service.ts:250-260`) with an interactive Block Kit card built from the structured hook `tool_input`: tool name, a one-line summary, a command/diff preview, and `Approve` / `Approve for session` / `Deny` buttons. A button tap resolves the matching queued request via the existing keystroke path and updates the card in place to show the outcome and who decided.

**Files:**
- Modify: `src/permissions/types.ts` (add `request_id: string` to `PermissionRequest` — the opaque id every card/queue entry is keyed by)
- Modify: `src/permissions/pending-queue.ts` (store `request_id` per entry; add `resolveById(sessionId, requestId): PermissionRequest | null` that removes by id, keeping `dequeue` FIFO as the id-missing fallback)
- Modify: `src/daemon/index.ts` (the resolution unification — see Key Decisions: `resolveHookPermissionViaKeystroke:294` resolves by `request_id` AND gains the `promptStillActive` re-scan that `sendPermissionKey:287` lacks today; `onPermissionHook:337` generates the `request_id`, enqueues it, passes it to the card)
- Modify: `src/permissions/broker.ts` (extend the broker to own a single guarded resolver both the hook path and the legacy `resolveFromSlack` call, so `promptStillActive` + id-routing + keystroke live in ONE place)
- Modify: `src/slack/service.ts` (`notifyPermissionRequest` → post card via `blocks.ts`; new action handlers `perm_approve`/`perm_approve_session`/`perm_deny` calling the unified resolver with the `request_id`)
- Test: `tests/permissions/broker.test.ts` (extend), `tests/daemon/hook-permission-resolve.test.ts`, `tests/slack/permission-card.test.ts`

**Key Decisions / Notes:**
- **Unify the resolver (Codex must-fix):** today the Slack button path uses `resolveHookPermissionViaKeystroke`/`sendPermissionKey` (`daemon/index.ts:287-305`) which has NO `promptStillActive` re-scan, while the broker (`broker.ts:81`) does. Route hook resolution through the broker's guarded resolver (or give the hook resolver the identical `promptStillActive`-then-`sendKeystroke` sequence) so a button tap NEVER injects a keystroke into a closed/different prompt. This closes a real safety hole, not just a UI change.
- `request_id` is generated at hook time (`crypto.randomUUID`) in `onPermissionHook` and threaded through `hookPermissions` and the card `value`; `resolveById` removes that specific entry so out-of-order taps resolve correctly. FIFO `dequeue` remains only as the fallback for an id-less legacy `!permit`.
- `Approve for session` uses the A0-observed "don't ask again" keystroke (config field `permissions.approval_session_key`); if A0 could not confirm it OR the field is unset, the card ships with Approve/Deny only (don't guess the keystroke — Never-invent-values). The third button is therefore CONDITIONAL on A0's result.
- Card preview uses `summarizeToolInput` (`index.ts:340`) for the one-liner; full command/diff goes to the Expand modal (shared with A4's renderer) to keep the card compact and within Block Kit's text limits.
- The legacy `!permit`/`!deny` text commands stay wired as a hidden fallback (do not remove; remove only from `!help`).

**Definition of Done:**
- [ ] A permission-gated tool posts a card with Approve/Deny buttons (plus `Approve for session` ONLY when A0 confirmed its keystroke) and no "type `!permit`" text.
- [ ] Tapping `Approve` resolves via the unified resolver: it sends the approval keystroke ONLY after a `promptStillActive` re-scan confirms the dialog is still open (the hook path gains this guard), then updates the card to "✅ Approved by <user>"; `Deny` symmetric; journal `permission.granted`/`permission.denied`. A test asserts no keystroke is sent when `promptStillActive` is false.
- [ ] Two concurrent permission cards with different `request_id`s resolve independently to the correct request when tapped out of order (test asserts id-routing on the hook queue, not FIFO).
- [ ] Verify: `npx vitest run tests/permissions/broker.test.ts tests/daemon/hook-permission-resolve.test.ts tests/slack/permission-card.test.ts -q`

---

### Task A3: Never-expire pending permissions + restart survival

**Objective:** Guarantee a permission request never auto-expires or auto-denies on a timer (operator may take hours), and that pending cards survive a daemon restart. Rework `grant_ttl_seconds` into an opt-in bound that defaults to "never," and persist pending permission state (request + channel/message_ts) so rehydration can re-bind or annotate stale cards.

**Files:**
- Modify: `src/permissions/pending-queue.ts` (persist `hookPermissions` to `~/.aisup/pending-permissions.json` incl. `request_id` + channel/message_ts; load on construct)
- Modify: `src/daemon/index.ts` (wire the persisted queue; the hook path `resolveHookPermissionViaKeystroke:294` is already timer-free — assert and keep that property)
- Modify: `src/config/schema.ts` (`PermissionsConfig.grant_ttl_seconds: number | null` → `null`/absent = never expire; document that `0` is NOT a sentinel) + `src/config/defaults.ts` (default `null`)
- Modify: `src/permissions/broker.ts` (fix the FALLBACK-path TTL check at `broker.ts:62-66` — defense in depth)
- Modify: `src/daemon/rehydration.ts` (on restart, reconcile pending permission cards: re-bind live, annotate dead)
- Test: `tests/permissions/never-expire.test.ts`, `tests/daemon/rehydration.test.ts` (extend)

**Key Decisions / Notes:**
- **The hook path (real Slack-button path) already has NO timer** — `resolveHookPermissionViaKeystroke`/`hookPermissions` never expire (`daemon/index.ts:294-305`), so "never times out" is already true there. The main A3 work is PERSISTING that queue across restart, not removing a timer.
- **Fallback TTL sentinel fix (defense in depth, must-fix from review):** the legacy broker check `if (now - detectedAt > ttlMs)` with `ttlMs = grant_ttl_seconds * 1000` fires IMMEDIATELY when `grant_ttl_seconds === 0` (`age > 0` always true). So `0` must NOT mean "never." Use `null`/absent as the unbounded sentinel and guard explicitly: `const ttl = deps.permissions.grant_ttl_seconds; if (ttl !== null && ttl > 0 && now - detectedAt > ttl * 1000) { …timeout… }`. Default `null`. This guarantees the fallback path can't silently expire either.
- The only thing that resolves a pending request is a button tap, session stop (`pending-queue.ts:clear`), or the dialog genuinely closing (re-scan returns inactive → card annotated, not denied — never a timer).
- Bound the pending set per session to avoid unbounded growth from a runaway agent; on overflow, journal a warning rather than auto-deny.
- Restart reconciliation reuses the worker HI-003 rehydration pattern referenced in the closure plan — completed stay completed, in-flight re-bind. Re-bind is SEAMLESS: tapping a post-restart card resolves the still-pending request without the operator re-sending anything.

**Definition of Done:**
- [ ] On the hook path, a pending permission left untouched for a simulated long interval is still resolvable; NO timer-based expiry/auto-deny fires.
- [ ] On the fallback path, `grant_ttl_seconds: null` (default) AND `: 0` both never expire; a finite `N>0` still expires after N seconds (the bounded path still works).
- [ ] `hookPermissions` state round-trips through disk; after a simulated daemon restart, tapping an unresolved card re-binds and completes the original request with no operator re-send; a dead request is annotated (not silently dropped).
- [ ] Verify: `npx vitest run tests/permissions/never-expire.test.ts tests/daemon/rehydration.test.ts -q`

---

### Task A4: Live activity feed (PostToolUse hook → threaded rows → expand-to-diff modal)

**Objective:** Give the operator a constant feed of what Claude is doing. Add a `PostToolUse` hook that POSTs structured tool activity to a new `/api/hooks/activity` endpoint; the daemon forwards meaningful actions to `SlackService`, which posts compact rows as replies in the session channel's "Activity" thread. Each row has an `Expand` button opening a modal with the full command (Bash) or unified diff (Edit/Write/MultiEdit).

**Files:**
- Modify: `src/hooks/claude-hooks.ts` (`buildHookSettings`: add `includeActivity` → `PostToolUse` → `/api/hooks/activity`)
- Modify: `src/daemon/server.ts` (new `POST /api/hooks/activity`; validate shape/size like `/api/hooks/permission:291`; callback `onActivityHook`)
- Modify: `src/daemon/index.ts` (wire `onActivityHook` → classify meaningful vs noise → `slackService.postActivity`)
- Create: `src/slack/activity.ts` (classification + row/diff rendering; ANSI-free; redaction via existing `redactSecrets`)
- Modify: `src/slack/service.ts` (`postActivity`, ensure-thread, `activity_expand` action → modal)
- Modify: `src/journal/types.ts` (add `activity.posted` event type)
- Test: `tests/slack/activity.test.ts`, `tests/hooks/claude-hooks.test.ts` (extend)

**Key Decisions / Notes:**
- "Meaningful" default = `Edit|Write|MultiEdit|NotebookEdit|Bash|Task` + sub-agent/skill/task milestones; `Read|Grep|Glob|WebFetch|WebSearch|TodoWrite` suppressed at `normal` (shown at `verbose`) — verbosity from Task A5.
- Diff rendering: for Edit/Write derive a unified diff from `old_string`/`new_string`/`content`; cap modal text and offer the file-upload path (Task D4) for oversized diffs.
- Coalesce bursts (e.g. ≥N rows in <5s) into one summary row to respect Slack rate limits; reuse the `lastPostTime`/backoff pattern (`service.ts:573`).
- **Source decision is a PRECONDITION, not a runtime toggle (must-fix from review):** at the start of A4, confirm whether the target Claude version emits `PostToolUse` (inspect a test session's hook firing). (1) If YES → implement the hook path as primary; the transcript-tail is an optional later resilience add. (2) If NO → implement the transcript-`.jsonl`-tail path as primary (read the active session's transcript tail on the relay tick, classify the same way) and mark the hook path as a follow-up. Record which path shipped in the task's completion note and in `claude-hooks.ts` alongside the `PermissionRequest` config. The DoD tests target whichever path shipped.

**Definition of Done:**
- [ ] The chosen source path (hook-primary or transcript-tail-primary) is recorded in the completion note; the OTHER path is explicitly marked optional/follow-up (not silently skipped).
- [ ] A file edit and a bash command each produce one threaded row via the chosen path; a `Read` produces none at `normal`.
- [ ] `Expand` on an edit row opens a modal containing the correct unified diff; on a bash row, the exact command.
- [ ] Secrets in tool input are redacted in both the row and the modal.
- [ ] Verify: `npx vitest run tests/slack/activity.test.ts tests/hooks/claude-hooks.test.ts -q`

---

### Task A5: Notification verbosity control (UX-12)

**Objective:** Add operator-controlled verbosity governing the activity feed and proactive alerts: `!notify silent|normal|verbose` (and a `notifications.verbosity` config default), persisted per channel. `silent` suppresses the feed (cards/alerts still post), `normal` = meaningful actions, `verbose` = all tool uses.

**Files:**
- Create: `src/config/schema.ts` `NotificationsConfig { verbosity: 'silent'|'normal'|'verbose' }` + `src/config/defaults.ts`; add `notifications` to `AisupConfig` (`schema.ts:195`)
- Modify: `src/slack/commands.ts` (add `notify` to `KNOWN_COMMANDS:1`)
- Modify: `src/slack/service.ts` (`!notify` handler; verbosity state; gate `postActivity`)
- Test: `tests/slack/notify.test.ts`

**Key Decisions / Notes:**
- Permission cards and threshold alerts are NEVER suppressed by `silent` — only the informational feed is. Document this in `!help`.
- Verbosity persists in the card/relay state store from A1 so it survives restart.

**Definition of Done:**
- [ ] `!notify silent` stops feed rows but a subsequent permission card still posts.
- [ ] `!notify verbose` makes a `Read` post a row; `!notify normal` stops it again.
- [ ] Verify: `npx vitest run tests/slack/notify.test.ts -q`

---

### Task A6: Slack observability parity (UX-02)

**Objective:** Bring the read-only observability the CLI/HTTP already expose into Slack so the operator can answer "which account, how much headroom, what's it costing, will a worker run?" without a terminal. Add `!accounts`, `!cost`, `!health` (rich session+daemon snapshot), and `!worker providers`, each calling the existing handlers/`/api/*`.

**Files:**
- Modify: `src/slack/commands.ts` (`accounts`, `cost`, `health` added to `KNOWN_COMMANDS`)
- Modify: `src/slack/service.ts` (handlers; rich Block Kit via `blocks.ts`)
- Modify: `src/slack/service.ts` opts + `src/daemon/index.ts` (inject `getAccounts`/`getCost`/`getOverview`/`getWorkerProviders` readers reusing the same code paths as `server.ts:393/260` and Task C1's overview)
- Test: `tests/slack/observability.test.ts`

**Key Decisions / Notes:**
- Reuse the aggregation already behind `GET /api/accounts` (`server.ts:393`), `/api/cost` (`server.ts:260`), `/api/workers/providers` (`server.ts:361`) — do NOT re-implement scoring/aggregation.
- `!health` composes the Task C1 overview payload (single source).

**Definition of Done:**
- [ ] `!accounts` shows per-account state/headroom; `!cost` shows today/7d/30d; `!worker providers` shows per-role availability; `!health` shows session+daemon+queue.
- [ ] Numbers match the corresponding `aisup accounts`/`cost`/`worker providers` CLI output for the same state.
- [ ] Verify: `npx vitest run tests/slack/observability.test.ts -q`

---

### Task A7: Worker diff preview + approve/deny buttons in Slack (UX-06)

**Objective:** Make worker approval non-blind. Replace the `!worker approve <id>` → `!confirm` text dance (`service.ts:478-485`) with an interactive worker card that shows the patch summary + an `Expand diff` modal and `Approve` / `Deny` buttons that call the existing `approveWorker`/`denyWorker` handlers. Add `!worker diff <id>`.

**Files:**
- Modify: `src/slack/service.ts` (worker card + `worker_approve`/`worker_deny`/`worker_diff` actions; `!worker diff`)
- Modify: `src/slack/blocks.ts` (worker card + diff modal)
- Modify: `src/workers/types.ts`/`src/daemon/index.ts` (expose `WorkerOutput.patch`/`patch_path` to Slack via a `getWorkerDiff(id)` reader; reuse sanitize boundary from `worktree.ts`)
- Test: `tests/slack/worker-card.test.ts`

**Key Decisions / Notes:**
- Reuse the sanitized patch already captured by the orchestrator (`workers/orchestrator.ts` sanitize/persist); never read an unsanitized worktree diff.
- The approve action still routes through `onWorkerApprove` (integrity-anchored, double-apply-safe merge) — the button is UI only; no new merge path.
- Oversized diffs use the file-upload fallback (Task D4).

**Definition of Done:**
- [ ] A worker reaching `awaiting_approval` posts a card with `Expand diff` + `Approve`/`Deny`; the modal shows the sanitized patch.
- [ ] Tapping `Approve` merges via the existing handler and updates the card to the outcome; `Deny` symmetric.
- [ ] `!worker diff <id>` prints/opens the sanitized patch.
- [ ] Verify: `npx vitest run tests/slack/worker-card.test.ts -q`

---

### Task A8: Proactive threshold/budget Slack alerts (UX-05)

**Objective:** Push a Slack alert (not just a journal entry) when an account nears its soft/hard limit or a metered provider budget runs low. Wire the already-emitted `rate_limit.threshold_crossed` event (`daemon/index.ts:705-712`) to a Slack push, and add an optional `thresholds.warning_pct` early band.

**Files:**
- Modify: `src/config/schema.ts` (`ThresholdsConfig.warning_pct?: number`, `thresholds:16`) + `src/config/defaults.ts`
- Modify: `src/daemon/index.ts` (`onThresholdBreach` → `slackService.notifyThreshold`; emit a warning-band crossing when configured)
- Modify: `src/slack/service.ts` (`notifyThreshold` push; respects `silent`? — NO: alerts always post per A5 rule)
- Test: `tests/daemon/threshold-alert.test.ts`

**Key Decisions / Notes:**
- AF-R008 correction: the event is already journaled on every soft/hard breach — the gap is delivery only. Do not change emission; add the push + the optional warning band.
- De-dupe pushes (one per band crossing, not per tick) using a per-account last-pushed band.

**Definition of Done:**
- [ ] Crossing soft/hard (and `warning_pct` if set) posts exactly one Slack alert per crossing with account + headroom + reset ETA.
- [ ] No alert spam across repeated ticks at the same band.
- [ ] Verify: `npx vitest run tests/daemon/threshold-alert.test.ts -q`

---

### Task B1: CLI surface fixes — F-1 + F-2

**Objective:** Fix two low-severity CLI UX defects from the full-system validation. F-1: the worker CLI prints "Daemon not running" even when the daemon is up but `workers.enabled:false` (it maps every non-ok response to `DAEMON_REQUIRED`). F-2: `aisup log` is the only render command lacking `--json`.

**Files:**
- Modify: `src/cli/commands/worker.ts` (`daemonRequest`/callers: distinguish `res===null` (unreachable) from `res.status===503` → print the server `error`, e.g. "workers not enabled")
- Modify: `src/cli/index.ts` (`log` command: add `--json`, `log:76-83`) + `src/cli/commands/log.ts` (`showLog` json path mirroring `status`)
- Test: `tests/cli/worker-daemon-state.test.ts`, `tests/cli/log-json.test.ts`

**Key Decisions / Notes:**
- `Trivial:` F-2 is a thin json-path add mirroring `status` (`cli/commands/status.ts`); but F-1 adds a real branch + the pair share a task, so write tests for both (no Trivial escape for the task as a whole).

**Definition of Done:**
- [ ] With daemon up + workers disabled, `aisup worker providers` prints "workers not enabled" (not "Daemon not running"); with daemon down it still prints the unreachable message.
- [ ] `aisup log --json` emits valid JSON of the event list.
- [ ] Verify: `npx vitest run tests/cli/worker-daemon-state.test.ts tests/cli/log-json.test.ts -q`

---

### Task B2: Gate/config robustness — F-3 + F-5 + F-6

**Objective:** Fix three gate/config robustness defects. F-3: an absolute `workers.worktree_dir` makes the daemon exit 1 with empty output — validate at config load and fail loud to stderr. F-5: `aisup gate run` exits 0 even when gates FAIL — exit non-zero so CI can gate on it. F-6: a non-spawnable gate binary records `exit_code:null` + empty stderr — surface the ENOENT.

**Files:**
- Modify: `src/config/loader.ts` (validate `worktree_dir` via `validateWorktreeDir` (`worktree.ts:60`) at load; print the message to stderr before exit)
- Modify: `src/cli/commands/gate.ts` (`runGateCommand`: `process.exit(result.passed ? 0 : 1)`)
- Modify: `src/gates/engine.ts` (capture spawn `ENOENT` into `stderr_tail`/a reason on `gate.failed`)
- Test: `tests/config/worktree-dir-validation.test.ts`, `tests/cli/gate-exit-code.test.ts`, `tests/gates/spawn-error.test.ts`

**Key Decisions / Notes:**
- F-5 must keep exit 0 on pass; only failure flips to 1. The journal `gate.run_completed{passed}` already records the boolean.
- F-3: relative `worktree_dir` already works — only the absolute path must be rejected loudly at load, not crash silently at daemon start.

**Definition of Done:**
- [ ] Absolute `worktree_dir` → config load prints a clear "must be relative" error to stderr and exits non-zero (no blank daemon.out).
- [ ] `aisup gate run` exits 1 when a required gate fails, 0 when all pass.
- [ ] A gate `command` that doesn't exist records the ENOENT in `stderr_tail`/reason.
- [ ] Verify: `npx vitest run tests/config/worktree-dir-validation.test.ts tests/cli/gate-exit-code.test.ts tests/gates/spawn-error.test.ts -q`

---

### Task B3: F-4 — optional prompt/title redaction for security-denied worker tasks

**Objective:** Address the F-4 informational finding: a worker `task.prompt`/`task.title` is persisted verbatim in `state.json` even when the task is `security_denied`. Add an opt-in `workers.security.redact_denied_prompts` that, when enabled, stores a redacted placeholder for the prompt/title of security-denied tasks (worker OUTPUT is already redacted).

**Files:**
- Modify: `src/config/schema.ts` (`WorkerSecurityConfig.redact_denied_prompts?: boolean`, `schema.ts:147`) + `src/config/defaults.ts` (default false — preserve current behavior)
- Modify: `src/workers/store.ts` (on `security_denied`, redact `task.prompt`/`task.title` when enabled)
- Test: `tests/workers/redact-denied-prompt.test.ts`

**Key Decisions / Notes:**
- Default OFF: today's behavior (operator's own input retained, 0600 isolated) is intentional; this is an opt-in for operators whose prompts may carry secrets.
- Apply only on the `security_denied` terminal path; never alter prompts for normal tasks (the prompt is needed for retry — Task C6).

**Definition of Done:**
- [ ] With the flag on, a `security_denied` task's persisted `prompt`/`title` are placeholders; with it off, behavior is unchanged.
- [ ] Verify: `npx vitest run tests/workers/redact-denied-prompt.test.ts -q`

---

### Task B4: Closure-plan reconciliation + PRD/docs sync

**Objective:** Make the historical record reflect reality. Tick closure Task 13 (the deferred Full-System Validation — executed 2026-06-26) and record the F-1..F-7 disposition (F-7 fixed; F-1/F-2/F-3/F-5/F-6 fixed by Phase B; F-4 opt-in) in the closure plan, and sync the PRD/README/runbook for the features this plan ships.

**Files:**
- Modify: `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` (Task 13 `[ ]`→`[x]`; add an F-* disposition note; update Progress Tracking)
- Modify: `docs/prd/2026-04-29-ai-supervisor.md` (Feature L status; note Slack remote-control redesign; mark R-UX-05 do-not-build; Option C = future PRD)
- Modify: `README.md` (Slack interactive control + dashboard once D1 lands; CLI reference additions)
- Modify: `docs/runbook.md` (enable Slack interactivity steps; security note for never-expire permissions)

**Key Decisions / Notes:**
- Docs-only task — no `Trivial:` code escape. Run after the referenced features land (sequence near end), or update incrementally as each phase completes.
- Do not invent counts — re-grep for any "N phases"/feature-count statements before editing (documentation-sync rule).
- **Option C seam audit (should-fix from review):** before claiming "clean seams," grep all files this plan created/modified for `orchestrator|coordinator|workflow|phase-graph|durable` and confirm NONE build Option-C logic (the latent `roles.orchestrator` stays latent; the activity hook + worker store are reused, not extended into a conductor). Record the grep result.

**Definition of Done:**
- [ ] Closure plan Task 13 checkbox is `[x]` with a one-line evidence pointer to `docs/plans/2026-06-26-aisup-FULL-MANUAL-SYSTEM-VALIDATION-RESULTS.md`.
- [ ] F-1..F-7 disposition recorded, each with a reference to the task that fixes it (F-1/F-2→B1, F-3/F-5/F-6→B2, F-4→B3, F-7→already shipped).
- [ ] PRD Feature L status updated to reflect the minimal read-only dashboard + Slack remote-control redesign; PRD marks R-UX-04 (multi-session) and R-UX-05 (launchd) explicitly out-of-scope with the stated reasons; Option C noted as a future PRD.
- [ ] README documents Slack interactivity setup + dashboard link + the control(Slack)/observe(dashboard) split; runbook documents enabling Slack interactivity and the never-timeout permission behavior (incl. A0's measured dialog persistence).
- [ ] Option-C seam-audit grep recorded as finding no conductor code.
- [ ] Verify: `grep -nE "Task 13|F-[1-7]" docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` shows the updated state; `grep -rnE "orchestrator|coordinator|workflow" src/` shows no new conductor code.

**Seam-audit result (2026-07-01):** `grep -rniE "coordinator|phase.?graph|durable.?workflow|conductor" src/` → **no matches**. The only `orchestrator`/`workflow` hits are pre-existing Phase-3 worker infrastructure (`src/workers/orchestrator.ts` = `WorkerOrchestrator`, the bounded multi-LLM worker pipeline) and `routing`/`roles` config references — NONE build Option-C's durable phase-graph / coordinator / read-only-worker logic. The latent `roles.orchestrator`, the activity hook, and the worker store were reused, not extended into a conductor. **Clean seams confirmed.**

---

### Task C1: UX-01 — `aisup watch` / `aisup health` unified live view

**Objective:** Replace the 4-command stitch (`status`+`accounts`+`cost`+`log`) with one snapshot. Add `GET /api/overview` aggregating daemon health, active session, per-account headroom grid, worker queue, recent events, and cost-today; add `aisup health` (one-shot) and `aisup watch` (auto-refreshing) that render it. This payload also backs Slack `!health` (A6) and the dashboard (D1).

**Files:**
- Modify: `src/daemon/server.ts` (`GET /api/overview` composing existing readers)
- Create: `src/cli/commands/watch.ts` (`health` one-shot + `watch` refresh loop)
- Modify: `src/cli/index.ts` (register `health`, `watch`)
- Test: `tests/daemon/overview.test.ts`, `tests/cli/health.test.ts`

**Key Decisions / Notes:**
- `/api/overview` reuses the aggregations already behind `/api/status`,`/api/accounts`,`/api/cost`,`/api/workers`,`/api/events` — compose, don't duplicate.
- `watch` polls on an interval (default 3s) and redraws; performance: single overview call per tick (not 5 calls), cache nothing stale.

**Definition of Done:**
- [ ] `GET /api/overview` returns session+accounts+workers+cost-today+recent-events in one response.
- [ ] `aisup health` prints the unified snapshot; `aisup watch` refreshes it on an interval.
- [ ] Verify: `npx vitest run tests/daemon/overview.test.ts tests/cli/health.test.ts -q`

---

### Task C2: UX-03 — failover "why" explainability

**Objective:** Surface why a failover happened and why a target was chosen. Have the switcher return reason codes + the eligible-account scores + chosen-target rationale, persist them on the `account.switch`/`failover.*` events, and render them in `aisup log` and Slack.

**Files:**
- Modify: `src/failover/switcher.ts` (`selectSwitchTarget` returns a rationale `{reason_code, candidates:[{name,score,excluded_reason}], chosen}`)
- Modify: `src/daemon/index.ts` (include rationale in the `account.switch` event details)
- Modify: `src/cli/commands/log.ts` (render rationale when `--details`/present)
- Modify: `src/slack/service.ts` (include rationale in switch notifications)
- Test: `tests/failover/switch-rationale.test.ts`

**Key Decisions / Notes:**
- Keep the selection algorithm unchanged — only return + persist the reasoning it already computes.
- Reason codes draw from existing triggers (rate_limit_soft/hard, 429, auth, crash, manual).

**Definition of Done:**
- [ ] An `account.switch` event carries reason code + per-candidate scores + chosen target.
- [ ] `aisup log --details` and the Slack switch message show the rationale.
- [ ] Verify: `npx vitest run tests/failover/switch-rationale.test.ts -q`

---

### Task C3: UX-04 — worker failure transparency (`tried_candidates[]`)

**Objective:** On worker exhaustion the operator sees only `all_candidates_exhausted` and must grep the journal. Surface `tried_candidates[]` with per-candidate failure reason in `aisup worker status`, the worker API/`state.json`, and Slack.

**Files:**
- Modify: `src/workers/types.ts` (`WorkerState.tried_candidates?: {provider, account?, reason}[]`)
- Modify: `src/workers/failover.ts`/`src/workers/orchestrator.ts` (record each candidate failure into the worker state, not just the journal `worker.candidate_failed`)
- Modify: `src/cli/commands/worker.ts` (render `tried_candidates` in `status`, `worker.ts:70-84`)
- Modify: `src/slack/service.ts` (include in worker card/status)
- Test: `tests/workers/tried-candidates.test.ts`

**Key Decisions / Notes:**
- The data already exists in the journal (`worker.candidate_failed`); this collects it onto the durable `WorkerState` so surfaces don't grep.

**Definition of Done:**
- [ ] An exhausted worker's `status`/API shows each tried candidate + reason.
- [ ] Verify: `npx vitest run tests/workers/tried-candidates.test.ts -q`

---

### Task C4: UX-07 — `aisup log --details`/filters + `aisup explain <event>`

**Objective:** Make the event log usable. `log.ts` currently drops the `details` payload and offers no filtering. Add `--details`, `--account`, `--session`, `--since` (reader already supports `since`), and an `aisup explain <event_type>` that prints a human description of an event type.

**Files:**
- Modify: `src/cli/index.ts` (`log` options; new `explain` command)
- Modify: `src/cli/commands/log.ts` (render `details`; apply filters)
- Create: `src/cli/commands/explain.ts` (event_type → description table; reuse `journal/types.ts` union)
- Modify: `src/journal/reader.ts` (expose `account`/`session` filters if not present)
- Test: `tests/cli/log-filters.test.ts`, `tests/cli/explain.test.ts`

**Key Decisions / Notes:**
- `--since` plumbs the existing `reader.ts` support to the CLI (it's there but unexposed).
- `explain` is a static description map keyed by the `EventType` union — keep it in sync via a test that asserts every event type has a description.

**Definition of Done:**
- [ ] `aisup log --details --account X --since <iso>` filters and shows details.
- [ ] `aisup explain account.switch` prints a description; a test asserts all event types are covered.
- [ ] Verify: `npx vitest run tests/cli/log-filters.test.ts tests/cli/explain.test.ts -q`

---

### Task C5: UX-08 — onboarding/doctor guardrails + daemon port preflight

**Objective:** Stop silent mis-configuration. `doctor` should check statusline telemetry presence (extends F-7), ≥2 accounts, Slack tokens + scopes + interactivity toggle, and a daemon port preflight; `daemon start` should fail loud on a port conflict (today it spawns detached `stdio:'ignore'` so a port-in-use failure is invisible); `init` should print a post-setup checklist + a `~/.aisup/daemon.log` pointer.

**Files:**
- Modify: `src/cli/commands/doctor.ts` (account count, Slack token/scope/interactivity, port preflight checks; `doctor.ts:54-76`)
- Modify: `src/cli/commands/daemon.ts` (port preflight before spawn; surface bind failure; `daemon.ts:46-50`)
- Modify: `src/cli/commands/init.ts` (post-init checklist + daemon.log pointer; `config/loader.ts:487-488` placeholder-dir note)
- Test: `tests/cli/doctor-guardrails.test.ts`, `tests/cli/daemon-port-preflight.test.ts`

**Key Decisions / Notes:**
- Port preflight: attempt a bind on `config.daemon.port` (or check via a quick connect) before the detached spawn; on conflict print a clear error + the occupying-pid hint.
- Slack interactivity check: call `apps.connections` / auth.test for scopes; flag if interactivity isn't enabled (best-effort, host-gated for the live call).
- `doctor` non-zero exit when a hard prerequisite fails (mirrors B2's exit-code discipline).

**Definition of Done:**
- [ ] `doctor` flags <2 accounts, no telemetry, missing Slack scopes/interactivity, and an occupied port; exits non-zero on hard failures.
- [ ] `aisup daemon start` with the port occupied prints a clear error instead of a silent detached exit.
- [ ] `init` prints a checklist + daemon.log pointer.
- [ ] Verify: `npx vitest run tests/cli/doctor-guardrails.test.ts tests/cli/daemon-port-preflight.test.ts -q`

---

### Task C6: UX-09 — `aisup worker retry <id>` + Slack `!worker retry`

**Objective:** A FAILED/denied worker is a dead end requiring a full re-type. Add `aisup worker retry <id>` (and Slack `!worker retry <id>`) that re-dispatches a new worker from the original task (prompt/title/type/routing), linking the retry to its parent.

**Files:**
- Modify: `src/workers/types.ts` (`WorkerState.retry_of?: string`)
- Modify: `src/workers/orchestrator.ts` (`retry(id)` → new dispatch from stored task)
- Modify: `src/daemon/server.ts` (`POST /api/workers/:id/retry`)
- Modify: `src/cli/commands/worker.ts` + `src/cli/index.ts` (`worker retry`)
- Modify: `src/slack/service.ts` (`!worker retry`)
- Test: `tests/workers/retry.test.ts`

**Key Decisions / Notes:**
- Only retry terminal-failed/denied/cancelled workers; reject retry of an in-flight one (409).
- Depends on the original prompt being retained — so B3 redaction must NOT apply to non-denied tasks (it doesn't).

**Definition of Done:**
- [ ] `worker retry <id>` on a failed worker creates a new QUEUED worker with `retry_of` set and the original task.
- [ ] Retrying an in-flight worker is rejected.
- [ ] Verify: `npx vitest run tests/workers/retry.test.ts -q`

---

### Task C7: UX-10 — runtime account control

**Objective:** Excluding/pinning an account currently needs a config edit + daemon restart. Add runtime overrides: `aisup accounts --pin <name>` (prefer), `--exclude <name>`, `--enable/--disable <name>` (and Slack `!account pin|exclude|enable|disable <name>`), persisted as a runtime override layer the scorer/selector respects.

**Files:**
- Modify: `src/accounts/registry.ts` (runtime override layer: pinned/excluded/disabled; persisted to `~/.aisup/account-overrides.json`)
- Modify: `src/failover/switcher.ts`/`src/accounts/scorer.ts` (honor overrides in selection)
- Modify: `src/daemon/server.ts` (`POST /api/accounts/:name/override`)
- Modify: `src/cli/commands/accounts.ts` + `src/cli/index.ts` (flags)
- Modify: `src/slack/service.ts` (`!account …`)
- Test: `tests/accounts/runtime-overrides.test.ts`

**Key Decisions / Notes:**
- `--pin` forces selection to that account while runnable; `--exclude`/`--disable` remove it from selection; overrides survive restart but are clearly separate from config (a `--clear` resets).
- Overrides must not bypass health/circuit-breaker safety (a pinned-but-UNAVAILABLE account still can't be selected).

**Definition of Done:**
- [ ] `accounts --exclude X` removes X from selection without a restart; `--pin Y` forces Y; `--clear` resets.
- [ ] Overrides persist across daemon restart and never override circuit-breaker UNAVAILABLE.
- [ ] Verify: `npx vitest run tests/accounts/runtime-overrides.test.ts -q`

---

### Task C8: UX-11 — cost breakdown by skill / task-type / provider

**Objective:** `cost` shows only rolling windows by account; worker token usage isn't linked back to cost. Add breakdowns by skill, by worker task-type, and per-provider (Claude vs codex), surfaced in `aisup cost` (+`--by skill|task|provider`) and the cost API.

**Files:**
- Modify: `src/cost/aggregator.ts` (group by skill/task-type/provider from journal `cost.snapshot` + `worker.*` token fields)
- Modify: `src/daemon/server.ts` (`/api/cost` accepts a `by` dimension)
- Modify: `src/cli/commands/cost.ts` + `src/cli/index.ts` (`--by`)
- Test: `tests/cost/breakdowns.test.ts`

**Key Decisions / Notes:**
- Skill attribution uses the active-skill on the session at snapshot time (already journaled via skill.detected); provider split uses worker `worker.*` events' provider + token fields (`workers/codex-json.ts`).
- Don't double-count: lead-session cost and worker cost are distinct streams; label them.

**Definition of Done:**
- [ ] `aisup cost --by provider` splits Claude vs codex; `--by skill` and `--by task` group correctly against a fixture journal.
- [ ] Verify: `npx vitest run tests/cost/breakdowns.test.ts -q`

---

### Task C9: UX-13 — `aisup pause` / `aisup resume` (PAUSED state)

**Objective:** Add a way to throttle a session to save headroom without a full stop. `aisup pause` SIGSTOPs the runner process in the pane (PAUSED state); `aisup resume` SIGCONTs it. Reflected in status/overview/Slack.

**Files:**
- Modify: `src/session/types.ts` (`'PAUSED'` status)
- Modify: `src/session/manager.ts` (pause/resume via signal to the pane's runner pid)
- Modify: `src/daemon/server.ts` (`POST /api/sessions/pause`/`/resume`)
- Modify: `src/cli/commands/*` + `src/cli/index.ts` (`pause`,`resume`); `src/slack/service.ts` (`!pause`/`!resume`)
- Test: `tests/session/pause-resume.test.ts`

**Key Decisions / Notes:**
- PAUSED suspends monitoring-driven failover for that session (a paused session shouldn't trip idle/recovery). Confirm the idle watchdog and recovery loops skip PAUSED.
- Resolve the runner pid from the tmux pane (existing pane→pid lookup in `session/tmux.ts`).

**Definition of Done:**
- [ ] `aisup pause` moves the session to PAUSED and SIGSTOPs the runner; `aisup resume` restores it; idle/recovery loops skip PAUSED.
- [ ] Verify: `npx vitest run tests/session/pause-resume.test.ts -q`

---

### Task C10: UX-14 — worker merge undo/revoke + `worker cleanup`

**Objective:** An approved merge is permanent and orphaned worktrees are invisible. Add `aisup worker undo <id>` (revert an approved merge via a stored revert ref/patch, when the working tree allows) and `aisup worker cleanup --list/--force` (surface + remove orphaned worktrees the retention sweep would otherwise hide).

**Files:**
- Modify: `src/workers/merge.ts` (record the merge commit/applied-patch so it can be reverted; `undo(id)`)
- Modify: `src/workers/store.ts`/`orchestrator.ts` (`cleanup --list/--force`)
- Modify: `src/daemon/server.ts` (`POST /api/workers/:id/undo`, `/api/workers/cleanup`)
- Modify: `src/cli/commands/worker.ts` + `src/cli/index.ts`
- Test: `tests/workers/undo-cleanup.test.ts`

**Key Decisions / Notes:**
- `undo` is best-effort and refuses when the tree has diverged (no force-revert over conflicting local edits) — print guidance instead of corrupting the tree (mirrors the git-safety discipline).
- `cleanup --list` is read-only; `--force` removes only aisup-created worktrees under `worktree_dir` (never the main workspace).

**Definition of Done:**
- [ ] `worker cleanup --list` shows orphaned aisup worktrees; `--force` removes them (and only them).
- [ ] `worker undo <id>` reverts a clean merge and refuses on divergence with clear guidance.
- [ ] Verify: `npx vitest run tests/workers/undo-cleanup.test.ts -q`

---

### Task C11: UX-15 — session naming/labels + `aisup session timeline`

**Objective:** Sessions are UUID-only and event causality requires manual journal correlation. Add an optional session name/label (set at `start --name` and `aisup session rename`), surface it everywhere the session id shows, and add `aisup session timeline [id]` that renders the session's lifecycle (start → switches → recoveries → stop) as an ordered causal view.

**Files:**
- Modify: `src/session/types.ts` (`name?: string`)
- Modify: `src/cli/commands/start.ts` (`--name`) + `src/session/manager.ts` (rename + persist)
- Create: `src/cli/commands/session.ts` (`session rename`, `session timeline`)
- Modify: `src/cli/index.ts` (register `session` group); render name in status/log/overview/Slack
- Test: `tests/cli/session-timeline.test.ts`

**Key Decisions / Notes:**
- Timeline is a focused journal read for one session id, ordered, with the per-event one-liners (reuses C4's `details` rendering + C2's failover rationale).

**Definition of Done:**
- [ ] `aisup start --name "X"` labels the session; the name shows in `status`/`log`/`health`.
- [ ] `aisup session timeline` prints the ordered lifecycle for the session.
- [ ] Verify: `npx vitest run tests/cli/session-timeline.test.ts -q`

---

### Task C12: R-UX-01 — live worker progress (`worker logs <id> --follow`)

**Objective:** `worker logs` is one-shot and shows "(no output captured yet)" until completion (`worker.ts:106`); during a multi-minute worker the operator is blind. Add streaming progress: `aisup worker logs <id> --follow` tails the worker's live stdout, and `worker status` gains a progress/phase field.

**Files:**
- Modify: `src/workers/runner.ts` (write incremental stdout to a live tail file as it runs, not only post-run)
- Modify: `src/workers/types.ts` (`WorkerState.progress?: string`)
- Modify: `src/cli/commands/worker.ts` + `src/cli/index.ts` (`--follow` tail loop)
- Test: `tests/workers/live-progress.test.ts`

**Key Decisions / Notes:**
- Tail file lives under the worker's store dir; redact on read using the same sanitize as post-run tails (never stream raw secrets).
- `--follow` polls the tail file (condition-based, with a clean exit on terminal state) — no arbitrary sleeps.

**Definition of Done:**
- [ ] `worker logs <id> --follow` streams incremental output during a running worker and exits when it reaches a terminal state.
- [ ] Streamed output is redacted.
- [ ] Verify: `npx vitest run tests/workers/live-progress.test.ts -q`

---

### Task C13: R-UX-02 — hot config reload (`aisup daemon reload` / SIGHUP)

**Objective:** Changing thresholds/accounts/Slack today requires `daemon stop`+`start`, which tears down the single supervised session. Add `aisup daemon reload` (and SIGHUP) that re-reads `~/.aisup/config.yaml` and applies hot-reloadable settings (thresholds, monitoring intervals, account list, notification verbosity, Slack allowed users) without dropping the session.

**Files:**
- Modify: `src/daemon/index.ts` (SIGHUP handler → re-load config → apply to loops/registry/slack; journal `daemon.reloaded`)
- Modify: `src/daemon/loop-manager.ts` (accept updated intervals/thresholds live)
- Modify: `src/cli/commands/daemon.ts` (`reload` → SIGHUP the daemon pid)
- Modify: `src/journal/types.ts` (`daemon.reloaded`)
- Test: `tests/daemon/hot-reload.test.ts`

**Key Decisions / Notes:**
- Only reload settings that are safe live; structural ones (port, journal path) require a restart — print which were applied vs require restart.
- Account list reload re-syncs the registry without dropping the active session's account.

**Definition of Done:**
- [ ] `aisup daemon reload` applies changed thresholds/intervals/accounts/verbosity without stopping the active session; journals `daemon.reloaded` listing applied vs restart-required keys.
- [ ] Verify: `npx vitest run tests/daemon/hot-reload.test.ts -q`

---

### Task D1: Minimal read-only HTTP mobile dashboard (Feature L, token auth)

**Objective:** Ship PRD Phase 4 Feature L: a token-authed, auto-refreshing, read-only `/dashboard` HTML page that renders the Task C1 overview (active session+account, per-account headroom grid, worker queue, recent events, cost-today). All control stays in Slack; the dashboard is observe-only.

**Files:**
- Modify: `src/daemon/server.ts` (`GET /dashboard` serves a static unauthenticated HTML shell; new `POST /api/dashboard/session` exchanges the bearer token for a short-lived read-only dashboard cookie; `GET /api/overview` accepts that cookie OR the bearer header)
- Create: `src/dashboard/page.ts` (renders the HTML shell; no build step; inline JS that prompts for the token, exchanges it, then polls `/api/overview` with the cookie)
- Test: `tests/daemon/dashboard.test.ts`

**Key Decisions / Notes:**
- **No token in the URL (Codex high-sev fix):** do NOT accept `?token=`. Putting the long-lived `~/.aisup/api-token` in a query string leaks it via browser history, referrers, and tunnel/proxy logs, and it is not dashboard-scoped (it authorizes every daemon control route — `server.ts:129-140`). Instead: the shell is unauthenticated HTML; the user pastes the token once; the page POSTs it to `/api/dashboard/session` which returns a short-lived, read-only-scoped `HttpOnly` cookie; subsequent `/api/overview` polls use the cookie. The control APIs continue to require the bearer header and are NOT reachable with the dashboard cookie.
- Bind stays `127.0.0.1` (PRD: localhost; remote access is the operator's tunnel choice, documented).
- No new aggregation — the page consumes `/api/overview` (C1). Auto-refresh via a polling fetch (default 5s).

**Definition of Done:**
- [ ] `GET /dashboard` serves the shell; `/api/overview` without a valid cookie/bearer → 401; the daemon bearer token never appears in any URL the dashboard uses.
- [ ] After token exchange, the dashboard cookie reads `/api/overview` but is rejected by a control route (e.g. `POST /api/failover` → 401).
- [ ] TS-003 passes end-to-end (browser).
- [ ] Verify: `npx vitest run tests/daemon/dashboard.test.ts -q` + browser check per TS-003.

---

### Task D2: ntfy notification fallback

**Objective:** Ship the PRD's lightweight ntfy alternative: optionally mirror key push-worthy events (session start/stop, exhausted, threshold alert, permission requested, worker awaiting approval) to an ntfy topic via HTTP POST, gated by `notifications.ntfy`.

**Files:**
- Modify: `src/config/schema.ts` (`NotificationsConfig.ntfy { enabled, topic, server }`) + `src/config/defaults.ts`
- Create: `src/notifications/ntfy.ts` (POST to the topic; best-effort, journaled on failure)
- Modify: `src/daemon/index.ts` (call the ntfy emitter alongside Slack notifications)
- Test: `tests/notifications/ntfy.test.ts` (mock the HTTP client)

**Key Decisions / Notes:**
- Notification-only (not bidirectional); Slack stays the control plane. Failure is best-effort (journal, don't crash).
- Reuse the verbosity setting (A5) for which events mirror to ntfy.

**Definition of Done:**
- [ ] With ntfy enabled, a session-start/threshold/permission event POSTs to the topic (HTTP mocked); disabled → no POST; failures are journaled, not thrown.
- [ ] Verify: `npx vitest run tests/notifications/ntfy.test.ts -q`

---

### Task D3: Daemon log rotation + health self-check

**Objective:** Ship the PRD Phase 4 daemon enhancements and close the P-5 validation GAP: rotate the daemon log + journal + per-session output logs by size, and add a daemon health self-check loop that journals/exposes its own liveness (loops running, last tick times).

**Files:**
- Modify: `src/daemon/index.ts` (the daemon log call site hard-codes `maxSizeMb: 10` at `index.ts:94` — wire it to `config.daemon.log_max_size_mb` so the configured value is actually honored)
- Modify: `src/config/schema.ts` (`JournalConfig` only has `path` today — add `max_size_mb`) + `src/config/defaults.ts` (default journal max size)
- Modify: `src/util/rotating-log.ts` (apply to `daemon.log`; honor `daemon.log_max_size_mb`, `schema.ts:94`)
- Modify: `src/journal/writer.ts` (size-based rotation honoring `journal.max_size_mb`)
- Modify: `src/daemon/loop-manager.ts` (health self-check tick → `/api/health` exposes loop liveness; journal `daemon.health_check`)
- Modify: `src/journal/types.ts` (`daemon.health_check`, `journal.rotated`)
- Test: `tests/util/log-rotation.test.ts`, `tests/daemon/health-self-check.test.ts`

**Key Decisions / Notes:**
- **Wire the config at the call sites (Codex medium fix):** modifying only `rotating-log.ts`/`writer.ts` cannot make the daemon honor a configured size — `daemon/index.ts:94` hard-codes `maxSizeMb: 10`, and `JournalConfig` has no max-size field at all. D3 adds the journal field + reads `daemon.log_max_size_mb` at the call site.
- Output-log rotation already partially exists (`output_log.rotated` event, `session.output_log_max_size_mb`); extend the same mechanism to daemon.log + journal.
- Health self-check is observe-only (no auto-restart) — it records loop last-tick timestamps; `/api/health` and overview surface staleness.

**Definition of Done:**
- [ ] A NON-default `daemon.log_max_size_mb` and `journal.max_size_mb` each drive rotation at that configured size (test sets a small size and asserts rotation), not the hard-coded 10MB; rotation journaled.
- [ ] `/api/health` reports per-loop liveness/last-tick; a stalled loop is visible in `health`/overview.
- [ ] Verify: `npx vitest run tests/util/log-rotation.test.ts tests/daemon/health-self-check.test.ts -q`

---

### Task D4: Enhanced Slack residue (stop-thread summary + large-diff file upload)

**Objective:** Finish the PRD's "enhanced Slack features" not already delivered by Phase A: a session-stop thread summary (duration, account switches, cost, key events) and a `files.uploadV2` path for diffs/command output too large for a Block Kit modal (used by A4/A7).

**Files:**
- Modify: `src/slack/service.ts` (`onSessionStop` posts a summary; `uploadLargeContent` helper for oversized diffs)
- Modify: `src/slack/activity.ts`/`blocks.ts` (route oversized diffs to file upload instead of a truncated modal)
- Test: `tests/slack/stop-summary.test.ts`

**Key Decisions / Notes:**
- Summary composes from the journal for that session (reuses C11 timeline data); best-effort post.
- File upload requires the `files:write` scope — `doctor` (C5) flags if missing.

**Definition of Done:**
- [ ] Session stop posts a summary (duration, switches, cost-for-session, key events).
- [ ] An oversized diff in the activity/worker flow is delivered as a file upload rather than a truncated modal.
- [ ] Verify: `npx vitest run tests/slack/stop-summary.test.ts -q`

## Testing Posture

No project-level testing rule shadow exists (`.claude/rules/` absent), so the global **parsimonious** posture applies: per new production class, at most one unit test class + one functional/integration class; reuse existing test classes where a behaviour is already covered; host-gated Slack/permission/worker tiers (`AISUP_TEST_SLACK`, `AISUP_TEST_PERMISSIONS`, `@requires_codex`) stay separate from the always-run unit suite. The full suite (`npx vitest run`) must end at 0 failures after every task.

## Open Questions

- **`Approve for session` keystroke (Task A2):** the exact Claude-dialog option for "don't ask again" must be confirmed against the running Claude version before wiring; if it can't be confirmed, ship Approve/Deny only and add the third button when the keystroke is known (do not guess it).
- **`PostToolUse` availability (Task A4):** confirmed-or-fallback at implementation time per Assumptions; the transcript-tail fallback is the contingency.

## Verification (spec-verify, 2026-07-01)

**Automated:** full suite 870 pass / 0 fail / 12 skipped (host-gated); `tsc --noEmit` clean (only the pre-existing tsconfig `esModuleInterop` deprecation); `eslint src tests` clean; `tsup` build clean.

**Changes-review agent:** `issues: []` — compliance **high**, quality **high**, goal **achieved**, 3/3 verification truths verified with evidence. Codex adversarial review skipped (documented `phase=starting` hang on `.claude-account2`).

### E2E Results

| Scenario | Priority | Result | Notes |
|----------|----------|--------|-------|
| TS-003: Read-only mobile dashboard | High | PASS | Browser (Chrome DevTools MCP): paste token → board renders session/accounts/workers/cost/events; real-socket curl confirms cookie reads `/api/overview` but is 401 on `/api/failover`; inject tests 5/5. Token never in URL. |
| TS-004: doctor catches readiness gaps | High | PASS | `aisup doctor` on the real host: ≥2-accounts ✓, port-free ✓, interactivity ✓, flags missing Slack tokens (✗). |
| TS-001: Permission card tap-to-approve, no timeout | Critical | **LIVE_PASS** (2026-07-07) | Real Claude 2.1.203 session + real Slack: PermissionRequest hook fired → Block Kit card posted to channel root (Approve/Deny + opaque request_id, no !permit text); untouched 45s → 0 timeout events, dialog still open (+ canonical 6-min host-gated resolver); operator Approve tap → `y` keystroke resolved the real numbered dialog, command ran, card updated to "✅ Approved by <user>", journal `permission.granted`. Evidence: `docs/plans/2026-07-07-aisup-final-completion-LIVE-VALIDATION-RESULTS.md` §3 (TS-001). |
| TS-002: Activity feed — meaningful rows, expandable diff | High | **LIVE_PASS** (2026-07-07) | LIVE: PostToolUse hook fires on 2.1.203; edit + bash post compact threaded rows, a Read posts none at `normal`; secret Bash input is `[REDACTED]` in the row; operator Expand → modal shows the unified diff (`-return 1`/`+return 2`) / command / `[REDACTED]`; `!notify verbose` → a Read posts a `:mag: read` row. All 3 plan steps proven. Evidence: results doc §3 (TS-002). |

### Not Verified

| Not Verified | Reason |
|-------------|--------|
| TS-001 / TS-002 live Slack interaction | ~~Host-gated~~ — **executed live 2026-07-07** (see below); TS-001 LIVE_PASS, TS-002 LIVE_PASS (partial). |
| Full daemon start against real accounts | ~~Would launch real side effects~~ — **executed live 2026-07-07** against real daemon + real Claude/codex/Slack. |

### Live-validation campaign addendum (2026-07-07)

A full live manual validation (real daemon, real Claude 2.1.203 sessions, real codex workers, real Slack app, isolated `AISUP_HOME`, operator `~/.aisup` asserted byte-unchanged) ran against this uncommitted changeset. Full results + evidence: **`docs/plans/2026-07-07-aisup-final-completion-LIVE-VALIDATION-RESULTS.md`**.

The automated suite is green, but the build+test path uses esbuild, which does not type-check — so the campaign found **3 real defects that the unit tests hid**. All three were **fixed and re-verified on 2026-07-08** (`tsc --noEmit` now clean; suite 871 pass / 0 fail):

- **FV-2 — the tree did not typecheck** (4 `tsc` errors incl. 2 in production `src/slack/service.ts`). **FIXED** — the 2026-07-01 "tsc clean" claim is now actually true.
- **FV-1 — Task D4 stop-thread summary was dead code** (`onSessionStop` gated on an unset `journalPath`). **FIXED** — `journalPath` added to `SlackServiceOpts` + passed from `config.journal.path`; live-verified a real stop now posts the rich summary.
- **FV-7 — Task D3 journal rotation was permanently disabled** (`config/loader.ts` dropped `journal.max_size_mb`). **FIXED** — loader now carries it through; live-verified rotation fires at the configured size; loader regression test added.

Plus 8 lower-severity findings (FV-3…FV-6, FV-8…FV-11) — documented in the results doc, **not** code-fixed. See §4 there.
