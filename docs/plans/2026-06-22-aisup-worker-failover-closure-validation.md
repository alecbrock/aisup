# Worker Multi-Provider Failover — Closure & Real Validation Plan

Created: 2026-06-22
Author: alec.m.brock@gmail.com
Agent: Claude Code
Status: PENDING
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Close the remaining tech debt for Worker Multi-Provider Failover (Part B) and prove its *reachable* Goal Verification Truths with a fully real, no-mocks, real-subprocess (`claude -p` + `codex exec --json`) end-to-end validation executed against a real, fully state-isolated daemon.

## Out of Scope

- **Gemini / ollama real adapters** — not installed; provider abstraction keeps them config-only later. The `@requires_gemini` / `@requires_local_llm` placeholder tiers stay as-is.
- **Orchestrator cross-LLM failover** — locked decision; the lead session stays Claude-account-only.
- **⛔ codex→claude failover ("codex-preferred, Claude-fallback") is N/A by design.** The locked account-first selector (`selector.ts:resolveCandidates` → `[...claudeCands, ...crossCands]`) always orders every available Claude account *before* any codex candidate, for BOTH implementer and reviewer roles. So codex is only ever reached when all Claude accounts are unavailable; there is no available Claude account to fall back to at that point. The Part B plan's Truth 2 clause "a codex-default task fails over to an available Claude account" is therefore unreachable and is **corrected** by this plan (Task 5 patches both plans' Truth wording). The codex budget's real role is to *gate codex within exhaustion*, not to trigger a codex→Claude failover.
- **Lead-session pane-output detector drift** (validation-plan 2026-06-17 line 289) — separate pre-existing finding affecting the *lead* session's pane detectors, not workers (workers parse JSON, not pane output).

## Approach

**Chosen:** One isolation enabler (`AISUP_HOME` state-dir override centralized in a new `src/config/paths.ts`) plus the corrected codex worker args (`defaults.ts`) unblock a fully-isolated real daemon; then convert the placeholder/faked host-gated tests into real-subprocess proofs of only the *reachable* failover legs; finish with a live full-daemon validation executed during verification against an isolated state dir, capturing real evidence.
**Why:** Every Part B Truth is proven only by unit + fake-adapter tests, and `AISUP_CONFIG` alone would leave the validation daemon writing to / colliding with the operator's real `~/.aisup` state (pid, journal, ledger, sessions). A full `AISUP_HOME` override is the correct, reusable isolation primitive and is the only way to run a real daemon validation that provably never touches operator state. Forcing the *failing* candidate cheaply (injected 429 in tests; no-auth `CLAUDE_CONFIG_DIR` / over-budget in the live run) keeps each proof real without burning real quota on legs meant to fail.

## Context for Implementer

The Part B feature is shipped and VERIFIED (commit `2ab8440`, plan `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md`). This plan does NOT re-implement it — it closes the live-validation gap its "Not Verified" section names and corrects one unreachable Truth. **The account-first selector means Claude (any account) is ALWAYS preferred over codex for both implementer and reviewer; codex runs only when every Claude account is unavailable.** Reachable failover directions are therefore: Claude-account → Claude-account (account-first) and all-Claude-down → codex (cross-LLM, `claude→codex`). `notifyWorkerFailover` posts to Slack only on a cross-provider failover (`claude→codex`) and only when an active supervised session has a mapped channel — so the live run starts a real lead session for the Slack evidence.

## Runtime Environment

- **Build:** `npm run build` → `dist/cli/index.js`, `dist/daemon/index.js`.
- **Isolated daemon (live validation):** `source ~/.aisup/secrets.env && AISUP_HOME=<temp-state-dir> node dist/daemon/index.js` (background) on a **non-default port** set in the throwaway config; health `http://127.0.0.1:<port>/api/health`.
- **Worker dispatch / readout (same `AISUP_HOME`):** `AISUP_HOME=<temp> node dist/cli/index.js worker dispatch …` / `worker providers`.
- **Real CLIs (2026-06-22):** `claude 2.1.185`, `codex-cli 0.140.0`; 3 enabled Claude accounts (primary=`~/.claude`, account2=`~/.claude-account2`, account3=`~/.claude-account3`).
- **⛔ `AISUP_HOME` relocates the ENTIRE aisup state dir** (config, pid, journal, ledger, sessions, channel-map, hooks settings, logs, worker store). Account `config_dir`s in the throwaway config are written as ABSOLUTE real paths (e.g. `/Users/alecbrock/.claude`) so real auth still works without depending on `HOME`. The operator's real `~/.aisup` is never read or written by the validation run.
- **⛔ Two state paths are CONFIG-DRIVEN, not `join(homedir(), '.aisup')` call sites, so the generic `aisupHome()` join-routing does NOT relocate them — they need their own handling (review 2026-06-23 CR-001 / HI-001):**
  - **`journal.path`** defaults to the literal string `~/.aisup/journal.jsonl` (`defaults.ts`), expanded via `homedir()` in `loader.ts:expandPath`. Task 1 MUST resolve this default through `aisupHome()` inside `loadConfig`/`validateConfig` so a set `AISUP_HOME` relocates the journal (the primary live-validation evidence file). Otherwise the validation daemon writes its journal into the operator's REAL `~/.aisup/journal.jsonl` and Task 5 reads an empty isolated journal.
  - **`statusline.directory`** defaults to the SHARED `/tmp/pilot-failover` and is telemetry INPUT written by the operator's statusline tap; it is intentionally NOT relocated by `AISUP_HOME` (the tap writes there regardless). The Task 5 harness instead sets `statusline.directory` EXPLICITLY to an isolated path under `AISUP_HOME` so the validation daemon never ingests the operator's shared telemetry (which would make candidate ordering nondeterministic — HI-001).

## Assumptions

- **`codex exec --json --skip-git-repo-check -s workspace-write` edits files non-interactively** and emits `turn.completed.usage` + an `agent_message` — proven by the operator's live config and the prior codex-worker E2E (commit `29a25f1`). Tasks 2–5 depend on this.
- **`claude -p` under an empty/no-auth `CLAUDE_CONFIG_DIR` exits non-zero with an auth signal** (classified `auth_failed`, failover-worthy) rather than hanging on a prompt. Task 5's account-first forcing depends on this; the harness bounds the call with a timeout (Task 5).
- **The account-first failing candidate must be TRIED first to emit `worker.candidate_failed`** (review 2026-06-23 HI-001). The selector orders Claude accounts best-headroom-first (`selector.ts:53`) with unknown headroom (`?? -1`) sinking last, and a dropped candidate emits NO `candidate_failed` (`selector.ts:43`). With the Task 5 harness's isolated `statusline.directory` (no shared telemetry) + fresh isolated usage ledger, ALL accounts return unknown headroom and the selector's stable sort preserves CONFIG ORDER — so listing the no-auth account FIRST deterministically makes it the first-tried candidate. If `claude -p` hangs instead of erroring, the fallback is to pre-seed isolated statusline telemetry giving the failing account the HIGHEST headroom (so it still sorts first and is ATTEMPTED) — NOT a reactive-unavailable mark, which would drop the candidate pre-attempt and emit no `candidate_failed`.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Validation daemon collides with a running operator daemon (pid/port) or mutates operator state | Medium | High | `AISUP_HOME` isolates ALL state to a temp dir; the throwaway config sets a non-default `daemon.port`; the harness preflights that the port is free and aborts if not. The operator's real `~/.aisup` is untouched (asserted: real config sha256 unchanged; temp dir removed in teardown). |
| Real Slack cross-LLM evidence needs an active session channel | Medium | Medium | Task 5 starts a real supervised lead session so a channel is mapped before the cross-LLM dispatch; if a session can't be established, the `worker.failover {cross_provider:true}` journal event + a note confirming the `notifyWorkerFailover` wiring is the accepted evidence, with the dependency recorded. |
| `claude -p` empty-config-dir prompts instead of erroring (breaks account-first forcing) | Low | Medium | Bound the forced-fail `claude -p` with a timeout; if it hangs, fall back to pre-seeding ISOLATED statusline telemetry that gives the failing account the highest headroom so it still sorts first and is ATTEMPTED (NOT a reactive-unavailable mark, which drops the candidate and emits no `worker.candidate_failed`); record which mechanism was used. |
| Account-first leg is order-nondeterministic → no `worker.candidate_failed` emitted (review 2026-06-23 HI-001) | Medium | High | The selector orders best-headroom-first with unknown headroom last; a real account with fresh shared telemetry sorts ahead of the no-auth account, so the worker succeeds first-try and emits no failover. Mitigation: Task 5 sets `statusline.directory` to an isolated path under `AISUP_HOME` (no shared telemetry) + fresh isolated ledger ⇒ all accounts unknown ⇒ stable sort preserves config order ⇒ the first-listed no-auth account is tried first. Preflight asserts `aisup worker providers` shows all accounts at `unknown` basis before dispatch. |
| Journal not relocated by `AISUP_HOME` → validation pollutes operator state + reads empty evidence (review 2026-06-23 CR-001) | High | High | `journal.path` is config-driven (default `~/.aisup/journal.jsonl`, expanded via `homedir()`), NOT a join-site. Task 1 resolves this default through `aisupHome()` in `loader.ts`; Task 5 also sets `journal.path` explicitly under `AISUP_HOME` and asserts the real `~/.aisup/journal.jsonl` mtime/size is unchanged across the run. |
| `AISUP_HOME` centralization misses a `~/.aisup` call site → split-brain state | Medium | Medium | Task 1 greps all 15 files referencing `~/.aisup`/`AISUP_DIR`, routes every one through `aisupHome()`, and a unit test asserts representative paths (config, pid, journal, worker store) honor the override. The grep cannot catch the config-driven `journal.path` (CR-001) — a DEDICATED test asserts the journal resolves under `AISUP_HOME`. |

## Goal Verification

### Truths

1. With a **real** daemon and a **real** `aisup worker dispatch`, forcing the first Claude candidate unavailable causes the **same task** to complete on the **next real Claude account** in a fresh worktree with no operator action — observed in the isolated journal as `worker.candidate_failed` → `worker.failover` → `worker.completed` → `worker.awaiting_approval`.
2. When **all** Claude accounts are unavailable, a real worker task crosses to a **real `codex exec --json`** run and completes (`claude→codex` cross-LLM); and the codex token budget gates codex — with a crossed (tiny) budget and all Claude unavailable, the task terminates `worker.all_candidates_exhausted` rather than running unbounded codex.
3. `aisup worker providers` reports live per-provider availability (Claude headroom % + `live|aged|reset` basis; codex tokens-remaining vs budget), and a real `claude→codex` cross-LLM failover posts a real Slack message to the active session channel.

## Progress Tracking

- [x] Task 1: `AISUP_HOME` state-dir isolation (centralized path resolution)
- [x] Task 2: Correct the shipped default codex worker adapter args
- [x] Task 3: Real codex worker run — replace the `@requires_codex` placeholder
- [x] Task 4: Real multi-provider failover host-gated test, reachable legs (no faked reviewer)
- [x] Task 5: Live full-daemon end-to-end validation, executed with real captured evidence (2026-06-25)
- [x] Task 6: [NEW] Harden journal-write & daemon crash resilience (AF-301)
- [x] Task 7: [NEW] Fix permission-broker concurrency, keystroke validation & detector verb gap (AF-302, AF-306, AF-310, AF-311)
- [x] Task 8: [NEW] Runtime-validate external JSON inputs instead of type-assertions (AF-303, AF-312, AF-313)
- [x] Task 9: [NEW] Fix account/config/recovery correctness bugs (AF-314…AF-321)
- [x] Task 10: [NEW] Remove dead code, fix Map leaks & semantic tech-debt (AF-304, AF-307, AF-308, AF-309, AF-322, AF-323, AF-324)
- [x] Task 11: [NEW] Tighten secret redaction, worker-dir perms & injection paths (AF-305, AF-325, AF-326, AF-327)
- [x] Task 12: [NEW] Confirm-coverage (LOW) of the already-resolved Phase 3 isolation/security blockers (AF-201…AF-206; resolved per AF-R001…R007)
- [ ] Task 13: [NEW] Execute the deferred Full-System Validation suite (2026-06-17 Part A + Phase 1 live gates) (AF-101, AF-102)
- [x] Task 14: [NEW] Documentation & PRD sync (AF-501…AF-505)
- [x] Task 15: [NEW] Dependency-hygiene pass (AF-506)

## Implementation Tasks

### Task 1: `AISUP_HOME` state-dir isolation

**Objective:** Add an `AISUP_HOME` environment override that relocates the ENTIRE aisup state directory (config, pid, journal, ledger, sessions, channel-map, hooks settings, logs, worker store) so the live validation runs a real daemon fully isolated from the operator's `~/.aisup`. `AISUP_CONFIG` alone is insufficient — the daemon would still collide with and mutate operator state.

**Files:**

- Create: `src/config/paths.ts` (export `aisupHome(): string` = `process.env.AISUP_HOME ?? join(homedir(), '.aisup')`, read at call time)
- Modify: `src/config/loader.ts` (route join-sites through `aisupHome()` AND resolve the config-driven `journal.path` default through `aisupHome()` — see Key Decisions; the journal is NOT a join-site and the grep DoD cannot catch it), `src/daemon/index.ts`, `src/workers/store.ts`, `src/cli/pid.ts` (if present), and the `src/cli/commands/*` that compute `join(homedir(), '.aisup')` (accounts, attach, cost, daemon, failover, gate, init, log, start, status, stop, worker)
- Test: `tests/config/paths.test.ts` (new — 1 unit test class)
- Modify: `docs/runbook.md`

**Key Decisions / Notes:**

- Every current `join(homedir(), '.aisup', …)` / `AISUP_DIR` site (15 files, ~43 refs — enumerate via `grep -rn "AISUP_DIR\|'.aisup'\|\".aisup\"" src/`) routes through `aisupHome()`. Loader's config path becomes `join(aisupHome(), 'config.yaml')` computed **inside `loadConfig`** (call-time, so tests can set the env); the daemon/CLI module-level path consts may read `aisupHome()` at import since the live run sets the env before the process starts — note this nuance inline.
- **⛔ `journal.path` is the exception that the grep MISSES (review 2026-06-23 CR-001).** It is config-driven: `defaults.ts` ships `journal.path: '~/.aisup/journal.jsonl'` (a literal tilde string, NOT a `join(homedir(), '.aisup')` expression), and `loader.ts:expandPath` expands `~/` via `homedir()`. So routing join-sites alone leaves the journal at the operator's REAL `~/.aisup`. Fix inside `loader.ts`: when the raw config does NOT override `journal.path`, resolve the default from `aisupHome()` (e.g. `join(aisupHome(), 'journal.jsonl')`) in `validateConfig`/`loadConfig` — OR make `expandPath` map a leading `~/.aisup` segment through `aisupHome()`. Unset `AISUP_HOME` ⇒ identical to today's `~/.aisup` (no behavior change). A DEDICATED unit-test assertion is required because the DoD grep returns green while this stays broken.
- **`statusline.directory` is NOT relocated by `AISUP_HOME`** — it is telemetry INPUT written by the operator's statusline tap at a fixed shared path (`/tmp/pilot-failover`); moving it would break normal operation. It stays config-driven; only the Task 5 harness overrides it to an isolated path (HI-001). Do NOT route it through `aisupHome()`.
- `aisupHome()` reads the env on each call (no cached module const) so unit tests can flip it. Fallback is exactly today's `~/.aisup`, so no behavior change when unset.
- Do NOT relocate account `config_dir`s or `HOME` — those resolve real Claude auth and must stay pointed at the real `~/.claude*`. `AISUP_HOME` is aisup-state-only.

**Definition of Done:**

- [x] With `AISUP_HOME` set, the config path, pid path, journal path, and worker store dir all resolve under it; unset → all fall back to `~/.aisup` (no behavior change).
- [x] **`journal.path` specifically resolves under `AISUP_HOME` when set** — asserted by a DEDICATED test (`tests/config/paths.test.ts` or `loader.test.ts`), because it is config-driven and the grep below cannot catch it (CR-001).
- [x] `grep -rn "join(homedir(), '.aisup'" src/` returns no remaining direct call sites (all go through `aisupHome()`). NOTE: a green grep does NOT prove the journal is relocated — the dedicated journal test above is the real gate. *(Only match is `src/config/paths.ts` — the canonical `aisupHome()` fallback definition itself.)*
- [x] `docs/runbook.md` documents `AISUP_HOME` as the full-isolation override.
- [x] Verify: `npx vitest run tests/config/paths.test.ts tests/config/loader.test.ts` (vitest 3.2.4 rejects the `-q` flag — ran without it; 47 pass). Full suite: 681 pass / 0 fail / 7 skip.

### Task 2: Correct the shipped default codex worker adapter args

**Objective:** A real codex *worker* must both edit files in its worktree and emit JSON for the budget meter + reviewer verdict parser. The shipped default `['exec','--json']` cannot write; fix it to the full working args so an enabled codex worker functions out-of-the-box and the live validation's codex leg actually edits files.

**Files:**

- Modify: `src/config/defaults.ts`
- Modify: `tests/integration/WORKER_HOST_GATES.md`
- Test: `tests/config/loader.test.ts` (assert the default codex args)

**Key Decisions / Notes:**

- `defaults.ts` codex adapter `args = ['exec','--json','--skip-git-repo-check','-s','workspace-write']`; keep `output_format: 'json'`, `enabled: false`. One-line comment naming each flag (json = parser/meter; `-s workspace-write` = file edits; `--skip-git-repo-check` = harmless in a worktree, matches the operator's proven config).
- `--skip-git-repo-check` only relaxes codex's own refusal to run outside a git repo; it does NOT weaken aisup's workspace boundary audit, which is enforced independently by `auditBoundary`/`sanitizePatch` against aisup's pre-candidate snapshot. The worktree is a real git repo, so the flag is effectively a no-op there.
- Linchpin for the codex worker working at all (gates Tasks 3/4/5) — not `Trivial:`. Add a focused loader assertion that the default codex args include `exec`, `--json`, and `-s workspace-write`.

**Definition of Done:**

- [x] The shipped default codex adapter args include `exec`, `--json`, and `-s workspace-write`; `output_format` stays `'json'`. (`defaults.ts` → `['exec','--json','--skip-git-repo-check','-s','workspace-write']`)
- [x] WORKER_HOST_GATES.md states the required codex args for a JSON-emitting writable worker.
- [x] Verify: `npx vitest run tests/config/loader.test.ts` (41 pass; new defaults assertion green).

### Task 3: Real codex worker run — replace the `@requires_codex` placeholder

**Objective:** Replace the `@requires_codex` tier in `tests/integration/workers.smoke.test.ts` (today only asserts `env===1`) with a real `codex exec --json` worker run against a temp git repo that edits a file and whose output parses real `turn.completed.usage` via `codex-json`. First real-subprocess proof of the codex adapter + parser.

**Files:**

- Modify: `tests/integration/workers.smoke.test.ts`
- Modify: `tests/integration/WORKER_HOST_GATES.md`

**Key Decisions / Notes:**

- Reuse the file's temp-repo harness (isolated `workspace_root`, `afterEach` cleanup). Build a codex adapter with the Task-2 args, create a temp git worktree, run the real codex worker (`runWorker(buildWorkerCommand(codexAdapter, …))` or worktree-create→run→captureDiff), assert a non-empty diff scoped to the expected file + `parseCodexJsonStream(stdout)` → `usage.input_tokens > 0` and non-empty `finalText`.
- Host-gated `AISUP_TEST_CODEX=1`; skips clean (no ERROR) when unset or `codex` absent. No invented flags.

**Definition of Done:**

- [x] With `AISUP_TEST_CODEX=1`, a real `codex exec --json` worker edits a file in a temp git repo, producing a non-empty diff whose changed-files list contains the file the prompt named, and `parseCodexJsonStream` yields `usage.input_tokens > 0` + non-empty `finalText`. **EXECUTED 2026-06-23: PASS (60s, input_tokens=226383, README.md edited).**
- [x] Without the flag (or codex absent), the tier skips cleanly — never an ERROR. (verified: 3 host tiers skip)
- [x] Verify: `npx vitest run tests/integration/workers.smoke.test.ts` (skips the tier) and `AISUP_TEST_CODEX=1 npx vitest run tests/integration/workers.smoke.test.ts` (runs it). **Key finding:** the worker MUST close child stdin (`codex exec` blocks on an open stdin pipe), and codex auth is reached via `CODEX_HOME` while `HOME` stays isolated. `-q` flag removed (vitest 3.2.4 rejects it).

### Task 4: Real multi-provider failover host-gated test, reachable legs (no faked reviewer)

**Objective:** Replace the implementer-only, faked-review `tests/host-gated/worker-multiprovider.test.ts` with a real-subprocess matrix that exercises every *reachable* Part B failover leg through the real orchestrator, real worktree ops, real `runWorker`, and the **real `review.ts`** (no faked `reviewOutput`). codex→claude legs are excluded (unreachable under account-first — see Out of Scope).

**Files:**

- Modify: `tests/host-gated/worker-multiprovider.test.ts`

**Key Decisions / Notes:**

- Force the failing candidate cheaply (injected 429 via the exec wrapper's first call); the winning candidate runs a real `claude -p` / `codex exec --json` that edits a file. Reviewer legs use the real `review.ts` so a real reviewer subprocess returns a real `VERDICT:`.
- Reachable legs, each its own `it`, all gated `AISUP_TEST_MULTIPROVIDER=1`, skip-clean when unset, `afterEach` cleanup:
  1. **Implementer account-first (Truth 1):** `implementer=[claude(acctA forced-fail), claude(acctB real)]` → real claude winner → `AWAITING_APPROVAL`, diff scoped to the expected file; journal `candidate_failed`→`failover`→`completed`.
  2. **Implementer cross-LLM (Truth 2a):** `implementer=[claude(all forced-fail), codex(real)]` → real codex winner → `AWAITING_APPROVAL`; `worker.failover {cross_provider:true}`.
  3. **Budget gates codex (Truth 2b):** tiny codex budget (`tokens:1`) → codex unavailable; `implementer=[claude(all forced-fail), codex]` → `worker.all_candidates_exhausted` (codex's meter participates in exhaustion; no unbounded codex run).
  4. **Reviewer account-first / cross-LLM:** real `review.ts`; `reviewer=[claude(acctA forced-fail), claude(acctB real)]` → real claude reviewer yields a verdict (account-first reviewer failover); a separate case with `reviewer=[claude(all forced-fail), codex]` → real codex reviewer yields the verdict (`claude→codex`).
- Use real worktree ops against a `/private/tmp` scratch repo; resolve real account `config_dir`s from `loadConfig()`.

**Definition of Done:**

- [x] `AISUP_TEST_MULTIPROVIDER=1`: account-first leg → real claude winner, diff scoped to the expected file; journal `candidate_failed`→`failover`→`completed`. **EXECUTED 2026-06-24: PASS (73s, real `claude -p` on authed account[1]; status AWAITING_APPROVAL-or-REJECTED per real reviewer verdict — see note).**
- [x] Cross-LLM leg → real codex winner; `worker.failover {cross_provider:true}` + scratch file edited. **EXECUTED 2026-06-24: PASS (~110s, real `codex exec --json`).**
- [x] Budget leg (tiny cap, all-claude-down) → `worker.all_candidates_exhausted` with no codex subprocess run. **EXECUTED: PASS (deterministic, `codexRuns=0`).**
- [x] Reviewer legs → a real claude reviewer (account-first) and a real codex reviewer (cross-LLM) each yield a verdict through the real `review.ts` (no faked `reviewOutput`). **EXECUTED 2026-06-24: both PASS (account-first claude-reviewer failover 72s; cross-LLM codex-reviewer failover 108s).**
- [x] Unset flag → every leg skips cleanly (no ERROR). (verified: 5 legs skip)
- [x] Verify: `AISUP_TEST_MULTIPROVIDER=1 npx vitest run tests/host-gated/worker-multiprovider.test.ts` → **5 passed (372s)** in a single invocation. `-q` removed (vitest 3.2.4 rejects it).

> **✅ BLOCKER RESOLVED (2026-06-24) — Option C implemented + validated; plus a real account-auth finding.** Two production fixes (operator-approved): **(1)** `claude-adapter.ts` `buildClaudeWorkerCommand` now uses the **real `$HOME`** + the inherited daemon env (claude OAuth is in the macOS Keychain at `$HOME/Library/Keychains`, unreadable under an isolated HOME / stripped env). Validation gates keep their isolated HOME (HI-005) and codex keeps its isolated HOME via `CODEX_HOME` — only the claude implementer/reviewer subprocess gets the real HOME. File containment preserved by the worktree boundary audit + patch sanitize. **(2)** `defaults.ts` codex adapter `env_allowlist` gained `CODEX_HOME` so codex workers reach `~/.codex` auth under HOME isolation. **Proof:** `claude-worker.test.ts` PASS on an authed account; full 5-leg matrix PASS. **⚠️ Account-auth finding (operator action):** the **primary account `~/.claude` returns a 401** (stale token — re-login needed); accounts 2 & 3 are authed and were used for the real-winner roles. The legs use account[0] only as the forced-fail candidate, so the matrix is green despite the primary 401 — but **Task 5/13 live runs need the primary re-authenticated** for full per-account coverage.

> **⛔ BLOCKER (2026-06-23) — real `claude -p` worker primitive does not edit files in this environment.** When the claude worker runs with the operator's real `CLAUDE_CONFIG_DIR` (`~/.claude`) **and** the worker's isolated `HOME` (`<worktree>/.home`), Claude loads the operator's Pilot `UserPromptSubmit`/`SessionEnd` hooks (configured in `~/.claude` as `uv run … "$HOME/.pilot/hooks/spec_handoff_resume.py"`). With `HOME` isolated, `$HOME/.pilot/hooks/*` does not exist → the `UserPromptSubmit` hook fails → Claude **blocks the prompt** and returns `num_turns:0` with `result: "UserPromptSubmit operation blocked by hook: …"`, so **no edit is made** (empty diff in ~6s).
> - **Affected:** Task 4 claude-dependent legs (account-first implementer, claude reviewers) AND **Task 5 / Task 13** (which run real claude workers through the daemon). The codex worker primitive is unaffected (Task 3 PASS).
> - **Pre-existing, not introduced here:** the operator's own `tests/host-gated/claude-worker.test.ts` fails identically (empty diff, `num_turns:0`). The real claude worker was never exercised end-to-end before (Part B was verified via unit + fake-adapter tests; the prior live E2E used codex).
> - **What is done:** the comprehensive real-matrix test (5 reachable legs — account-first impl, cross-LLM impl, budget-gate, codex reviewer cross-LLM, claude reviewer account-first) is written, typechecks, skips clean, and the deterministic **budget-gate leg PASSES**. Robust cleanup added (lingering uv/npm cache writes in `.home` no longer ENOTEMPTY the teardown).
> - **⛔ DEEPER DIAGNOSIS (2026-06-24) — the real wall is OAuth, not (only) hooks.** Empirically determined with real `claude -p` runs:
>   1. claude's OAuth credentials live in the **macOS Keychain** (`security` item `Claude Code-credentials` in `~/Library/Keychains/login.keychain-db`), NOT a file in `CLAUDE_CONFIG_DIR`. The login keychain path is `$HOME/Library/Keychains/…`, so the worker's isolated `HOME=<worktree>/.home` → claude can't find the keychain → **"Not logged in · Please run /login"** (`num_turns:1`, no edit). The earlier hook-block (`num_turns:0`) was *masking* this auth failure.
>   2. `--settings '{"disableAllHooks":true}'` (the Option-A mechanism) **breaks auth on its own** → **"401 Invalid authentication credentials"**, even with real HOME. So disabling hooks via `--settings` is a dead end.
>   3. **Clean baseline — real HOME, full env, no `--settings` — WORKS**: claude authed and edited the file (`is_error:false`, `num_turns:4`, 42s). With real HOME the Pilot hooks also resolve (`$HOME/.pilot` exists), so they no longer block.
> - **Conclusion:** the only proven-working config for a real claude worker is **the real `$HOME`**. The worker's `.home` isolation (MD-003/HI-005) is fundamentally incompatible with claude's keychain-based OAuth. Option A (disable hooks) does NOT fix it.
> - **Revised options (operator decision):** **(C)** run claude workers with the real `$HOME` — proven working; trade-off: relaxes the `.home` isolation so a worker *could* touch `~/` config dirs outside the repo (the repo/worktree boundary audit + patch sanitize still apply, and `$HOME`-resolved writes still never enter the worktree-scoped captured diff). **(keychain-symlink)** keep isolation, symlink `~/Library/Keychains` into `.home` — fragile (keychain ACL/unlock), untested, not recommended. **(defer)** accept that real claude workers don't run under isolation here; close with codex-only validation and document the OAuth-vs-isolation conflict as a design item. Needs your call (affects shipped Part B + the worker isolation guarantee + Task 5/13).

### Task 5: Live full-daemon end-to-end validation, executed with real captured evidence

**Objective:** The most realistic, fully-real, no-mocks validation to date — a committed runnable harness that stands up a real daemon under an isolated `AISUP_HOME`, runs real `aisup worker dispatch` against a `/private/tmp` scratch repo, forces every *reachable* failover leg for real, and captures the real journal + Slack + `worker providers` evidence into a validation log. Executed live during verification (real spend, real Slack post).

**Files:**

- Create: `scripts/validation/live-multiprovider-failover.sh`
- Modify: `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` (append `## Real-run Validation` log)
- Modify: `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md` (append the same evidence AND correct its Truth 2 wording — strike the unreachable "codex-default fails over to an available Claude account" clause, replace with the budget-gates-codex behavior, citing this plan)

**Key Decisions / Notes:**

- **⛔ Hard dependency on Tasks 1 + 2.** Cannot run until `AISUP_HOME` isolates state (Task 1) and codex args are correct (Task 2). **Fail-fast preflight (abort, do not dispatch, if any fail):** (a) the chosen non-default `daemon.port` is free; (b) the daemon actually loaded the throwaway config (assert `aisup worker providers` reflects the throwaway `roles`); (c) `AISUP_HOME` points at the temp dir (not `~/.aisup`); (d) **all accounts report `unknown` basis** in `aisup worker providers` before any dispatch — proves no shared statusline telemetry leaked into the isolated ledger, so the account-first candidate order is deterministic config order (HI-001).
- **⛔ Per-leg config matrix (review 2026-06-23 ME-001) — the three legs have MUTUALLY-EXCLUSIVE account/budget states that ONE loaded config cannot satisfy.** The account-first leg needs a real Claude account AVAILABLE to win (Truth 1); the cross-LLM/budget legs need ALL claude UNAVAILABLE so failover crosses to codex; and per-dispatch `--implementer/--reviewer` PINS a single candidate with NO failover (`orchestrator.ts:82,143`) so it cannot drive a failover leg — failover legs must run through `config.roles` against the GLOBAL account-availability state (`daemon/index.ts:205-207`). Codex availability is `tokens_used < cap` (`codex-usage.ts:14,23`), so a single tiny budget cannot serve both "codex wins" (under budget) and "codex gated" (over budget). The harness therefore runs **each leg as its own short daemon lifecycle**: stop → rewrite the config under the SAME isolated `AISUP_HOME` → restart → preflight → dispatch. Per-leg configs:
  - **Leg A — account-first (Truth 1):** `accounts=[no-auth (listed FIRST), ≥1 real authed]`; default roles `[claude(accounts), codex]`. Preflight: `worker providers` shows ≥1 claude available (all `unknown` basis). Expect `worker.candidate_failed`→`worker.failover`→`worker.completed`→`worker.awaiting_approval` with a REAL-account winner editing the scratch file.
  - **Leg B — cross-LLM (Truth 2a):** `accounts=` all no-auth claude entries (every claude account fails auth); codex `budget` AMPLE (≥ one run, e.g. the 3M default). Preflight: all claude unavailable, codex available. Expect a real `codex exec --json` winner + `worker.failover {cross_provider:true}`.
  - **Leg C — budget-gate (Truth 2b):** `accounts=` all no-auth claude; codex `budget` already CROSSED (tiny, e.g. `tokens:1`) — OR run Leg C in the SAME daemon right after Leg B has consumed the budget. Preflight: all claude unavailable, codex `budget_exhausted`. Expect `worker.all_candidates_exhausted` with NO codex subprocess run.
- The harness: (1) creates `AISUP_HOME=/private/tmp/aisup-val-<uuid>` and writes the FIRST leg's config there (per the matrix above) — Claude accounts by ABSOLUTE `config_dir`, a codex adapter with the Task-2 args + a `budget` SIZED PER LEG, the operator's `slack` block (enabled) copied so a real post can fire, a non-default `daemon.port`, **`journal.path` set EXPLICITLY to an absolute path under `AISUP_HOME` (CR-001 belt-and-suspenders — even with the Task 1 fix), `statusline.directory` set EXPLICITLY to an isolated path under `AISUP_HOME` so the daemon never ingests the operator's shared `/tmp/pilot-failover` telemetry (HI-001)**, and explicit `roles.implementer=[claude(accounts), codex]` / `roles.reviewer=[claude(accounts), codex]`; (2) creates a `/private/tmp` scratch git repo (init + one commit); (3) `npm run build`, then `source ~/.aisup/secrets.env && AISUP_HOME=<temp> node dist/daemon/index.js` in background, polls health; (4) captures `worker providers` (also serves the per-leg preflight availability check); (5) starts a real supervised lead session so a Slack channel maps; (6) runs each leg per the matrix above — rewriting the config under the SAME `AISUP_HOME` and restarting the daemon between legs (the account-first no-auth candidate is listed FIRST so it is TRIED first → real `claude -p` auth fail → real `worker.candidate_failed`, bounded by a timeout); (7) reads the isolated `AISUP_HOME` journal for each leg's failover chain and confirms the Slack `claude→codex` post; (8) tears down: stop the session + daemon, remove the scratch repo and the entire `AISUP_HOME` temp dir.
- ⛔ Never read or write the operator's real `~/.aisup` — assert the real `~/.aisup/config.yaml` sha256 AND the real `~/.aisup/journal.jsonl` mtime+size are unchanged across the run (the journal assertion guards against the CR-001 leak where an un-relocated journal would silently append validation events to operator state).
- Forcing fallback (per Assumptions): bound the forced-fail `claude -p` with a timeout; if it hangs instead of erroring, pre-seed ISOLATED statusline telemetry giving the failing account the highest headroom so it still sorts first and is ATTEMPTED (yielding a real `worker.candidate_failed`) — do NOT use a reactive-unavailable mark, which drops the candidate pre-attempt and emits no `candidate_failed`. Record which mechanism was used.
- Executed during `spec-verify` Phase B (the isolated daemon is the live target); the harness is committed so the run is reproducible.

**Definition of Done:**

- [x] `scripts/validation/live-multiprovider-failover.sh` exists, is runnable, isolates all state under a temp `AISUP_HOME` (including `journal.path` and `statusline.directory` set under it), and tears down the daemon + scratch repo + temp `AISUP_HOME` without touching the operator's real `~/.aisup` (real `config.yaml` sha256 AND real `journal.jsonl` mtime+size asserted unchanged). **BUILT 2026-06-25** — per-leg config matrix, isolated daemon lifecycle, HI-001 `unknown`-basis preflight, no-auth forcing (validated: empty `CLAUDE_CONFIG_DIR` → "Please run /login" → `auth_failed` failover), ledger pre-seed for the Leg C budget gate, operator-state sha/mtime safety assertions, EXIT-trap teardown. `bash -n` syntax-clean. **Live execution pending — to be run with the operator (re-login primary first; needs Slack + live daemon + real spend).**
- [x] Preflight passes: `aisup worker providers` shows all accounts at `unknown` basis before dispatch (deterministic config-order candidate selection — HI-001). **(2026-06-25)**
- [x] EXECUTED live: account-first leg shows real journal `worker.candidate_failed`→`worker.failover`→`worker.completed`→`worker.awaiting_approval` with a real `claude -p` winner editing the scratch file. **(2026-06-25, worker `d7b591ad`)**
- [x] EXECUTED live (**Leg B config: all-claude no-auth + AMPLE codex budget**): a cross-LLM dispatch shows real journal `worker.failover {cross_provider:true}` with a real `codex exec --json` winner. **Slack:** lead session could not start (Leg A session still active), so the `cross_provider:true` journal event is the recorded DoD-fallback evidence. **(2026-06-25, worker `06b2d6a5`)**
- [x] EXECUTED live (**Leg C config: all-claude no-auth + CROSSED codex budget**): a dispatch terminates `worker.all_candidates_exhausted` with no codex subprocess (budget gates codex). **(2026-06-25, worker `f44bb5e4`)**
- [x] `aisup worker providers` output (codex tokens-remaining vs budget + basis, claude basis) captured (see Real-run Validation). **(2026-06-25)**
- [x] Real captured evidence appended as `## Real-run Validation` to BOTH this plan and `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md`; the Part B Truth 2 wording corrected there. **(2026-06-25)**
- [x] Verify: `bash scripts/validation/live-multiprovider-failover.sh` runs end-to-end (exit 0) and the validation log is populated with the real evidence above. **(2026-06-25)**

## Real-run Validation — live full-daemon run (2026-06-25)

Executed `scripts/validation/live-multiprovider-failover.sh` against a real state-isolated daemon (`AISUP_HOME=/private/tmp/aisup-val-EAECD3C9…`, port 7397, `/private/tmp` scratch git repo), real `aisup worker dispatch`, real `claude -p` + `codex exec --json` subprocesses. **Exit 0**; operator `~/.aisup` config sha256 + journal mtime/size asserted unchanged. Per-leg daemon lifecycle with a worker-id-scoped terminal poll — each leg ran its own worker (real timings: A 60s, B 2m13s, C 3s).

- **Truth 1 — account-first failover (Leg A, worker `d7b591ad`):** `worker.candidate_failed{auth_failed, claude:noauth}` → `worker.failover{noauth→authed, cross_provider:false}` → `worker.completed{changed_files:["README.md"]}` → `worker.validated` → `worker.review_started` → `worker.review_passed{verdict:approve}` → `worker.awaiting_approval`. Real account edited the scratch README (clean, **README-only** patch); reviewer parsed and **APPROVED**. ✓
- **Truth 2a — claude→codex cross-LLM (Leg B, worker `06b2d6a5`):** `worker.candidate_failed{auth_failed, claude:noauth1}` → `worker.failover{noauth1→codex, cross_provider:true}` → codex `worker.completed` → `worker.validated` → `worker.review_passed` → `worker.awaiting_approval`. Real `codex exec --json` winner. ✓ Slack post did not fire (lead session blocked by Leg A's still-active session — *"Session operation in progress"*); the `cross_provider:true` journal event is the recorded DoD-fallback evidence (notifier: `notifyCrossProviderFailover`, `orchestrator.ts`).
- **Truth 2b — codex budget gate (Leg C, worker `f44bb5e4`):** `aisup worker providers` preflight reported `codex UNAVAILABLE 0 tokens left basis=budget (budget_exhausted)`; dispatch → `worker.candidate_failed` → `worker.all_candidates_exhausted` → `worker.cleanup`, **no codex subprocess**. ✓
- **Truth 3 — live provider readout:** `aisup worker providers` (per-leg preflight) showed live availability — `codex … 3000000 tokens left basis=budget` + claude accounts `basis=unknown` (Legs A/B), flipping to `codex UNAVAILABLE 0 tokens left basis=budget (budget_exhausted)` in Leg C. ✓

**Product fixes made during this validation** (real subprocess output exposed gaps the fake-adapter tests could not):

1. **Tool-data dirs polluted the captured patch.** The worker's real `$HOME` (required for keychain OAuth) loads the operator's CodeGraph SessionStart hook (`~/.pilot/hooks/codegraph_init.py` → `.codegraph/`) + Serena MCP (`.serena/`); in a workspace that does not gitignore them they entered the captured diff and broke reviewer verdict parsing. **Fix:** `worktree.ts` `DIFF_EXCLUDE_DIRS = ['.home/','.codegraph/','.serena/']` excluded from `captureDiff` + the worktree `info/exclude` (same mechanism already used for `.home/`). Worktree isolation was **kept** — the operator considered removing it but it is the reviewed safety boundary; the painful HOME/env isolation was already reverted (Option C).
2. **`runWorker` tail-truncated stdout (2000 chars) before it was JSON-parsed**, corrupting the reviewer verdict (claude `--output-format json` / codex `--json` are single JSON values) and worker/codex usage. **Fix:** `runWorker` returns FULL stdout/stderr; tail truncation moved to the persistence sites via `tailOutput`. Tests: `runner.test.ts` (full-stdout + `tailOutput`), and the prior `claude-adapter` MCP-flag attempt was reverted (see below).
3. **Harness:** the terminal-state poll was scoped to each leg's worker id (an unscoped poll let one leg's terminal event short-circuit later legs); the prior `--strict-mcp-config`/`--mcp-config` MCP-disabling attempt was reverted — `--mcp-config` is variadic and swallowed the prompt, and it could not stop the hook-created `.codegraph/` anyway.

Full suite green after the fixes: `npx vitest run` → **712 pass / 11 skip / 0 fail**.

---

## Audit Findings (2026-06-23)

**Method.** Read-only multi-pass audit: PRD + all 8 phase plans + 9 reviews + 10 handoffs reconciled against the working tree; git history walked for the phase commits; `npm run typecheck` (exit 0), `npm run build` (success), `npx vitest run` (**675 pass / 0 fail / 7 skip**) run live; all 19 `src/` subsystems + the gated test suite read; the user-facing surface mapped and each workflow walked. ~180 raw candidate findings were harvested by a fan-out of read-only investigators, then **deduplicated against the existing 5 tasks + accepted deviations, triaged, and the critical/high set independently re-verified against the code** (3 agent-reported "highs" were rejected as false positives — see Coverage Report). What remains below is the triaged set, grouped by the five checks.

**Severity legend:** `critical` (data loss / crash / security) · `high` · `medium` · `low` · `enhancement`. **`[verified]`** = the maintainer re-read the cited code and confirmed the finding this pass. **`[agent-reported]`** = surfaced by the fan-out with a file:line but not independently re-verified in this pass (triage during implementation). **Dedup:** findings already owned by Tasks 1–5 or the Out-of-Scope list are referenced, not re-stated.

### Check 1 — Tech-debt & deferral sweep

| ID | Sev | Category | Finding & Evidence | Why it matters | Resolution |
|----|-----|----------|--------------------|----------------|------------|
| AF-101 | high | compliance-gap | **The entire Full-System Validation suite (plan `2026-06-17`, Part A Features A–K + deep-dives S1–S4) is defined but never executed.** All 17 rows are `pending-verification` (lead daemon, account selection, proactive failover, reactive recovery matrix, Slack sweep, journal/status, skill propagation, permission broker, gate engine, cost tracking, worker pipeline). `[verified]` via plan read. | Almost every product Truth outside Part B's unit/host-gated coverage rests on a *manual* suite nobody has run; "done" is unproven for the lead-session half of the product. | Promote to Task 13 — execute the suite against the isolated `AISUP_HOME` daemon (built by T1/T5) and record evidence. |
| AF-102 | medium | compliance-gap | **Phase 1 Task 13 "live acceptance gates" + the "wire real 429/rate-limit pattern detection against live output" next-action remain operator carryover** (`2026-05-06-phase1-full-implementation-review.md:5-6,190,194`). Loops are wired to real telemetry but automatic switch triggering is unvalidated against live Claude output. `[verified]` via review read. | The core proactive-failover trigger has never been proven end-to-end against a real session. | Fold into Task 13. |
| AF-103 | medium | bug | **Permission detector regex lacks the `create` verb** — `src/permissions/detector.ts:18` matches `proceed|continue|make this edit|run this` but not `create`; documented live in `2026-06-17` validation plan (~line 288): a real "Do you want to create permtest.txt?" prompt never fires `permission.detected`. Unit tests use synthetic strings so CI stays green. `[agent-reported]` | A whole class of real permission prompts silently bypasses the broker (pane-output fallback path). | Add `create` (and audit the real Claude verb set) to the pattern; add a test using the real prompt strings. Task 7. |
| AF-104 | low | tech-debt | **`resume_prompt_mode` defaults to `never`** (`src/config/defaults.ts:55`), so detected skills are journaled but never re-injected on failover by default (`continuation.ts`). `[agent-reported]` | Phase 1 Task 11 "carry skill across failover" is effectively off out-of-the-box; operators may not realize continuation requires opt-in. | Document the trade-off in runbook; consider `on-failure` default. Task 14. |
| AF-105 | low | test-integrity | **Gemini / local-LLM placeholder tiers (`workers.smoke.test.ts:242-251`) only `expect(env==='1')`** — they prove nothing and will never run (providers not installed). **Accepted-deviation** (config-only providers, Out of Scope). | No action needed; flagged for honesty — these are not "covered" behaviors. | Leave as-is per Out of Scope; ensure they continue to skip-clean. |

### Check 2 — Compliance audit (plan ↔ code ↔ PRD)

Phase 1 blocking-review MUST-FIX #1–#7 were each **confirmed implemented** (single-session predicate `cli/pid.ts:37-78`; `switch_tx.attempts` `session/types.ts`; complete event union `journal/types.ts`; tmux identity fields; soft-threshold deferral; `readTelemetryForActiveSession`; bidirectional rehydration). Phase 2 (recovery/cost/permissions/gates) and Phase 3 worker pipeline audited **compliant** (tests green, typecheck clean). The gaps below are the residue.

| ID | Sev | Category | Finding & Evidence | Why it matters | Resolution |
|----|-----|----------|--------------------|----------------|------------|
| AF-201 | high | security | **Phase 3 HI-001 (plan-review blocker): worker validation gates can run *outside* the worktree if a gate sets its own `cwd`** — gate engine gives `gate.cwd` precedence (`gates/engine.ts:65-66`). Status open per `2026-06-02-plan-review-phase3:114-147`; not confirmed resolved. `[agent-reported / verify]` | A gate escaping the worktree defeats worker isolation. | Verify; if open, enforce `gates[*].cwd` null for worker gates. Task 12. |
| AF-202 | high | security | **Phase 3 HI-005: worker gates inherit the daemon's real environment, incl. `$HOME`** (`2026-06-02-plan-review-phase3:253-285`) — a gate can resolve to the operator's real home, bypassing the worktree's temp HOME. `[agent-reported / verify]` | Worker isolation guarantee is only as strong as the gate env. | Verify; if open, run gates with an isolated `HOME`/env. Task 12. |
| AF-203 | high | security | **Phase 3 HI-002: raw patch/output artifacts persisted *before* `sanitizePatch`** (`2026-06-02-plan-review-phase3:150-182`) — forbidden content can hit `patch.diff`/`output.json` before rejection, violating "secrets never in artifacts." `[agent-reported / verify]` | Secret leakage to disk even on rejected patches. | Verify; sanitize before first persist. Task 12. |
| AF-204 | high | bug | **Phase 3 HI-003: rehydrating a `MERGING` worker as `FAILED` misreports an already-applied patch** (`2026-06-02-plan-review-phase3:185-217`) — `git apply` may have succeeded before a daemon restart; durable state says FAILED while the workspace changed. `[agent-reported / verify]` | Operator trusts a "failed" verdict while their tree was modified — silent divergence. | Verify; reconcile via apply-check on rehydrate. Task 12. |
| AF-205 | medium | security | **Phase 3 HI-004: boundary audit misses *content* changes to pre-existing ignored files** (`.env`, transcripts) — `git status --porcelain --ignored` catches new ignored paths, not edits to existing ones (`2026-06-02-plan-review-phase3:219-250`). `[agent-reported / verify]` | A worker editing an existing `.env` escapes the diff-scoped guarantee. | Verify; snapshot hash/mtime of forbidden globs before/after. Task 12. |
| AF-206 | medium | bug | **Phase 3 HI-006: apply-conflict recovery leaves `approval.granted=true`** (`2026-06-02-plan-review-phase3:288-316`) — on `git apply --check` failure the worker stays AWAITING_APPROVAL but approved, so a later retry may merge without fresh approval. Plus IN-101 (`apply` error after `--check` passes) and LO-101 (reviewDir cleanup owner). `[agent-reported / verify]` | Human-approval gate can be bypassed on a retry. | Verify; reset approval on apply failure. Task 12. |
| AF-207 | medium | compliance-gap | **`workers.routing.default_implementer: 'codex'`** (`src/config/defaults.ts:164`) implies codex is the default implementer, but the account-first selector (`providers/selector.ts`) always orders every Claude account first — codex is structurally secondary. `[verified]` | Misleading config semantics; an operator reading defaults expects codex-first behavior that can't happen. | Rename/clarify the field or its comment to reflect account-first reality. Task 10. |
| AF-208 | low | compliance-gap | **Part B Truth 2 wording is unreachable** (codex→Claude failover). **Already owned** by this plan's Out of Scope + Task 5 (corrects both plans' wording). Referenced, not re-stated. | — | Closed by Task 5. |

### Check 3 — Code quality / architecture / security review

| ID | Sev | Category | Finding & Evidence | Why it matters | Resolution |
|----|-----|----------|--------------------|----------------|------------|
| AF-301 | high | bug | **A journal write failure crashes the supervisor daemon.** There is **no `process.on('unhandledRejection')` handler** (only SIGTERM/SIGINT, `daemon/index.ts:814-815`). `writer.ts:42` re-throws every non-ENOSPC error (and `scanForSecrets` throws synchronously at `writer.ts:17`); these propagate from ~9 fire-and-forget `void d.journal.append(...)` / `void d.onGateTrigger(...)` sites (`loop-manager.ts:386,169,185,215,342,599,677,694`; `recovery/exhausted.ts:51,65`) → unhandled rejection → on Node 22 the process **exits**, dropping the live session. Conversely, ENOSPC is *silently swallowed* (`writer.ts:38-40`) → audit-critical events vanish with no signal. Opposite failure modes, both wrong. Related: gate HTTP/Slack handlers unguarded (`server.ts:250-253`, `slack/service.ts` `!gate`); `RotatingLog.write`/`writeFileSync` can throw from the stdout/stderr override (`util/rotating-log.ts:48,93`). `[verified]` | The daemon's one job is to keep sessions alive; a transient disk/permission hiccup or a stray secret-shaped key takes it down — and disk-full silently corrupts the audit trail. | Add a global `unhandledRejection`/`uncaughtException` handler that logs + best-effort journals without exiting; add `.catch()` to every fire-and-forget journal/gate site; pick **one** consistent journal-failure policy (recommend: never throw from `append`, return a typed failure + emit a health signal); guard the gate HTTP/Slack handlers. Task 6. |
| AF-302 | medium | bug | **Concurrent permission prompts overwrite each other.** `hookPermissions` is a `Map<sessionId, PermissionRequest>` (1 per session, `daemon/index.ts:269,343`); a second `permission.ask` for the same session before the first resolves overwrites it (`:343`), orphaning the first — `!permit` then resolves only the latest while the first dialog hangs. `[verified]` | Parallel tool prompts (legitimately stackable) leave a dialog hung indefinitely. | Key by `${sessionId}:${tool}:${detail}` or queue FIFO; resolve earliest-pending. Add a concurrent-prompt test. Task 7. |
| AF-303 | medium | bug | **External telemetry is type-asserted, not validated.** `statusline/store.ts:55` does `JSON.parse(raw) as StatuslineTelemetry`; `:89-91` calls `transcriptPath.startsWith(...)`. Valid-JSON-but-wrong-type telemetry (e.g. `transcript_path: 123`) throws `TypeError` and is *not* caught by the `invalid_json` guard. Same pattern in `daemon/rehydration.ts:87` and `session/manager.ts:77-81` (silent `null` on parse error, no journal). `[verified]` | Corrupt telemetry/state files (written by an external process) crash or silently drop a session with no diagnostic. | Add runtime field validation (typeof/schema) after parse; emit `telemetry.invalid_json` / a state-corruption event instead of crashing/silently nulling. Task 8. |
| AF-304 | low | bug | **`clearRecoveryCounters` leaks Maps.** It deletes only `restartAttempts` + `networkErrors` (`loop-manager.ts:654-657`); `lastGateRun`, `lastNoTargetNotice`, and `costState` accumulate one entry per session-id for the daemon's lifetime (`:98,102,104,335`; `costState` only cleared on clean stop per #59). `[verified]` | Slow unbounded memory growth on a long-running daemon with many session cycles. | Extend `clearRecoveryCounters` to delete all per-session Maps. Task 10. |
| AF-305 | low | security | **4 `mkdir` sites omit `mode:0o700`** while 15 others set it: `workers/worktree.ts:93`, `workers/review.ts:150`, `session/tmux.ts:65,145`. tmux **session-output log dirs** and worker dirs are created group/world-traversable (umask-dependent). `[verified]` (the agent's `daemon/index.ts:89` claim was a false positive — that call *does* set `0o700`). | Session output logs can contain sensitive prompt/output; a traversable dir weakens the 0o700 intent applied everywhere else. | Add `mode:0o700` to the 4 sites for consistency. Task 11. |
| AF-306 | low | bug | **Keystroke validation accepts multi-char/multi-byte input.** `validateKeyInput` (`config/loader.ts:78`) rejects only control chars; `approval_key: "yes"` or an emoji passes, then is sent to tmux verbatim (`daemon/index.ts:273`). `[verified]` | Footgun: a mistyped multi-char key silently fails to resolve dialogs. | Restrict to a single ASCII printable (`/^[\x20-\x7E]$/`). Task 7. |
| AF-307 | low | bug | **`buildProviderUsageReport` omits the `orchestrator` role** — `providers/report.ts:38-41` iterates only implementer+reviewer though `RolesConfig` includes orchestrator. `[verified]` (may be intentional since orchestrator isn't a worker execution role — **investigate** before "fixing"). | `aisup worker providers` can't show orchestrator candidate availability. | Decide: include orchestrator, or document why it's excluded. Task 10. |
| AF-308 | low | tech-debt | **Unused `CreateSessionOpts.accountConfigDir`** (`session/manager.ts:32`; passed `''` at `:192`). `[verified]` interface field. | Dead parameter confuses callers / signals incomplete refactor. | Confirm unused via callers, then remove. Task 10. |
| AF-309 | low | test-integrity | **`resolveSkillFromCommandName` tested in the wrong module** — `tests/hooks/claude-hooks.test.ts:37-54` tests a `src/skills/` function already covered by `tests/skills/detector.test.ts`. `[verified]` | Cross-module test coupling; refactor-fragile. | Move those cases to the skills test file. Task 10. |
| AF-310 | medium | tech-debt | **Permission hook timeout default contradicts the daemon's intent** — `hooks/claude-hooks.ts:53` defaults `permissionTimeoutS ?? 600` (10 min) while the daemon passes `30` and documents "short is plenty" (`daemon/index.ts:71,145`). `[agent-reported]` | Trap for future callers; a 10-min default would hang the hook path. | Change the function default to 30 (or require the arg). Task 7. |
| AF-311 | medium | bug | **`idleEmitted` not reset when a skill completes mid-idle** — `loop-manager.ts:373-390`: skill completion clears `active_skill` but leaves the session in `idleEmitted`, so the next genuine idle won't re-fire `onIdle`. `[agent-reported]` | Missed idle events after a gate-triggering skill completion. | Reset `idleEmitted` on skill-completion clear; add a test. Task 7. |
| AF-312 | medium | bug | **`rehydration.ts:87` silently returns `null` on malformed `state.json`** (parse error caught, no journal) — the loop skips the session unmonitored. `[agent-reported]` | A corrupt state file silently drops a session from supervision. | Validate + emit a corruption event. Task 8. |
| AF-313 | medium | bug | **`session/manager.ts:77-81 readState` swallows JSON parse errors, returns null, no log.** `[agent-reported]` | Same silent-drop class as AF-312. | Same fix family. Task 8. |
| AF-314 | medium | bug | **`AccountRegistry.applyTelemetry` does not clear `cooldownUntil` on UNAVAILABLE→DEGRADED/HEALTHY** (`accounts/registry.ts:58-65`) — a recovered account keeps a stale cooldown timestamp. `[agent-reported]` | Stale cooldown can mislead selection/observability. | Null `cooldownUntil` on transition to runnable states; add the transition test (#123). Task 9. |
| AF-315 | medium | bug | **No `soft_pct < hard_pct` validation** — `config/loader.ts:404-411` range-checks each but allows `soft=95,hard=85`, inverting the failover semantics. `[agent-reported]` | A swapped-threshold config silently breaks proactive failover. | Add the ordering check. Task 9. |
| AF-316 | medium | bug | **`resumeExhaustedSession` does not validate `targetAccount`** against enabled/available accounts before `performSwitch` (`recovery/exhausted.ts:154-190`). `[agent-reported]` | An invalid target fails mid-switch instead of being rejected cleanly. | Validate target up front. Task 9. |
| AF-317 | medium | bug | **`buildEnv` accepts unvalidated `accountConfigDir`** (null/empty/newline/NUL) (`runner/builder.ts:6-8`); a null becomes the literal `"null"` path → confusing auth failure. `[agent-reported]` | Misconfig produces a cryptic runner failure. | Validate non-empty, no control bytes. Task 9. |
| AF-318 | medium | bug | **`config_dir_env` never validated as a POSIX env-var name** (`runner/types.ts:3`, used as a bare key in `builder.ts`); a hyphen/space breaks the tmux `-e` assignment. `[agent-reported]` | Silent runner env corruption. | Validate against `/^[A-Za-z_][A-Za-z0-9_]*$/`. Task 9. |
| AF-319 | medium | bug | **`validateRunner` conflates failure modes** — its `catch` reports "command not found on PATH" for `which`-missing, EACCES, and genuine not-found alike (`runner/builder.ts:66-72`). `[agent-reported]` | Misleading diagnostics during setup. | Distinguish the error causes. Task 9. |
| AF-320 | low | bug | **No `freshness_window_s` validation** — negative values make all telemetry appear stale (`config/schema.ts:101`, used `store.ts:72`). `[agent-reported]` | A negative config silently disables telemetry-based scoring. | Add min-bound validation. Task 9. |
| AF-321 | low | bug | **No `used_pct` bounds check in scoring** — `accounts/scorer.ts:36-37` computes headroom with no clamp; `>100%` yields negative headroom. `[agent-reported]` | Out-of-range telemetry corrupts scores. | Clamp to [0,100]. Task 9. |
| AF-322 | low | tech-debt | **Dead `SkillTracker` class** — fully tested (`skills/tracker.ts`) but never instantiated in production (loop-manager calls `detectSkill()` directly). Plus unused `ContinuationOpts.template` (`skills/continuation.ts:4`) and `active_skill` lifecycle inconsistency vs `SkillTracker.reset()`. `[agent-reported]` | Dead code + an unused public surface to maintain. | Remove or wire `SkillTracker`; drop the unused template path or expose it. Task 10. |
| AF-323 | low | test-integrity | **Stale skill-detector tests** — `tests/skills/detector.test.ts` exercises the deprecated `detectSkill()` pane-scraper (no longer the live path since hooks `ab4e313`) using synthetic strings, so removal of the `Launching skill:` marker in newer Claude Code would never be caught. `[agent-reported]` | False confidence in a dead path; the live `resolveSkillFromCommandName` path isn't fuzzed against real output. | Mark the scraper as fallback-only; add a real-output test for the hook path. Task 10. |
| AF-324 | low | bug | **`failoverInProgress` reset relies on `.finally` across async `onSwitch`** (`loop-manager.ts:224-258` etc.) — coarse guard; overlapping ticks rely on a single boolean. `[agent-reported]` (lower risk than it reads — single-threaded loop). | Edge-case double-trigger window. | Confirm guard adequacy; document or tighten. Task 10. |
| AF-325 | medium | security | **`SECRET_KEY_PATTERN` misses vendor-prefixed secret *values*** — `journal/writer.ts:5` blocks key *names* (`token|secret|apikey|…`) but not values like `sk_…`, `ghp_…`, `pk_…`. `[agent-reported]` | A secret stored under an innocuous key name slips into the journal. | Add value-pattern scanning for common provider prefixes. Task 11. |
| AF-326 | medium | security | **Continuation prompt template allows newline/text injection** — `skills/continuation.ts:11-13` substitutes `{skill}`/`{plan_path}` without escaping; a crafted `active_skill` injects newlines into the resumed prompt. `[agent-reported]` | Prompt-injection vector via skill/plan names. | Escape/validate substituted values; add an injection test. Task 11. |
| AF-327 | low | security | **`POST /api/hooks/permission` accepts `tool_input` unvalidated** (`server.ts:292`) and `conversations.invite` errors are swallowed (`slack/service.ts:161-167`); `POST /api/sessions` returns `201 "deps not wired"` when critical deps are missing (`server.ts:186-188`) rather than failing loudly. `[agent-reported]` | Minor DoS/observability gaps; a misconfigured daemon looks healthy. | Validate hook payload size/shape; log invite failures; fail loudly on missing deps. Task 11. |

> **Additional `[agent-reported]` low-severity items** (triage during implementation, not separately tasked unless promoted): missing token-file existence checks → ENOENT (`cli/commands/{attach,failover,stop,worker}.ts`, #50); ENOENT-on-missing-output-log logged as queue-drop (`slack/service.ts:534-588`, #158); imprecise relay "reason" logging (`slack/service.ts:301-313`, #90); `readEvents` loads whole file (`journal/reader.ts`, #140, perf); `listStatuslineFiles` no early-exit (`scorer.ts:19-34`, #124, perf); case-sensitive skill prefix match (`detector.ts:19-26`, #88); over-broad hook-install catch (`daemon/index.ts:136-151`, #137); gate status can't distinguish signal-kill from non-zero exit (`gates/engine.ts:35-38`, #64); `daemonStart` doesn't await readiness (`cli/commands/daemon.ts:46-52`, #126). Historical items already fixed in git (`d8c5e0c` restart-loop bound #45, `1d46673` daemon build entry #46, `ce5a8ce` 429 false-positive #47, `d79e343` continuation cosmetics #118) are **not** findings.

### Check 4 — User-perspective feature discovery → see `## Deferred Ideas`

The current-capability map and the user-workflow feature ideas (enhancements, not defects) are in the dedicated **`## Deferred Ideas`** section below to keep them clearly separated from the bug/gap findings above.

### Check 5 — Docs / config / dependency hygiene

| ID | Sev | Category | Finding & Evidence | Resolution |
|----|-----|----------|--------------------|------------|
| AF-501 | medium | docs | **PRD Feature Inventory still lists G and H₂ as "In progress (Phase 3)"** (`docs/prd/2026-04-29-ai-supervisor.md`) though both shipped (Phase 3 `46eb76f`, Part B `2ab8440`). `[agent-reported]` | Update rows to "Implemented (Phase 3 / Part B)". Task 14. |
| AF-502 | low | docs | **`runbook.md` doesn't document the gate idle-trigger behavior** (auto-run on idle+skill when `trigger: 'idle_and_skill'`, the cwd used, how to debug gate failures) (#66). | Add a gates-trigger section. Task 14. |
| AF-503 | low | docs | **Statusline/telemetry file format + `freshness_window_s` semantics undocumented** (`statusline/types.ts` has no field docs; default 300 not in runbook) (#162). | Document the telemetry contract. Task 14. |
| AF-504 | low | docs | **CLI `--help` descriptions never mention the daemon/auth prerequisite** (`cli/index.ts:47,56,62,…`) — `aisup start` reads "Start a supervised AI coding session" with no hint the daemon must be running first (#127). | Add prerequisite hints. Task 14. |
| AF-505 | low | docs | **Part B Truth 2 wording** still uncorrected in `2026-06-19` plan — **owned by Task 5**; listed for completeness. | Closed by Task 5. |
| AF-506 | low | tech-debt | **Dependency hygiene not assessed this pass** — no `npm audit` / unused-dep scan was run (repo has no eslint either). | Run `npm audit` + a depcheck-style scan; record results. Task 15. |

---

## Execution Order & Open-Question Resolutions (2026-06-23, operator-confirmed)

**Scope decision (operator):** all 15 tasks are in scope, sequenced by risk (below).

**Recommended execution order:**
- **Phase A — Unblock:** Task 1 (`AISUP_HOME` isolation) → Task 2 (codex args). Everything downstream depends on these.
- **Phase B — Stability & security (high):** Task 6 (daemon crash-resilience) → Task 11 (secret redaction / dir perms / injection) → Task 8 (runtime-validate external JSON). *(Task 12 moved to Phase E — its HI-00x blockers are already resolved in code per AF-R001…R007; it is now a low-priority confirm-coverage task, not open security work.)*
- **Phase C — Correctness (medium):** Task 7 (permission broker / keystroke / detector) → Task 9 (account / config / recovery bugs).
- **Phase D — Real validation (needs Phase A):** Task 3 (real codex test) → Task 4 (real multiprovider test) → Task 5 (live validation harness) → Task 13 (execute full-system validation suite).
- **Phase E — Cleanup & docs (low):** Task 12 (confirm-coverage of the already-resolved HI-00x blockers, add the worker-isolation E2E only if absent) → Task 10 (dead code / Map leaks) → Task 14 (docs/PRD sync) → Task 15 (dependency hygiene).

**Open questions — resolved:**
- **Q-A1 (test config approach):** MOOT — Task 1's `AISUP_HOME` writes an isolated throwaway config under the temp state dir; no separate `config.testing.yaml` needed.
- **Q-A2 (live spend / scratch repo):** APPROVED — Tasks 3/4/5/13 may spend real `claude -p` / `codex exec --json` quota against a `/private/tmp` throwaway scratch git repo with bounded tasks; the isolated `AISUP_HOME` never touches the operator's real `~/.aisup`.
- **Q-A3 (Slack `message.groups`):** ENABLED — inbound `!command` handling works; Tasks 5/13 will capture real Slack cross-provider failover-notification evidence against the live session channel.

## Implementation Tasks (continued — appended by the 2026-06-23 audit)

### Task 6: [NEW] Harden journal-write & daemon crash resilience

**Objective:** Make the supervisor daemon survive journal-write failures instead of crashing (AF-301), and stop silently losing audit events on disk-full. One consistent journal-failure policy; a global crash backstop; guarded fire-and-forget sites.

**Files:** `src/journal/writer.ts`, `src/daemon/index.ts` (add `process.on('unhandledRejection'/'uncaughtException')`; guard `runConfiguredGates`), `src/daemon/loop-manager.ts` (the `void d.journal.append` / `void d.onGateTrigger` sites), `src/recovery/exhausted.ts:51,65`, `src/daemon/server.ts:250-253`, `src/slack/service.ts` (`!gate` handler), `src/util/rotating-log.ts`; tests under `tests/journal/`, `tests/gates/`, `tests/daemon/`.

**Key Decisions / Notes:** Recommend `appendEvent` **never throws** — return a typed `{ok:false,reason}` and emit a one-shot `journal.write_failed` health signal (replacing both the ENOSPC silent-swallow and the non-ENOSPC throw). Add a global `unhandledRejection` handler that logs to the rotating daemon log + attempts a best-effort journal line, but does **not** `process.exit`. Add `.catch()` to each fire-and-forget call as defense-in-depth. Guard the gate HTTP/Slack entry points so a journal failure returns an error, not a crash. Wrap `RotatingLog.write` so a write error can't kill the stdout/stderr override.

**Definition of Done:** A unit test proves a rejecting `journal.append` from the idle-gate path and from a `void` site does **not** terminate the process; ENOSPC no longer silently returns success (it surfaces a health signal); `npx vitest run tests/journal tests/gates tests/daemon -q` green; manual: send the daemon a journal path on a read-only dir and confirm it logs + stays up.

**✅ Done (2026-06-23):** `appendEvent` never throws — returns typed `JournalAppendResult{ok,reason}`, secret-bearing events still NOT written (security preserved), ENOSPC/write/secret failures surface a `[aisup] journal.write_failed …` stderr health line (→ rotating daemon log) instead of silent-swallow or throw (`journal/writer.ts`, `journal/types.ts` adds `JournalAppendResult`). `createJournalWriter().append` resolves-never-rejects, so all ~15 `void journal.append(...)` sites are crash-safe by contract (no per-site `.catch()` litter needed). Global `process.on('unhandledRejection'|'uncaughtException')` handlers log + best-effort journal `daemon.uncaught_error` and do **not** `process.exit` (`daemon/index.ts`). `runConfiguredGates` wrapped in try/catch returning `{passed:false}` — single guard covering the HTTP/Slack/idle gate entry points. `RotatingLog.write` wrapped to return `false` (never throw) so the stdout/stderr override can't crash. Tests: `writer.test.ts` (16, secret tests now assert `{ok:false}`+not-written), `rotating-log.test.ts` (+1 no-throw). `npx vitest run tests/journal tests/gates tests/daemon` green; full suite 684/0/7. The `-q` flag is rejected by vitest 3.2.4 (ran without). **Manual read-only-dir live-daemon check deferred to verify phase** (standing up a real daemon overlaps Task 5's harness); the unit no-throw proofs cover the guarantee.

### Task 7: [NEW] Fix permission-broker concurrency, keystroke validation & detector verb gap

**Objective:** Resolve AF-302 (concurrent prompts overwrite), AF-306 (multi-char keystroke), AF-310 (timeout default), AF-311 (idleEmitted), and AF-103 (`create` verb).

**Files:** `src/daemon/index.ts` (hookPermissions structure), `src/permissions/detector.ts`, `src/config/loader.ts` (`validateKeyInput`), `src/hooks/claude-hooks.ts`, `src/daemon/loop-manager.ts` (idleEmitted), tests in `tests/permissions/`, `tests/hooks/`, `tests/config/`, `tests/daemon/`.

**Key Decisions / Notes:** Key pending permissions by `${sessionId}:${tool}:${detail}` (or a FIFO queue) and resolve earliest-pending on `!permit`/`!deny`. Restrict keystroke config to one ASCII printable. Make the hook timeout default 30 (match the daemon). Reset `idleEmitted` when `active_skill` is cleared. Add `create` to the permission patterns and audit the real Claude verb set against the live prompts captured in `TELEMETRY_FIELDS.md`.

**Definition of Done:** A test issues two concurrent `permission.ask` for one session and proves both resolve independently; multi-char/multi-byte keys are rejected at load; a post-skill-completion idle re-fires `onIdle`; the `create` prompt fires `permission.detected`. Suite green.

**✅ Done (2026-06-23):** AF-302 — extracted `src/permissions/pending-queue.ts` `PendingPermissionQueue` (per-session FIFO enqueue/dequeue/clear); daemon now queues concurrent asks and resolves earliest-first instead of the old `Map<sessionId,PermissionRequest>` that overwrote. AF-306 — `validateKeyInput` now requires a single printable ASCII char (`/^[\x20-\x7e]$/`); multi-char ("yes") / multi-byte (emoji) rejected at load. AF-310 — `claude-hooks.ts` permission-hook default timeout 600→30 (matches daemon). AF-311 — `loop-manager.idleTick` resets `idleEmitted` when a skill completes (active_skill cleared) so the next idle re-fires `onIdle`. AF-103 — detector verb set gained `create` (plus `delete`/`overwrite`), audited against the live `2026-06-17` "Do you want to create …?" prompt. Tests: `pending-queue.test.ts` (concurrent FIFO + isolation + clear), `loader.test.ts` (multi-char/emoji key rejection), `claude-hooks.test.ts` (default 30), `loop-manager.test.ts` (post-skill idle re-fire), `detector.test.ts` (create verb). Full suite 706/0/7. Build green. (Note: cursor-fragmentation of the modal render remains a deeper detection-robustness item under the validation plan, separate from this verb fix.)

### Task 8: [NEW] Runtime-validate external JSON inputs

**Objective:** Replace `as T` type-assertions on externally-written JSON with runtime validation so corrupt telemetry/state can't crash or silently drop a session (AF-303, AF-312, AF-313).

**Files:** `src/statusline/store.ts`, `src/daemon/rehydration.ts`, `src/session/manager.ts`; tests in `tests/statusline/`, `tests/daemon/`, `tests/session/`.

**Key Decisions / Notes:** Add a small validator (typeof checks or a shared schema helper) for the telemetry and `SessionState` shapes; on mismatch emit `telemetry.invalid_json` / a state-corruption event and skip safely rather than throw or silently null. Cover the "valid JSON, wrong field type" case explicitly (currently the gap).

**Definition of Done:** Tests write `{transcript_path: 123}` and a wrong-shape `state.json` and assert no crash + a corruption event emitted; suite green.

**✅ Done (2026-06-23):** AF-303 — `statusline/store.ts` `parseTelemetryFile` now JSON-parses then runs `isValidTelemetryShape` (non-object root or wrong-typed `session_id`/`transcript_path`/`cwd`/`workspace.project_dir` → `invalid_json`), so `transcript_path:123` is surfaced not crashed at `.startsWith`. AF-312/AF-313 — new shared `src/session/validate.ts` `isValidSessionState`; `rehydration.ts:readSessionState` returns `{state,corrupt,error}` and the loop emits new `session.state_corrupt` (instead of silent `null` skip); `SessionManager` gains an optional `journal` (wired in `daemon/index.ts`) and `readState` validates + emits `session.state_corrupt` best-effort while still returning `null` (signature unchanged → 10 callers untouched). Tests: `store.test.ts` (wrong-typed + non-object → invalid_json, no throw), `rehydration.test.ts` (unparseable + wrong-shape → `session.state_corrupt`), `manager.test.ts` (readState corrupt/wrong-shape → null + event, non-tmux-gated). Full suite 697/0/7. Build green.

### Task 9: [NEW] Fix account / config / recovery correctness bugs

**Objective:** Close AF-314…AF-321 — stale `cooldownUntil`, missing `soft_pct<hard_pct` check, unvalidated resume target, `buildEnv`/`config_dir_env` validation, `validateRunner` error clarity, `freshness_window_s`/`used_pct` bounds.

**Files:** `src/accounts/registry.ts`, `src/config/loader.ts`, `src/config/schema.ts`, `src/recovery/exhausted.ts`, `src/runner/builder.ts`, `src/runner/types.ts`, `src/accounts/scorer.ts`; mirror tests.

**Key Decisions / Notes:** Each is a small, independent guard. Add the UNAVAILABLE→DEGRADED transition test (#123) that would have caught the cooldown bug. Validate `config_dir_env` against the POSIX identifier regex; reject empty/control-byte `accountConfigDir`.

**Definition of Done:** A unit test per fix (cooldown cleared on recovery; inverted thresholds rejected; invalid resume target rejected; bad env name/value rejected; negative freshness rejected; out-of-range `used_pct` clamped). Suite green.

**✅ Done (2026-06-23):** AF-314 `registry.applyTelemetry` nulls `cooldownUntil` on transition to DEGRADED/HEALTHY. AF-315 `loader` rejects `soft_pct >= hard_pct`. AF-316 `resumeExhaustedSession` validates target is a known+enabled account up front (emits `failover.target_invalid`, no `performSwitch`). AF-317/318 `buildEnv` validates `config_dir_env` is a POSIX env-var name and `accountConfigDir` is non-empty/control-byte-free. AF-319 `validateRunner` distinguishes not-on-PATH from found-but-not-executable. AF-320 `loader` rejects negative `statusline.freshness_window_s`. AF-321 `computeScore` clamps used-percentages to [0,100]. Tests added per fix: `refresh.test.ts` (cooldown clear), `loader.test.ts` (inverted thresholds, negative freshness), `exhausted.test.ts` (unknown+disabled target), `builder.test.ts` (bad env name, empty/control accountConfigDir, not-executable), `scorer.test.ts` (computeScore clamp). Full suite 716/0/7. Build green.

### Task 10: [NEW] Remove dead code, fix Map leaks & semantic tech-debt

**Objective:** AF-304 (Map leaks), AF-307 (orchestrator in provider report — decide), AF-308 (unused param), AF-309 (test placement), AF-322 (dead `SkillTracker`/unused template), AF-323 (stale detector tests), AF-324 (failover guard), AF-207 (`default_implementer` semantics).

**Files:** `src/daemon/loop-manager.ts`, `src/providers/report.ts`, `src/session/manager.ts`, `src/skills/*`, `src/config/defaults.ts`, tests as needed.

**Key Decisions / Notes:** Extend `clearRecoveryCounters` to clear all per-session Maps. For AF-307/AF-322, first confirm intent (orchestrator-not-a-worker-role; `SkillTracker` truly unused) before removing — these are "investigate then act." Clarify or rename `default_implementer` to reflect account-first.

**Definition of Done:** Maps cleared on session stop (test); dead code removed or wired with justification recorded; `grep` confirms no remaining references to removed symbols; suite green.

**✅ Done (2026-06-23):** AF-304 — `clearRecoveryCounters` now clears all per-session collections (`restartAttempts`, `networkErrors`, `lastNoTargetNotice`, `lastGateRun`, `costState`, `idleEmitted`); behavioral test in `loop-manager.test.ts` (post-clear `onIdle` re-fires). AF-308 — removed the unused `CreateSessionOpts.accountConfigDir` field + all 4 call sites (`manager.ts`, `daemon/index.ts`, `server.ts` ×2; it was redundant with `opts.env`'s `CLAUDE_CONFIG_DIR`). AF-322 — removed dead `SkillTracker` (`skills/tracker.ts` + `tracker.test.ts`; never instantiated in production) and the dead `ContinuationOpts.template` path (no caller set it). AF-309/AF-323 — moved `resolveSkillFromCommandName` tests to `tests/skills/detector.test.ts` (its real module, the live hook path) and marked `detectSkill` as the pane-output FALLBACK in code + test describe. AF-307 — documented (comment) that `roles.orchestrator` is reserved/latent and intentionally excluded from `buildProviderUsageReport` (AF-R009). AF-207 — documented that `workers.routing.*` is back-compat only and the account-first selector always orders Claude ahead of codex. AF-324 — documented `failoverInProgress` single-boolean guard adequacy (single-threaded event loop, atomic check-then-set). `grep` confirms no orphan refs to removed symbols. Full suite 710/0/11. Build green.

### Task 11: [NEW] Tighten secret redaction, worker-dir perms & injection paths

**Objective:** AF-305 (mkdir mode), AF-325 (vendor-prefix secret values), AF-326 (continuation injection), AF-327 (hook input validation / invite errors / fail-loud sessions).

**Files:** `src/workers/worktree.ts`, `src/workers/review.ts`, `src/session/tmux.ts`, `src/journal/writer.ts`, `src/skills/continuation.ts`, `src/daemon/server.ts`, `src/slack/service.ts`; mirror tests.

**Key Decisions / Notes:** Add `mode:0o700` to the 4 mkdir sites. Extend the journal secret scan to value patterns (`sk_`, `ghp_`/`gho_`/`ghs_`/`ghr_`, `pk_`, `rk_`) — scan strings, not just key names. Escape/validate `{skill}`/`{plan_path}` substitutions. Bound/validate the hook `tool_input` payload; log `conversations.invite` failures; fail loudly (not 201) when session deps are unwired.

**Definition of Done:** Tests: a `ghp_`-valued field is rejected by the journal; a newline-bearing skill name can't inject into the continuation prompt; the 4 dirs are created `0o700`. Suite green.

**✅ Done (2026-06-23):** AF-305 — `mode:0o700` added to the 4 mkdir sites (`worktree.ts:93` `.git/info`, `review.ts:150` reviewer `.home`, `tmux.ts:65,145` output-log dirs); note `worktree.ts:93`'s `.git/info` usually pre-exists from `git worktree add` so its mode-add is a consistency no-op. AF-325 — journal scan extended to secret VALUES via `SECRET_VALUE_PATTERNS` (GitHub `gh[oprsu]_…`, Stripe `sk_/rk_/pk_…`, OpenAI `sk-…`) with start/non-token-char anchoring + long-body guards to avoid false positives (`workspace-write`, `task_id`, `sk_1` pass); `findForbiddenSecret` now scans strings at any depth (`journal/writer.ts`). AF-326 — `buildContinuationPrompt` sanitizes `{skill}`/`{plan_path}` (strips control chars/newlines, collapses whitespace) in both template + default paths (`skills/continuation.ts`). AF-327 — hook payload validated (non-string `tool_name`/`session_id` → 400, `tool_input` > 100 KB → 413, unserializable → 400; `server.ts`), `POST /api/sessions` fail-loud 503 (was phantom 201) when deps unwired, `conversations.invite` failures journaled as new `slack.invite_failed` (skipping benign `already_in_channel`/`cant_invite_self`). Tests: `writer.test.ts` (ghp_/sk_ value rejected + no-false-positive), `continuation.test.ts` (injection stripped), `review.test.ts` (reviewer `.home` 0o700), `server.test.ts` (503 + hook 400/413). Full suite 691/0/7. Build green.

### Task 12: [NEW] Verify/close Phase 3 plan-review isolation & security blockers

**Objective:** ⛔ DOWN-SCOPED by the Audit Refresh (AF-R001…R007) and review 2026-06-23 (LO-001): all six Phase 3 plan-review blockers HI-001…HI-006 (AF-201…AF-206) are **already resolved in code with regression tests** (re-verified: `validation.ts:74` `cwd:null`, `:26` isolated `HOME`, fail-closed `:65`; orchestrator sanitize-before-persist, MERGING reconcile, apply-conflict approval reset). This is therefore a LOW-priority **confirm-coverage** task, NOT six open security holes: verify each HI-00x has a dedicated regression assertion (gate `cwd`/`HOME` escape, artifact-before-sanitize, MERGING rehydration, ignored-file content audit, apply-conflict approval reset, plus LO-101/IN-101) and add the one host-gated worker-isolation E2E its DoD names ONLY IF absent. Do not treat the blockers as open.

**Files:** `src/workers/orchestrator.ts`, `src/workers/review.ts`, `src/workers/merge.ts`, `src/gates/engine.ts` (worker gate contract), `src/workers/worktree.ts`; mirror tests + a host-gated isolation test.

**Key Decisions / Notes:** Read each cited plan-review section and the current worker code; for each, record "resolved (evidence)" or "open → fix." This directly satisfies the prompt's "confirm each documented deviation was implemented and resolved optimally." Highest-value because these are isolation/security guarantees the product advertises.

**Definition of Done:** A short audit note per HI-00x (resolved/fixed, with file:line); for any fixed item, a regression test (e.g. a gate with `cwd` set cannot run outside the worktree; a `$HOME`-reading gate sees the isolated HOME; a rejected patch leaves no raw artifact). Suite green.

**✅ Done (2026-06-23) — confirm-coverage audit (all six RESOLVED with dedicated regression assertions; no fixes needed, no new E2E needed):**

| HI | Status | Code (file:line) | Regression test |
|----|--------|------------------|-----------------|
| HI-001 (gate `cwd` escape) | resolved | `workers/validation.ts:74` maps every worker gate to `{...g, cwd:null}` + `:76` `defaultCwd:worktree` | `tests/workers/validation.test.ts:115` "normalizes a gate-set cwd to the worktree (HI-001)" — asserts `defaultCwd=worktree` wins |
| HI-005 (gate inherits daemon `$HOME`/env) | resolved | `workers/validation.ts:20-26` `makeWorkerGateRunner` builds env from allowlist only + sets `env.HOME=workerHome` (no `...process.env`) | `validation.test.ts` `workerHome` asserted (13 sites) |
| HI-002 (raw artifact before sanitize) | resolved | `workers/orchestrator.ts:253-259` `sanitizePatch` before any write; violation persists only `redactedOutput(...)` | `tests/integration/workers.smoke.test.ts:211` "HI-002: secret-bearing patch ⇒ security_denied, no raw persisted" |
| HI-003 (`MERGING` rehydrated as FAILED) | resolved | `workers/orchestrator.ts` `reconcileMerging`→`worker.rehydrated_merged` | `tests/daemon/rehydration.test.ts` `rehydrated_merged` (2 sites) |
| HI-004 (ignored-file content audit) | resolved | `workers/worktree.ts:169-181` `snapshotMainTree` hashes forbidden globs; `auditBoundary` fails on hash change | `tests/workers/worktree.test.ts:111` + `smoke.test.ts:183` (AC4b) content-hash on a pre-existing `.env` |
| HI-006 (apply-conflict leaves approval) | resolved | `workers/merge.ts:53/65/78` `resetApproval:true` on mismatch/conflict; `orchestrator.ts` applies it | `tests/workers/merge.test.ts` `resetApproval` (2+ sites) |

Worker-isolation host-gated E2E is **present** (not absent) — `workers.smoke.test.ts` AC4a/4b/4c + HI-002 + HI-008 run against a real temp git repo (`@requires_git`, not skipped). No new E2E added. Full suite 716/0/11. **No code change (verification task).**

### Task 13: [NEW] Execute the deferred Full-System Validation suite

**Objective:** Run the `2026-06-17` Part A validation (Features A–K + S1–S4) and the Phase 1 Task 13 live acceptance gates (AF-101, AF-102) against the isolated `AISUP_HOME` daemon built by Tasks 1 + 5, capturing real evidence.

**Files:** `docs/plans/2026-06-17-aisup-full-system-validation.md` (record results), reuse `scripts/validation/` harness from Task 5, `docs/runbook.md` (any drift found).

**Key Decisions / Notes:** Hard-depends on Task 1 (isolation) and overlaps Task 5 for the worker legs — do the lead-session/Slack/recovery/cost legs here. Open questions Q-A1/Q-A2/Q-A3 are **resolved** (see "Execution Order & Open-Question Resolutions" above): Q-A1 moot (isolated `AISUP_HOME` config), Q-A2 approved (real spend on a `/private/tmp` throwaway scratch repo), Q-A3 confirmed (Slack `message.groups` enabled — capture real Slack evidence). This is the single biggest "is it actually done" gap for the lead-session half of the product.

**Definition of Done:** Each Part A feature row + S1–S4 marked PASS/GAP with captured evidence; any new GAP promoted to a finding/task; runbook updated for any drift.

### Task 14: [NEW] Documentation & PRD sync

**Objective:** AF-501…AF-504 (+ AF-104) — PRD G/H₂ rows → Implemented; document gate idle-trigger, telemetry/freshness format, CLI daemon prerequisite, and the `resume_prompt_mode` trade-off.

**Files:** `docs/prd/2026-04-29-ai-supervisor.md`, `docs/runbook.md`, `README.md`, `src/cli/index.ts` (help text).

**Key Decisions / Notes:** Pure docs/help-text; no behavior change. Part B Truth 2 wording (AF-505) is handled by Task 5 — don't duplicate.

**Definition of Done:** Each doc reflects shipped reality; `aisup --help` mentions the daemon prerequisite; counts/lists accurate.

**✅ Done (2026-06-23):** AF-501 — already correct in the PRD (Feature Inventory rows G + H₂ both read "Implemented (Phase 3)"; no "in progress" status remained); README intro updated from the stale "in progress for Phase 2" to "Phases 1–3 implemented (incl. Part B worker failover); Phase 4 dashboard remaining." AF-502 — runbook "Configuration Notes → Gate triggering" documents `idle_and_skill` (idle_delay + skill-completion debounce), the cwd contract (lead-session cwd vs worker worktree `cwd:null`), and `aisup gate` / `aisup log --type gate.*` for debugging. AF-503 — runbook "Statusline telemetry contract" documents the `statusline-<uuid>.json` fields, `resets_at` epoch-seconds, and the `freshness_window_s` staleness rule (default 300, negative rejected). AF-104 — runbook documents the `resume_prompt_mode: never` default trade-off (skill carry-across-failover is opt-in). AF-504 — `aisup --help` program description + `aisup start` description now state the daemon prerequisite. AF-505 (Part B Truth 2 wording) is owned by Task 5, not duplicated here. typecheck + build green; no test asserts the changed strings.

### Task 15: [NEW] Dependency-hygiene pass

**Objective:** AF-506 — assess dependency health (the audit didn't, and there's no eslint to lean on).

**Files:** `package.json` (only if a dep is added/removed with justification), a recorded report.

**Key Decisions / Notes:** Run `npm audit` and a depcheck-style unused-dependency scan; record findings. Only change deps with explicit justification (don't bundle upgrades into this audit).

**Definition of Done:** `npm audit` output captured; unused/risky/drifted deps listed with a recommendation; no behavior change unless a vuln forces a bump (then noted).

**✅ Done (2026-06-23) — record-and-recommend pass; NO dep changes made (per "don't bundle upgrades"):**

`npm audit`: **7 advisories — 1 low, 2 moderate, 3 high, 1 critical.**

| Package | Sev | Tree | Path / trust model | Recommendation |
|---------|-----|------|--------------------|----------------|
| `vitest` <3.2.6 | critical | **dev-only** | "arbitrary file read/exec **when the Vitest UI server is listening**" — we run `vitest run` (no UI), so the vector is not active | bump `vitest` ≥3.2.6 (patch within 3.x) at convenience; not triggered today |
| `ws` 8.0.0–8.20.1 | high | **prod** (via `@slack/bolt` socket-mode) + dev (via vite) | ws connects only to Slack's trusted endpoint | `npm audit fix` (transitive) |
| `form-data` 4.0.0–4.0.5 | high | **prod** (transitive under `@slack/*`) | CRLF injection in multipart field names — aisup doesn't build attacker-controlled multipart | `npm audit fix` (transitive) |
| `js-yaml` ≤4.1.1 | moderate | **prod** (DIRECT dep) | quadratic-DoS via YAML merge keys — aisup parses only the **operator's own** `config.yaml`, not untrusted YAML | bump `js-yaml` >4.1.1 at convenience (low real risk) |
| `qs` 6.11.1–6.15.1 | moderate | **prod** (transitive) | `qs.stringify` DoS edge case | `npm audit fix` (transitive) |
| (vite + 1 low) | low/mod | **dev-only** | test toolchain | resolved by the vitest bump |

**Unused / drifted dependency:** `@slack/web-api` is a **direct** dependency but is **not imported anywhere in `src/`** (verified by grep) — it is already provided transitively by `@slack/bolt` (whose `app.client` is the `WebClient`). **Recommendation:** remove `@slack/web-api` from `package.json` `dependencies` (safe — still resolved via bolt). Left in place this pass to avoid an unrequested dep change while the operator is away.

All 7 production `dependencies` except `@slack/web-api` are confirmed imported in `src/`. No `dep` was added, removed, or bumped — none of the advisories *forces* a bump (every prod-tree advisory is a DoS/disclosure with a trusted-input or no-active-vector trust model). Suggested follow-up (operator's call): `npm audit fix` for the transitive set + bump `vitest`/`js-yaml`, and drop `@slack/web-api`.

---

## Deferred Ideas (Check 4 — product / UX feature discovery)

These are **enhancements**, kept separate from the defect findings. Each is grounded in current-state evidence (`file:line`) and the pain it removes. Priority = how often a real daily operator hits it (`constant` / `occasional` / `rare`); effort S/M/L.

### Current-capability map (what exists today)

- **CLI (`src/cli/index.ts`):** `daemon start|stop`, `start [--cwd --plan --dry-run]`, `stop [--force]`, `attach`, `status [--json]`, `log [--limit --type]`, `cost [--json --since --account]`, `gate [run]`, `accounts`, `doctor`, `init [--dry-run --force]`, `failover --to`, `worker dispatch|list|providers|status|review|logs|approve|deny|cancel`.
- **Slack (`src/slack/service.ts`):** `!interrupt`, `!stop`/`!confirm`, `!status` (last 50 pane lines), `!cmd`, `!relay on|off`, `!permit`/`!deny`, `!gate [status]`, `!worker status|approve|deny`, `!help`. **Read/observe gap:** no `!accounts`, `!cost`, `!worker providers`, `!worker dispatch`, `!failover`, `!session`, `!health` — those exist only as CLI/HTTP.
- **Config (`src/config/{schema,defaults}.ts`):** runner, thresholds (soft/hard/idle), failover circuit-breaker, skills, monitoring intervals, session/log rotation, recovery, permissions, gates, slack, daemon port/log, statusline, journal, workers (security/adapters/routing/review/merge), roles (implementer/reviewer/orchestrator).
- **Journal (`src/journal/types.ts`):** ~117 event types across session/account/runner/failover/recovery/permission/gate/cost/worker/telemetry. **Observability gap:** `aisup log` prints only `(ts, type, account)` — the rich `details` payload is dropped.
- **Notifications:** Slack posts on session start/stop, EXHAUSTED, cross-provider worker failover, permission request. No proactive threshold/budget warnings; no worker state-transition pushes.

### Top feature ideas (highest value first)

| ID | Pri/Eff | Idea | Pain today (evidence) |
|----|---------|------|------------------------|
| UX-01 | constant/M | **`aisup watch` / `aisup health` unified live view** (daemon health, active session, per-account headroom grid, worker queue, recent events, cost-today) | Operator stitches 4+ commands (`status`+`accounts`+`cost`+`log`) for one snapshot; each round-trip is friction at 2am (`cli/commands/{status,accounts,cost,log}.ts` are separate; no unified endpoint). |
| UX-02 | constant/S-M | **Slack observability parity** — `!status` (session metadata), `!accounts`, `!cost`, `!worker providers`, `!health` | Slack is the remote plane but can't answer "which account, how much headroom, will a worker run?"; HTTP endpoints exist (`server.ts` GET `/api/{status,accounts,cost,workers/providers}`) but no Slack command calls them (`slack/service.ts`). |
| UX-03 | constant/M | **Failover "why" explainability** — reason codes + eligible-account scores + chosen-target rationale in `failover` events, `aisup log`, and Slack | A switch fires with no real-time explanation; the scorer's reasoning isn't surfaced (`failover/switcher.ts` selection has no reason-codes returned; `log.ts` shows only event type). |
| UX-04 | constant/M | **Worker failure transparency** — `tried_candidates[]` + per-candidate failure reason in `aisup worker status` and the API | On exhaustion the operator sees only `all_candidates_exhausted`; must grep the journal to learn which candidates failed and why (`cli/commands/worker.ts:70-84`; `worker.candidate_failed` exists in journal but isn't surfaced). |
| UX-05 | constant/M | **Proactive threshold/budget alerts** (`thresholds.warning_pct`) — Slack + journal warning when an account nears soft/hard or codex budget runs low | Zero alerts until the operator runs `accounts`/`cost`; `rate_limit.threshold_crossed` event type exists but nothing fires it proactively (`daemon/index.ts` refresh; `slack/service.ts`). |
| UX-06 | constant/M | **Worker diff preview + approve/deny from Slack** | `!worker approve` is blind (title + status only); `WorkerOutput.patch` exists but isn't exposed to Slack (`slack/service.ts:256-258`, `workers/types.ts`). |
| UX-07 | constant/S | **`aisup log --details` / `--account/--session/--since` filters + `aisup explain <event>`** | `log.ts:11-20` drops the `details` payload and offers no filtering; `reader.ts` supports `since` but the CLI doesn't expose it. |
| UX-08 | constant/S | **Onboarding guardrails** — post-`init` checklist, `doctor` checks for `settings.json`/statusline + ≥2 accounts + Slack tokens, daemon **port-conflict preflight**, and a `~/.aisup/daemon.log` pointer | `init` creates placeholder `~/.claude*` dirs silently (`config/loader.ts:487-488`); `doctor` checks dir existence but not contents (`doctor.ts:54-76`); `daemon start` spawns detached `stdio:'ignore'` so a port-in-use failure is invisible (`cli/commands/daemon.ts:46-50`). |
| UX-09 | occasional/M | **Worker dispatch + retry from Slack; `aisup worker retry <id>`** | A FAILED worker is a dead end; re-running means re-typing the prompt (`cli/commands/worker.ts:134-145`; no retry state in `workers/types.ts`). |
| UX-10 | occasional/S-M | **Runtime account control** — `aisup accounts --pin/--exclude/--enable/--disable` (and Slack `!account …`) | Excluding/disabling an account needs a config edit + daemon restart (`accounts/registry.ts` has state but no runtime override CLI). |
| UX-11 | occasional/M | **Cost breakdown by skill / task-type / worker + per-provider (Claude vs codex)** | `cost` shows only rolling windows by account; worker token usage is recorded but not linked back to cost (`cost/aggregator.ts`, `workers/codex-json.ts`). |
| UX-12 | occasional/S | **Notification verbosity control** (`!notify silent|normal|verbose`, per-channel) | All notifications are always-on; no mute/detail control (`slack/service.ts` posts unconditionally). |
| UX-13 | occasional/S | **`aisup pause` / `aisup resume`** (SIGSTOP/SIGCONT the runner) | No way to throttle a session to save headroom without a full stop (`cli/commands/stop.ts`; no PAUSED state). |
| UX-14 | rare/M | **Worker `undo`/revoke of an approved merge; `worker cleanup --list/--force`** | An approved merge is permanent; orphaned worktrees are invisible (`workers/merge.ts`; retention cleanup is silent). |
| UX-15 | rare/S-M | **Session naming/labels, `aisup session timeline`, causality view in `log`** | Sessions are UUID-only; transitions and cross-event causality require manual journal correlation (`session/types.ts` has no name/label; `reader.ts` is a flat list). |

*(Full set: 98 candidate ideas were harvested across onboarding, daily-supervision, worker-loop, Slack, observability, and cost workflows; the table above is the de-duplicated high-value head. The remainder — export/audit-log, daemon metrics endpoint, scheduled/recurring workers, per-task config overrides, read-only `attach`/HTTP dashboard, fsync durability — are lower priority and recorded in the audit working notes.)*

---

## Audit Coverage Report (2026-06-23)

**Fully audited:** all 19 `src/` subsystems (accounts, cli, config, cost, daemon, failover, gates, hooks, journal, permissions, providers, recovery, runner, session, skills, slack, statusline, util, workers) and their mirror tests; the gated/skipped test tiers; PRD; all 8 phase plans; all 9 reviews; all 10 handoffs; git history for every phase commit (`b7379b4`→`2ab8440`). Live ground truth captured: typecheck exit 0, build success, **675 pass / 0 fail / 7 skip**.

**Phases reconciled:** Phase 1 (MUST-FIX #1–#7 all confirmed implemented), Phase 2 (recovery/cost/permissions/gates — compliant, VERIFIED), Phase 3 (worker pipeline functionally complete; **6 plan-review isolation/security blockers HI-001…006 NOT confirmed resolved → Task 12**), usage-ledger + hooks (wired), Part B (Truths reconciled; Truth 2 unreachable, already corrected by Task 5).

**False positives caught during verification (NOT findings):** the agent-reported "double `res.json()`" (`start.ts:118/123` are mutually-exclusive branches), "`inFlight` race" (`exhausted.ts:100-107` has no `await` between check and set — synchronous), and "RotatingLog data loss" (`rotate()` is correct rotation; discarding the oldest beyond `maxFiles` is intended). The "world-readable `.aisup`" claim was narrowed (root dirs *are* `0o700`; only 4 leaf mkdir sites omit the mode → AF-305).

**Not fully covered (gaps in this audit):** (1) **Dependency hygiene** not run → Task 15. (2) The **deferred Full-System Validation** (lead-session, Slack, recovery-matrix, cost) was read, not executed → Task 13 (and it needs operator input on Q-A1/Q-A2/Q-A3). (3) The Phase 3 **HI-001…006** items are reported from the plan-review with file:line but their resolution status was **not** re-verified in code this pass → Task 12 is verification-first. (4) ~30 low-severity `[agent-reported]` items carry a file:line but were not individually re-read; triage during implementation. (5) No browser/UI surface exists, so no E2E browser pass was applicable.

---

## Audit Refresh Findings (2026-06-23)

**Method (refresh).** Read-only delta pass layered on top of the prior `## Audit Findings (2026-06-23)`. Per operator decision this run is **serial / single-context** (no subagent fan-out) and **focused-delta**: Check 4 (product/UX) + Check 6 (orchestration-only mode) are the primary emphasis; Checks 1–3/5 were limited to genuinely-new material findings plus **re-verification in code of the prior HIGH findings**. Live ground truth re-captured this pass: `npm run typecheck` exit 0, `npm run build` success, `npx vitest run` **675 pass / 0 fail / 7 skip** (unchanged from the prior audit). The 7 skips re-confirmed as host-gated worker tiers (`claude-worker`, `worker-multiprovider`, `@requires_codex/gemini/local_llm`) + tmux-gated integration/session tests — owned by Tasks 3/4/13 + AF-105, no new unproven behavior. `git` HEAD = `2ab8440` with no commits since the prior audit, so the prior git-history pass is fully current (this refresh's git-history delta is **nil**).

**Dedup baseline (stated per the output contract):** prior findings **AF-101…AF-506** + **UX-01…UX-15**; **highest existing implementation task = Task 15**; the Out-of-Scope, Risks, and "Execution Order & Open-Question Resolutions" sections. Refresh findings use the new `AF-R0##` namespace; refresh product ideas continue the UX series as `R-UX-##`. No existing finding/task ID is reused, renumbered, or rewritten.

**Headline result.** The six Phase-3 plan-review blockers the prior audit could **not** confirm resolved (AF-201…AF-206 / HI-001…006, the basis for Task 12, flagged "verification-first") are **all resolved in the current code and substantially regression-tested** — re-verified this pass with `file:line` + test evidence (corrections AF-R001…AF-R006 below). This **down-scopes Task 12** from "fix six open isolation/security holes" to "confirm coverage / add any missing assertion." **No new closure-blocking defect was found.** The refresh's net contribution is: six high/medium **corrections** that reduce the plan's risk profile, one evidence correction to UX-05, one compliance note, the Check-6 product evaluation, and a small product-discovery delta. Consequently **zero new `[REFRESH]` implementation tasks are added** (justification under "New tasks" below).

### Check 2/3 — Corrections to prior HIGH findings (re-verified resolved in code)

These were prior `[agent-reported / verify]` findings carried from the Phase-3 plan-review without code re-verification. Each is now re-verified **resolved** — they are documented Phase-3 deviations (the HI-00x blockers) and each was resolved **optimally** (fail-closed, defense-in-depth), not symptom-patched.

| ID | Sev | Category | Corrects | Re-verification evidence | Resolution |
|----|-----|----------|----------|--------------------------|------------|
| AF-R001 | high | correction | AF-201 (HI-001 gate `cwd` escape) | `workers/validation.ts:74` maps every worker gate to `{ ...g, cwd: null }` and `:76` passes `defaultCwd: worktree` to `runGates`, so a worker gate **cannot** run outside the worktree regardless of its configured `cwd`. Also fail-closed: no required gate + `allowNoValidation:false` ⇒ validation fails (`:64-72`). Tested: `tests/workers/validation.test.ts`. | **Resolved (optimal).** AF-201 is NOT an open hole for the worker path. The generic `gates/engine.ts:65-66` `cwd ?? defaultCwd` precedence is correct for operator-owned **lead-session** gates and is not a worker-isolation boundary. |
| AF-R002 | high | correction | AF-202 (HI-005 gate inherits daemon `$HOME`/env) | `workers/validation.ts:20-26` `makeWorkerGateRunner` builds the gate env from the **allowlist only** then sets `env.HOME = workerHome` — there is no `...process.env` spread, so worker gates do not see the operator's real `$HOME` or ambient env. Tested: `workerHome` asserted in 13 test sites. | **Resolved (optimal).** Worker gates run with an isolated HOME + allowlisted env. |
| AF-R003 | high | correction | AF-203 (HI-002 raw artifact before sanitize) | `workers/orchestrator.ts:252-264` calls `sanitizePatch` **before** any artifact write; on violation it persists **only** redacted violation metadata via `redactedOutput(...)` (`:255-258`), never the raw patch/tails. The raw `patch.diff` is written (mode `0o600`) only **after** sanitize passes (`:269`). | **Resolved (optimal).** No forbidden content reaches disk on a rejected patch. |
| AF-R004 | high | correction | AF-204 (HI-003 `MERGING` rehydrated as `FAILED`) | `workers/orchestrator.ts:585-610`: `start()` reconciles a `MERGING` worker via `reconcileMerging` → `isApplied` (`worktree.ts:313`, reverse-applies cleanly) → emits `worker.rehydrated_merged` when the patch already applied; only genuinely-lost in-flight subprocesses become `FAILED` (`:595`). Tested: `tests/daemon/rehydration.test.ts`, `rehydrated_merged` (3 sites). | **Resolved (optimal).** An already-applied patch is not misreported as FAILED. |
| AF-R005 | medium | correction | AF-205 (HI-004 boundary audit misses content edits to ignored files) | `workers/worktree.ts:169-181` `snapshotMainTree` records `size:mtime:sha256` for every existing forbidden-glob file in addition to `git status --porcelain --ignored`; `auditBoundary:198-201` fails if any forbidden file's hash changed. A content edit to a pre-existing ignored `.env` is caught. Tested: `auditBoundary` (15 sites). | **Resolved (optimal).** Content changes to pre-existing ignored files are detected. |
| AF-R006 | medium | correction | AF-206 (HI-006 apply-conflict leaves `approval.granted=true`) | `workers/merge.ts:53/65/78` returns `resetApproval:true` on patch-hash-mismatch / apply-conflict; `orchestrator.ts:548-551` applies it — `{decided:false,granted:false,by:null,at:null}` — then re-persists `AWAITING_APPROVAL`. Double-apply is independently prevented by the atomic `AWAITING_APPROVAL→MERGING` claim (`orchestrator.ts:529-533`). IN-101 (atomic `git apply`) noted at `merge.ts:69`. Tested: `resetApproval` (6 sites), `tests/workers/merge.test.ts`. | **Resolved (optimal).** A retry after an apply failure requires fresh approval. |

**AF-R007** · **correction** · *Corrects: Task 12 scope, AF-201…AF-206.* Given AF-R001…AF-R006, Task 12's stated objective ("Determine whether HI-001…006 were resolved … and **fix any still open**") is **stale** — all six are resolved in code **and** carry regression tests (counts above). **Why it matters:** Task 12 was listed under "Phase B — Stability & security (high)" and read as six open security holes; it is in fact ~complete. *(Resolution APPLIED 2026-06-23 — see "Plan-Review Fixes Applied" LO-001: Task 12 re-scoped and moved to Execution-Order Phase E.)* **Proposed resolution:** re-scope Task 12 to a **low-priority "confirm coverage"** task — verify each HI-00x has a dedicated assertion (this pass found coverage for HI-002/003/004/005/006; HI-001's `cwd:null` is covered by `validation.test.ts`) and add the one host-gated worker-isolation E2E its DoD names **only if** absent. Do **not** treat the blockers as open. (This is a scope correction, not a new task.)

### Check 5 — Correction to a prior product finding

**AF-R008** · **low** · **correction** · *Corrects: UX-05 evidence.* UX-05 ("Proactive threshold/budget alerts") states *"`rate_limit.threshold_crossed` event type exists but nothing fires it proactively."* That evidence is **partly wrong**: the event **is** fired proactively to the journal on every soft/hard threshold breach — `daemon/index.ts:689-705` (`onThresholdBreach` → `journal.append({event_type:'rate_limit.threshold_crossed', details:{level, five_hour_pct, seven_day_pct, soft_pct, hard_pct, reset_eta}})`). **The real gap is delivery, not emission:** the breach is journaled but never pushed to Slack (the only `notify*` paths are session start/stop, exhausted, cross-provider worker failover, permission request — `slack/service.ts:181/199/213/225/238`), and there is no warning band (`ThresholdsConfig` has only `soft_pct`/`hard_pct`/`idle_boundary_seconds`, `schema.ts:16-20` — no `warning_pct`). **Why it matters:** UX-05 remains valid but should be re-scoped to *"wire the existing `rate_limit.threshold_crossed` journal event to a Slack push + add an optional `warning_pct` band,"* which is materially smaller than "fire the event." Still an enhancement → stays deferred.

### Check 2 — New compliance note

**AF-R009** · **low** · **compliance-gap** · *Duplicate check: overlaps AF-307 (provider report omits `orchestrator`); adds the root cause.* The `orchestrator` worker role is **config-only / latent**: declared in `RolesConfig` (`schema.ts:176`), parsed and defaulted to `single('claude')` (`loader.ts:328,343`), and validated (`defaults.ts:13`), but **never consumed by worker execution** — `orchestrator.ts` drives only `implementer` + `reviewer`. **Why it matters:** an operator configuring `roles.orchestrator` gets a field that silently does nothing (a Check-5 "field that does nothing" smell), and `aisup worker providers` cannot report it (AF-307). **Proposed resolution:** fold into Task 10's AF-307 decision — either (a) document `roles.orchestrator` as **reserved** (recommended near-term), or (b) wire it, which is the natural anchor for the Check-6 orchestration mode below. No new task; this refines AF-307.

### Re-verification of prior HIGHs that remain OPEN (carried forward — no change)

Re-checked this pass and **confirmed still open** (the prior audit + their owning tasks are correct; no correction needed):

- **AF-301** (high, daemon crash on journal-write failure) — **confirmed open.** `daemon/index.ts:814-815` registers only `SIGTERM`/`SIGINT`; there is **no** `process.on('unhandledRejection'|'uncaughtException')`. ~10 fire-and-forget sites (`loop-manager.ts:169,185,215,342,386,599,677,694`; `recovery/exhausted.ts:51,65`) call `void journal.append(...)` / `void d.onGateTrigger(...)`, and `writer.ts:28` throws synchronously on a secret-shaped key while `:42` re-throws all non-ENOSPC errors (ENOSPC silently swallowed `:38-40`). Owned by **Task 6** — correctly scoped and high-priority.
- **AF-325** (medium, secret *values* not redacted) — **confirmed open.** `journal/writer.ts:5` `SECRET_KEY_PATTERN` matches key **names** only; a `sk_…`/`ghp_…` value under an innocuous key passes. Owned by **Task 11**.
- **AF-302 / AF-303** (concurrent permission overwrite; type-asserted external JSON) — spot-checked, consistent with the prior evidence; owned by **Tasks 7 / 8**. Not re-derived in full (focused-delta scope).

### Check 4 — Feature discovery (refresh delta)

The prior `## Deferred Ideas` capability map + UX-01…UX-15 were spot-verified against the live surface (CLI `src/cli/index.ts`, Slack `src/slack/service.ts`, config `src/config/schema.ts`, journal `src/journal/types.ts`) and found **accurate**. The CLI surface (incl. `worker logs`) and the Slack observe-gap (no `!accounts`/`!cost`/`!worker providers`/`!health`) match the map. The new grounded ideas below extend that set (continuing the UX numbering); they are **enhancements**, kept out of the closure scope.

| ID | Pri/Eff | Mark | Idea | Pain today (evidence) | Dedup |
|----|---------|------|------|------------------------|-------|
| R-UX-01 | constant/M | next PRD | **Live worker progress** (`aisup worker logs <id> --follow`, streamed stdout, or `worker status` progress field) | `worker logs` is one-shot and shows `"(no output captured yet)"` until completion — `cli/commands/worker.ts:106`; `stdout_tail`/`stderr_tail` are populated only post-run. During a multi-minute worker the operator is blind. | Distinct from UX-04 (post-hoc `tried_candidates` transparency); this is **live** progress. |
| R-UX-02 | occasional/M | next PRD | **Hot config reload** (`aisup daemon reload` / `SIGHUP`) | No reload path exists (`grep -rE "SIGHUP|reload|fs.watch"` over `src/` is empty). Changing thresholds/accounts/Slack requires `daemon stop`+`start`, which tears down the **single** supervised session (`pid.ts:71`). | Broader than UX-10 (runtime *account* control); covers all config. |
| R-UX-03 | occasional/S | next PRD (bundle w/ UX-06) | **CLI `aisup worker diff <id>`** | `worker logs` exposes only `patch_path` (`worker.ts:103`); no command prints the diff for review — the operator must open the artifact file by hand. | CLI-side counterpart of UX-06 (Slack diff preview). |
| R-UX-04 | rare→future/L | future (own PRD) | **Multi-session supervision** | The daemon supervises exactly one session — `getActiveSession()` is singular and `cli/pid.ts:71` rejects a second ("…already active"). A developer across multiple repos can babysit only one. | **Deliberate Phase-1 architectural boundary (single-session predicate), not a defect.** Large change ⇒ its own PRD. |
| R-UX-05 | n/a | **REJECT (already out-of-scope)** | **launchd/systemd daemon auto-start** (survive reboot) | The supervisor doesn't survive a reboot; operator must re-run `aisup daemon start`. | **Explicitly OUT OF SCOPE** in the PRD (`prd:105,203`) and Phase-3 plan (`plan-3:768`, master:69) — "user-controlled lifecycle." Recorded as the required **do-not-build** item; revisit only if reboot-resilience becomes a product goal. |

**Top product/UX opportunities (refresh view, highest value first).** Re-ranking the combined set by how often a real daily operator hits the pain: **(1)** UX-01 unified `aisup watch`/`health`; **(2)** UX-02 Slack observability parity; **(3)** R-UX-01 live worker progress; **(4)** UX-03 failover "why" explainability; **(5)** UX-04 worker failure transparency; **(6)** UX-05 *(re-scoped per AF-R008)* proactive Slack threshold/budget alerts; **(7)** UX-06 + R-UX-03 worker diff review (Slack + CLI); **(8)** UX-08 onboarding/`doctor` guardrails + port preflight; **(9)** R-UX-02 hot config reload; **(10)** UX-07 `aisup log --details`/filters. **Reject:** R-UX-05 (launchd, out-of-scope). **Recommended next-PRD candidates:** a combined **"operator observability & control"** PRD (UX-01/02/03/04 + R-UX-01) and a separate **"worker review ergonomics"** PRD (UX-06 + R-UX-03). None is closure-blocking — the closure plan stays scoped to Part-B validation + the prior defect set.

### Check 6 — Orchestration-Only Workflow Mode Evaluation

> **⛔ OPERATOR DECISION (2026-06-23): DEFERRED — chosen direction is Option C (a first-class in-aisup workflow subsystem). This is OUT OF SCOPE for the current closure plan and will be built in a SEPARATE, FUTURE implementation phase (its own PRD + plan + spec). It adds NO task to this plan and does NOT change the closure DoD. Recorded here in detail so the agreed direction is not lost.**

*(Product/architecture evaluation — evaluated this pass; build deferred per the decision above.)*

**Current-state map — what aisup already provides toward this idea (substantial):**

- **Isolated-write workers** — the worker orchestrator already runs a bounded task in a real git **worktree**, cross-model **reviews** it, and gates a **human-approved merge** (`workers/orchestrator.ts`, `worktree.ts`, `review.ts`, `merge.ts`). This is ~70% of "dispatch isolated-write workers under isolation."
- **Model / provider routing** — ordered per-role candidate lists with per-candidate `model`/`effort`/`budget`, account-first then cross-LLM failover (`providers/selector.ts`, `config/schema.ts:165-177`).
- **Isolation & fail-closed gates** — worker gates run with `cwd:null→worktree` + isolated `HOME` + allowlisted env, fail-closed (`workers/validation.ts`, re-verified in AF-R001/R002).
- **Review + approval gates** — cross-model verdict + integrity-anchored, human-approved, double-apply-safe merge (AF-R003/R006).
- **Evidence contract** — ~110 journal event types incl. the full `worker.*` lifecycle (`journal/types.ts`), per-worker durable store, sanitized artifacts.
- **A reserved `orchestrator` role** already exists in the roles schema (latent — AF-R009) — a natural hook.

**Gap map — what a true orchestration-only mode still needs:**

- **Workflow / phase-graph definitions & persistence** — workers are single, flat, bounded tasks; there is no multi-phase task graph (decompose → phases → dependencies) and no DAG persistence (the worker store is per-worker).
- **A coordinator with enforced constraints** — aisup does **not** today constrain what the **lead** session edits (it supervises usage/failover + brokers permissions, but never scopes file edits). "Coordinator may not edit production files outside the declared workflow" is a genuinely new responsibility/enforcement surface.
- **Read-only worker mode** — workers are always write-isolated in a worktree; there is no "read-only investigator" worker variant.
- **Model-policy routing per phase** — routing is per-role, not per-phase/per-policy.
- **Subagent status protocol & live progress** — only post-hoc journal/status exists (see R-UX-01); no structured phase/worker progress stream.
- **Workflow-level UI/Slack controls** — only per-worker dispatch/approve/deny today.

**Feasibility.** Reasonable within the architecture: the hard, security-sensitive primitives (worktree isolation, cross-model review, human approval, provider routing, journal evidence) already exist and are tested. A workflow layer would sit **above** the worker orchestrator — a workflow = ordered phases, each phase = N workers (read-only or isolated-write) with evidence contracts and review gates between phases. Likely-changed/added surfaces: a new `src/workflows/` (graph + persistence), a read-only worker mode in `workers/`, a status/progress protocol, and `roles.orchestrator` wiring. **Biggest risks:** (a) the coordinator-constraint enforcement is a new trust boundary for the *lead* session, which aisup deliberately does not police today; (b) phase-graph persistence + cancellation/retry across phases is non-trivial state.

**Product fit.** **Partial, with a clean seam.** aisup's core is *supervising* LLM sessions and *executing* bounded worker tasks under isolation. The **execution** half of this idea (isolated read/write workers + review + approval) is squarely aisup's wheelhouse and reusable as-is. The **coordinator/decomposition/constraint** half is closer to a Pilot `/spec`-style workflow engine than to a supervisor daemon — making aisup *police the lead agent's edit scope* is a different product axis.

**User value / UX.** Real, and it maps to a concrete pain the prompt names: Claude/Pilot can spawn an unstructured flat batch of agents, pick the wrong model, or skip worktree isolation. aisup's worker orchestrator is exactly the structured, isolated, reviewed executor that pain is missing. The value is highest for the power user already dispatching workers; it does not change the daily single-session supervision loop.

**Options considered (recorded for the future phase):**

- **Option A — status quo / defer build:** manually chain `aisup worker dispatch`; the human is the conductor. No new code. Rejected as the *end state* (no decomposition, phases, or enforcement) but is effectively what holds until the future phase starts.
- **Option B — Pilot `/spec`-style wrapper:** a Pilot skill is the conductor and drives `aisup worker dispatch`; aisup is unchanged. Fast, no aisup code, good for de-risking the workflow shape — BUT the "coordinator can't edit files" rule is convention (a prompt), not enforced, and the workflow has no persistence (a dead context loses the plan). **Optional precursor only.**
- **Option C — first-class in-aisup workflow subsystem (CHOSEN):** aisup itself becomes the conductor — durable phase graph, read-only workers, live status, and *enforced* coordinator constraints via the permission broker. Largest build; turns aisup from "supervisor" into "supervisor + orchestrator." **This is the committed target; deferred to a future phase.** Option B may optionally precede it to de-risk, but the destination is C.
- **Option D — overload the existing single-task orchestrator:** rejected — stuffing multi-phase logic into `orchestrator.ts` (designed for one task) yields messy, harder-to-test code and still lacks C's enforcement. False economy.

**Recommendation: `plan next` (build Option C in a dedicated future phase).** Per the operator decision, the chosen direction is Option C, deferred out of the current closure scope into its own PRD + plan + spec. The detailed Option C design to carry into that phase is below.

---

#### Option C — detailed design (for the future implementation phase)

**Core model.** A **workflow** = an ordered set of **phases**; each phase = N **tasks**; each task is a worker dispatch tagged `read_only` or `write`. A **coordinator** (running as the `orchestrator` role, AF-R009) executes the next runnable phase, dispatches its tasks to the **existing** worker orchestrator, gates on review/approval between phases, feeds earlier phases' evidence into later phases' prompts, and synthesizes. The coordinator may NOT edit production files — enforced, not assumed.

**New / changed surfaces:**

- **`src/workflows/` (new subsystem):**
  - `types.ts` — `WorkflowDefinition`, `Phase`, `WorkflowTask`, `PhaseStatus`, `WorkflowStatus`.
  - `graph.ts` — the phase/task DAG: phases, tasks-per-phase, inter-phase dependencies, per-phase evidence/review requirements, per-task model policy + isolation mode.
  - `coordinator.ts` — resolves the next runnable phase, dispatches its tasks via the worker orchestrator, applies the between-phase gate, injects prior-phase evidence downstream, performs synthesis. Uses the `orchestrator`-role model.
  - `store.ts` — durable persistence of the workflow graph + per-phase/per-task state under `AISUP_HOME` (mirrors `workers/store.ts`).
- **`src/workers/` — add a read-only worker mode:** a worker variant that gets an isolated checkout but is forbidden to produce a merged patch; its output is a **structured evidence/report artifact**, not a diff. Adapter/runner gain `mode: 'write' | 'read_only'`; the sanitize→review→merge tail is skipped for read-only (only the report is captured + sanitized).
- **`src/permissions/` + broker — coordinator-constraint enforcement:** when a session runs in workflow mode, set its permission policy to **deny Edit/Write/mutating-Bash outside the declared workflow output paths** (reuse `PermissionPolicyConfig` allowlist/denylist + `default_action: 'deny'`). The broker already intercepts tool prompts; extend it to enforce a per-workflow scope. This is the one genuinely new trust boundary — the daemon now polices the lead/coordinator's edits, which it deliberately does not do today.
- **`config/schema.ts`:** wire the latent `roles.orchestrator` (AF-R009) as the conductor model; add a `workflows` block (enable flag, `max_concurrent_phases`, per-phase default model policy, evidence/review requirements, default isolation mode).
- **`journal/types.ts`:** new `workflow.*` event family (`workflow.started`, `.phase_started`, `.phase_passed`, `.phase_failed`, `.task_dispatched`, `.awaiting_phase_approval`, `.synthesized`, `.completed`, `.cancelled`) — the evidence contract + the source for live status.
- **CLI:** `aisup workflow run <plan>` / `workflow status <id>` / `workflow approve <id> <phase>` / `workflow cancel <id>` / `workflow logs <id>`.
- **Slack:** `!workflow status`, phase approve/deny **with diff preview**, live phase progress (composes with R-UX-01 live progress + UX-02 Slack parity).
- **HTTP:** `/api/workflows` CRUD + status, mirroring `/api/workers`.

**Crash recovery.** The workflow graph + phase/task state persist under `AISUP_HOME`; on daemon restart, reconcile in-flight phases by reusing the worker **HI-003 rehydration pattern** (completed tasks stay completed; lost in-flight tasks re-queue). A workflow survives a daemon restart the way workers already do.

**Reuse vs. build.** Reused **unchanged**: worktree isolation, sanitize, validation gates, cross-model review, merge integrity, account/cross-LLM failover, the per-entity store pattern, the rehydration pattern, the permission broker. **New code** = the conductor layer only: phase graph + persistence, read-only worker mode, scope enforcement, the `workflow.*` status protocol, and the CLI/Slack/HTTP workflow surface.

**Open questions to resolve in the future-phase PRD:**

1. Phase-graph source — declarative YAML plan, LLM-decomposed-at-runtime, or both.
2. Read-only worker output contract (report schema) and how it is injected into downstream phase prompts.
3. Enforcement granularity — deny all coordinator writes vs. allow writes only within declared output paths.
4. Concurrency model — `max_concurrent_phases` vs. task-level `workers.max_concurrent`, and their interaction.
5. Cancellation/retry semantics at phase vs. task granularity.
6. Whether the conductor runs as a supervised **lead session** (so it inherits account failover) or as a special **orchestrator worker**.

**Scope & sequencing.** OUT OF CURRENT CLOSURE SCOPE. Start only after this closure plan is executed + verified. No task is added to this plan; the closure DoD is unchanged. (Option B remains available as an optional de-risking precursor, but the committed destination is Option C.)

### New tasks (refresh)

**None.** Justification: (a) the only newly-discovered defects are **corrections that reduce** scope (AF-R001…AF-R007), not new work; (b) every new product idea (R-UX-01…R-UX-04, the UX-05 re-scope) is an **enhancement** that the output contract routes to deferred/future ideas, and none was proven closure-blocking; (c) Check 6 (orchestration-only mode) is a **deferred future implementation phase** per the operator decision (build Option C in its own PRD + plan + spec — see the Check 6 section). The prior audit already created Tasks 6–15 for the genuinely-open defects (AF-301/302/303/325 etc.), which this pass re-confirmed. Highest existing task remains **Task 15**; `## Progress Tracking` is unchanged. **Plan status stays `PENDING` / `Approved: No`.**

### Audit Refresh Coverage Report (2026-06-23)

**Audited this pass:** target plan re-inventoried first (baseline above). Live verification re-run (typecheck/build/vitest — counts above). Code re-read for the primary emphases and the prior-HIGH re-verification: `cli/index.ts`, `cli/commands/worker.ts`, `config/schema.ts`, `config/defaults.ts` (refs), `journal/types.ts`, `journal/writer.ts`, `daemon/index.ts` (notify wiring, threshold emission, signal handlers, rehydration), `gates/engine.ts`, `workers/validation.ts`, `workers/orchestrator.ts` (sanitize/persist, approval reset, MERGING reconcile, candidate failover), `workers/worktree.ts` (boundary audit/snapshot/sanitize), `workers/merge.ts`, `providers`/`slack` surfaces; `roles.orchestrator` traced across schema/loader/defaults/execution; HI-00x regression coverage counted in `tests/`. Git HEAD confirmed unchanged since the prior audit.

**Deliberately NOT re-derived (focused-delta scope, per operator decision):** the ~30 low-severity `[agent-reported]` items (triage at implementation, unchanged); a full independent re-read of every one of the 20 subsystems (the prior audit's exhaustive Checks 1–3/5 pass is current — HEAD unchanged); AF-302/303/314…321 internals beyond a consistency spot-check (owned by Tasks 7/8/9). No subagent/workflow fan-out was used (serial run, by operator decision). No browser/E2E pass (no UI surface). The deferred Full-System Validation (Task 13) and live multiprovider run (Task 5) remain **executed = no** — this was a read-only audit, not the validation run.

**Net delta:** 6 corrections (AF-R001…R006) + 1 scope correction (AF-R007) + 1 evidence correction (AF-R008) + 1 compliance note (AF-R009); 0 new findings that warrant a task; 0 new tasks; 4 new product ideas (R-UX-01…04) + 1 reject (R-UX-05) + UX-05 re-scope; 1 Check-6 evaluation — **operator chose Option C (first-class in-aisup workflow subsystem), DEFERRED to a separate future implementation phase** (detailed design recorded in the Check 6 section). **Single biggest risk to "100%":** unchanged from the prior audit — the **lead-session half of the product is still proven only on paper** (Task 13's full-system validation and Task 5's live multiprovider run have not been executed); the refresh did not reduce that risk, it only reduced the *security-blocker* risk (Task 12).

---

## Plan-Review Fixes Applied (2026-06-23)

Source: `docs/reviews/2026-06-23-plan-review-aisup-worker-failover-closure-validation.md` (the `/plan-review` skill pass — distinct from the embedded audits above). All findings folded into the tasks; no open items remain.

- **CR-001 (CRITICAL) — journal not relocated by `AISUP_HOME`.** `journal.path` is config-driven (default `~/.aisup/journal.jsonl`, expanded via `homedir()`), NOT a `join(homedir(), '.aisup')` site, so Task 1's grep-and-route mechanism missed it → the live daemon would write its journal into the operator's REAL `~/.aisup` and Task 5 would read an empty isolated journal. **Applied:** Task 1 now resolves the `journal.path` default through `aisupHome()` in `loader.ts` + a DEDICATED journal-under-`AISUP_HOME` test (the grep DoD gives false-green); Task 5 also sets `journal.path` explicitly under `AISUP_HOME` and asserts real `~/.aisup/journal.jsonl` mtime+size unchanged; Runtime Environment + Risks updated.
- **HI-001 (HIGH) — account-first leg order-nondeterministic; bad fallback.** The failing candidate must be TRIED first to emit `worker.candidate_failed`, but unknown-headroom accounts sink last and shared `/tmp/pilot-failover` telemetry (ingested into the ledger) can reorder real accounts ahead of the no-auth account; the documented "reactive-unavailable mark" fallback DROPS the candidate (no `candidate_failed`). **Applied:** Task 5 sets `statusline.directory` to an isolated path under `AISUP_HOME` (+ fresh ledger ⇒ all `unknown` ⇒ config-order) with the no-auth account listed first, a preflight all-`unknown`-basis assertion, and a corrected fallback (seed highest-headroom isolated telemetry, not a reactive mark); Assumptions + Risks updated; Task 1 notes `statusline.directory` is intentionally NOT relocated by `AISUP_HOME`.
- **LO-001 (LOW) — Task 12 stale wording.** All six HI-00x blockers are already resolved in code (AF-R001…R007). **Applied:** Task 12 re-scoped to a LOW-priority confirm-coverage task and moved from Execution-Order Phase B (high) to Phase E (cleanup); Progress Tracking annotated.
- **IN-001 (INFO)** — `loader.ts:487-488` real-`~/.claude*` placeholder mkdir is not hit by Task 5 (config exists first) and is correctly not relocated; no change required.

**Re-review pass (2026-06-23, iteration 3)** confirmed CR-001/HI-001/LO-001 resolved against the code (config-order determinism verified via `registry.ts:25-26` + `selector.ts:53`; journal-default seam verified in `loader.ts`) and surfaced two further items, now applied:

- **ME-001 (MEDIUM) — Task 5's three legs need contradictory account/budget states.** The account-first leg needs a real Claude account AVAILABLE; the cross-LLM/budget legs need ALL claude UNAVAILABLE; per-dispatch `--implementer/--reviewer` pins a single candidate with NO failover (`orchestrator.ts:82,143`), and a single tiny codex budget can't serve both "codex wins" and "codex gated". A single loaded config cannot satisfy all three. **Applied:** Task 5 now defines a per-leg config matrix (Leg A account-first / Leg B cross-LLM with AMPLE budget / Leg C budget-gate with CROSSED budget) and runs each leg as its own short daemon lifecycle (stop → rewrite config under the same isolated `AISUP_HOME` → restart → preflight → dispatch); the cross-LLM and budget DoD bullets are tagged to their leg configs.
- **IN-002 (INFO) — stale AF-R007 cross-reference.** AF-R007 said Task 12 was "currently listed under Phase B"; annotated to note the LO-001 move to Phase E is applied.
