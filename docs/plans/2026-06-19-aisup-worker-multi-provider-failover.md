# Worker Multi-Provider Failover (Part B) Implementation Plan

Created: 2026-06-19
Author: alec.m.brock@gmail.com
Agent: Claude Code
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Worker roles (implementer + reviewer) can each be an ordered list of provider/model/account candidates, and a worker that fails (error, timeout, 429/quota, or a metered budget cap) automatically re-dispatches to the next candidate — preferring a different **Claude account first**, then a **different LLM** — so a bounded worker task completes as long as *any* candidate has headroom.

## Out of Scope

- **Orchestrator cross-LLM failover.** The lead session stays Claude and continues to fail over across Claude accounts only via the existing `accounts`/`thresholds`/`failover` path (validated in Part A — features C/D). `roles.orchestrator` may appear in config for symmetry/documentation but this plan wires **no** behavior change to the orchestrator. (Locked decision 2026-06-17.)
- **Gemini / ollama providers.** The provider abstraction must make them config-only additions later, but neither is installed, so no live wiring or validation here.
- **Carrying partial work across a failover.** Each re-dispatch starts from a fresh worktree at the same `base_sha`; partial edits from a failed candidate are discarded (the task prompt is the contract).

## Approach

**Chosen:** A new `src/providers/` layer (provider usage signals + candidate selection) feeding a failover loop inside `WorkerOrchestrator.runPipeline`, plus a new top-level `roles:` config section. Claude becomes a first-class worker provider via a `claude -p --output-format json` adapter that reuses the existing account scorer/ledger; codex gains a metered token budget parsed from `codex exec --json` `turn.completed.usage`.

**Why:** Isolating provider-usage + candidate-selection in `src/providers/` keeps the already-large `orchestrator.ts` (433 lines) focused on the pipeline and keeps selection logic pure/unit-testable; reusing `UsageLedger`/`scoreAccount` means Claude-account-first ordering is the same battle-tested mechanism Part A validated. The cost: the orchestrator gains an account/provider dependency it did not have before (injected, fake-able), and the codex adapter moves to `--json`, which changes implementer-output and reviewer-`VERDICT:` parsing.

## Context for Implementer

The worker pipeline today runs the implementer exactly **once** (`orchestrator.ts:181`) and the reviewer once (`:265`); any failure is terminal (`FAILED`/`REJECTED`). The orchestrator has **no** access to `AccountRegistry`, `scoreAccount`, or `UsageLedger` — those live in the rate-limit/failover path for the *lead session* only. This plan introduces the first worker→account coupling: a candidate selector (new `src/providers/`) that the daemon injects into `OrchestratorDeps`. Keep the orchestrator's existing invariants intact — boundary audit (`:196`), sanitize-before-persist (`:206`), fail-closed validation (`:255`) and review (`:277`), and human approval before merge — they run **per successful candidate**, unchanged. Provider "UNAVAILABLE" is a shared, reactive mark (a 429/quota error or a crossed budget) that removes a candidate from selection until its window/period resets — mirroring how the account circuit-breaker already works.

## Runtime Environment

- **Daemon:** `source ~/.aisup/secrets.env && node dist/daemon/index.js` (background); health `http://127.0.0.1:7394/api/health`. `CODEX_HOME` and Slack tokens come from `secrets.env`.
- **Worker dispatch:** `node dist/cli/index.js worker dispatch --task-type implement --prompt "<bounded task>" --workspace <scratch repo>`.
- **No `AISUP_CONFIG` override** — `loadConfig()` reads `~/.aisup/config.yaml`; use backup→edit→restart for config tests.

## Assumptions

- **codex `turn.completed.usage` shape is stable** — `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` (captured live 2026-06-19, codex-cli 0.140.0). Tasks 3, 4 depend on this.
- **`claude -p --output-format json` final-result shape is CONFIRMED (2026-06-19, real run):** the output is a JSON array of stream events whose final `{type:'result'}` element carries `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, …}`, `total_cost_usd`, `result` (final text), and `subtype:'success'|…`. Task 5 parses tokens = `input_tokens + output_tokens` and the `result` text from that element — a measured fact, not an assumption. (Host-gated run in Task 5/10 re-confirms with edits in a worktree.)
- **The default codex budget is a *starter* value to be tuned to the operator's ChatGPT plan.** codex exposes no quota readout, so the default cap is a heuristic, not a measured limit (Task 1). Tasks 3, 7 depend on the operator tuning it.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `claude -p` headless edit/auth behaves differently than the interactive runner (no diff produced, or auth not found via `CLAUDE_CONFIG_DIR`) | Medium | High | Task 5 includes a **real host-gated run** asserting a non-empty diff + parsed usage before the adapter is considered done; unit tests cover argv/env only. |
| codex `--json` output-format change breaks reviewer `VERDICT:` extraction (verdict lives inside an `agent_message` item, not a raw stdout line) | Medium | High | Task 4 parses a **captured real `--json` fixture**; `parseVerdict` extracts the final `agent_message` text; non-json adapters keep the existing raw-line path. Fail-closed: a parse failure still rejects. |
| Wrong default codex budget → premature mid-task failover | Medium | Medium | Conservative default fires a **clean proactive** handoff (fresh worktree on the next candidate) before a real 429; reactive 429/quota backstop sits underneath; default value surfaced at approval + documented as tunable. |
| All candidates exhausted leaves a worker stuck | Low | Medium | Terminal `FAILED` with `worker.all_candidates_exhausted` (reason + per-candidate basis) + Slack notification; every failed candidate's worktree is cleaned up (reuses the empty-`worktree_dir` tidy fixed 2026-06-19). |
| A failed/timed-out candidate mutates the **main** tree, then failover masks it with a clean candidate (fail-OPEN) | Medium | High | **Boundary audit on every candidate** (not just the success path) against a pre-first-candidate baseline; a violation is **terminal** (no failover) — Task 7 invariant + fail-closed negative test. Raised by Codex adversarial review. |

## Goal Verification

### Truths

1. With `roles.implementer = [claude(2+ accounts), codex]`, forcing the first Claude account to 429 (reactive) or past its ledger headroom causes the **same task** to complete on the **next Claude account** in a fresh worktree, with no operator action — observable in the journal as `worker.candidate_failed` → `worker.failover` → `worker.completed`.
2. When **all** Claude accounts are unavailable, the same implementer task crosses to **codex** (cross-LLM) and completes; and codex's metered token budget **gates codex** — with the budget crossed and all Claude unavailable, the task terminates `worker.all_candidates_exhausted` rather than running unbounded codex. _(Corrected 2026-06-25: the earlier clause "a codex-default task instead fails over to an available Claude account" was unreachable — if all Claude is unavailable there is no Claude to fall back to; the budget gate is what bounds codex. Validated live — see Real-run Validation and `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md`.)_
3. `aisup` surfaces, per provider, a live availability/headroom readout (Claude account headroom % with `live|aged|reset` basis; codex tokens-used vs budget with remaining), and a cross-LLM failover posts a Slack notification to the session channel.

## Progress Tracking

- [x] Task 1: `roles:` config schema + codex budget + back-compat synthesis + validation
- [x] Task 2: Provider usage abstraction + Claude usage signal (ledger/scorer)
- [x] Task 3: Codex token-budget meter (usage-ledger budget basis) + codex usage signal
- [x] Task 4: Codex `--json` adapter mode + JSON-stream usage/verdict parsing
- [x] Task 5: Claude-as-worker adapter (`claude -p`, per-account `CLAUDE_CONFIG_DIR`)
- [x] Task 6: Candidate resolution + selection (account-first → cross-LLM, pure)
- [x] Task 7: Worker failover loop + fresh-worktree re-dispatch in the orchestrator
- [x] Task 8: Orchestrator provider/account dependency wiring (daemon)
- [x] Task 9: Observability — CLI per-provider usage + Slack cross-LLM failover + journal
- [x] Task 10: Real host-gated end-to-end validation (codex + Claude worker)

## File Structure

- `src/providers/types.ts` (create) — `ProviderName`, `ProviderCandidate`, `UsageSignal` (`{available, headroom_pct?, remaining_tokens?, basis, reason?}`), `ProviderUsage` interface (`usageSignal(candidate, nowMs) → UsageSignal`).
- `src/providers/claude-usage.ts` (create) — Claude `ProviderUsage`: per-account availability/headroom from `UsageLedger.estimate` + `scoreAccount` + circuit-breaker/cooldown.
- `src/providers/codex-usage.ts` (create) — codex `ProviderUsage`: availability/remaining from the budget meter.
- `src/providers/selector.ts` (create) — pure `resolveCandidates(roleCandidates, usages, registry, nowMs) → ConcreteCandidate[]` (Claude expands best→worst accounts; cross-LLM appended in config order; UNAVAILABLE filtered).
- `src/workers/codex-json.ts` (create) — parse codex stream-json: final `agent_message` text + `turn.completed.usage`.
- `src/workers/claude-adapter.ts` (create) — build the `claude -p --output-format json` launch plan for a selected account; parse its result JSON for final text + usage.
- `src/workers/failover.ts` (create) — the candidate loop helper used by `runPipeline` (run candidate → on failure mark UNAVAILABLE + emit + clean worktree → next).
- `src/config/schema.ts` (modify) — `RolesConfig`, `RoleCandidateConfig`, `CodexBudgetConfig`; add `roles` to `AisupConfig`.
- `src/config/defaults.ts` (modify) — default `roles` (mirrors current routing), default codex budget cap.
- `src/config/loader.ts` (modify) — `validateRoles` + back-compat synthesis from `workers.routing` when `roles` absent.
- `src/accounts/usage-ledger.ts` (modify) — budget-basis entry (`tokens_used`, `cap`, `period_reset_at`) + `recordConsumption` + `estimateBudget`.
- `src/workers/orchestrator.ts` (modify) — candidate-list failover loop for implementer + reviewer; `OrchestratorDeps` gains a candidate selector.
- `src/workers/review.ts` (modify) — `parseVerdict` consumes `codex-json` final text when the reviewer adapter is json-mode.
- `src/daemon/index.ts` (modify) — construct provider-usage + selector from registry/ledger/scorer; inject into the orchestrator.
- `src/cli/commands/worker.ts` (modify) — per-provider usage readout.
- `src/journal/types.ts` (modify) — `worker.candidate_failed`, `worker.failover`, `worker.all_candidates_exhausted`, `worker.worktree_cleanup_error` events.

## Implementation Tasks

### Task 1: `roles:` config schema + codex budget + back-compat synthesis

**Objective:** Add a top-level `roles:` config section expressing implementer/reviewer (and documentation-only orchestrator) as ordered candidate lists, plus a codex token-budget config. When `roles` is absent, synthesize it from the existing `workers.routing` so current configs keep working unchanged. This is the config contract every later task reads.

**Files:**

- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/loader.ts`
- Test: `tests/config/loader.test.ts` (reuse existing config test file; add a roles describe block)

**Key Decisions / Notes:**

- `RoleCandidateConfig = { provider: 'claude' | string /*adapter name*/, model?: string | null, effort?: string | null, budget?: CodexBudgetConfig | null }`. `provider: 'claude'` means "Claude worker, account selected by the scorer"; any other value must be a defined `workers.adapters` key.
- `RolesConfig = { implementer: RoleCandidateConfig[]; reviewer: RoleCandidateConfig[]; orchestrator?: RoleCandidateConfig[] }`. `CodexBudgetConfig = { tokens: number; period_hours: number }`.
- **Default codex budget (starter, tunable):** `{ tokens: 3_000_000, period_hours: 5 }` — flag in `## Assumptions`; surface the value at approval. A trivial codex run ≈ 39k tokens (measured), so this is ~tens of tasks per 5h before a clean proactive failover.
- **Back-compat synthesis** (in `validateRoles`, loader): when `raw.roles` is absent, build `implementer: [{provider: routing.default_implementer}]`, `reviewer: [{provider: routing.default_reviewer}]` so existing single-codex configs are a one-candidate list. Follow the `mergeDeep(CONFIG_DEFAULTS, raw)` + explicit-validation pattern (`loader.ts:312`, `:142`).
- Validation rules (mirror `validateWorkers` style, `loader.ts:142`): every candidate `provider` is either `'claude'` or a defined adapter; `claude` requires ≥1 enabled account to exist; reject empty implementer/reviewer lists when `workers.enabled`; `budget.tokens`/`period_hours` positive integers.
- **Resolution priority (no-source edge case):** explicit `roles` > back-compat synthesis from `workers.routing` > error. When `workers.enabled === true` and **both** `roles` and `workers.routing` defaults are absent/empty, fail with `Config validation error: workers.enabled requires either a roles config or workers.routing`. When `workers.enabled === false`, missing roles/routing is allowed (no workers run). Note: `CONFIG_DEFAULTS.workers.routing` is always present, so in practice synthesis has a source unless an operator blanks it.
- **⛔ Per-dispatch override migration (Codex review, medium).** `DispatchInput.implementer`/`reviewer` (`orchestrator.ts:58-59`, forwarded by `cli/commands/worker.ts` + `daemon/server.ts`) currently name an enabled adapter (`orchestrator.ts:105-110`). Under roles these must be defined, not left implicit: an explicit `--implementer <X>` / `--reviewer <X>` **overrides the role's candidate list with a single-candidate list** `[{provider: X}]` for that dispatch (no failover — the operator pinned it). `X` may be `'claude'` (valid provider, account auto-selected) or any **defined** adapter name; an `X` that is neither `'claude'` nor a defined adapter fails fast with a clear `dispatch validation error: --implementer "X" is not 'claude' or a defined adapter`. This keeps the pinned-adapter escape hatch working while making `provider:'claude'` reachable from the CLI/API.

**Definition of Done:**

- [ ] A config with an explicit `roles:` block (claude + codex candidates) loads and validates.
- [ ] A config with **no** `roles:` block synthesizes one-candidate lists from `workers.routing` (back-compat) and still loads.
- [ ] Invalid candidate (`provider` naming an undefined adapter; empty list with workers enabled; non-positive budget) is rejected with a clear `Config validation error:`.
- [ ] A config with `workers.enabled:true` and neither `roles` nor `workers.routing` is rejected with the explicit "requires either a roles config or workers.routing" error.
- [ ] An explicit dispatch override (`--implementer claude` and `--implementer <defined-adapter>`) resolves to a single-candidate list; an override naming neither `'claude'` nor a defined adapter fails fast with the named dispatch validation error. (Override→candidate resolution is exercised in Task 7.)
- [ ] Verify: `npx vitest run tests/config/loader.test.ts -q`

### Task 2: Provider usage abstraction + Claude usage signal

**Objective:** Define the provider-agnostic `ProviderUsage` interface (`usageSignal()`), and implement the Claude provider so a candidate's availability + headroom is derived from the existing `UsageLedger` decayed estimate, `scoreAccount`, and circuit-breaker/cooldown state — the same signals Part A validated for the lead session.

**Files:**

- Create: `src/providers/types.ts`
- Create: `src/providers/claude-usage.ts`
- Test: `tests/providers/claude-usage.test.ts`

**Key Decisions / Notes:**

- `UsageSignal = { available: boolean; headroom_pct: number | null; remaining_tokens: number | null; basis: 'live' | 'aged' | 'reset' | 'budget' | 'unknown'; reason?: string }`.
- Claude `usageSignal(account, nowMs)`: read `UsageLedger.estimate(account, nowMs)`; `headroom_pct = computeScore(five, seven)` reusing `scorer.ts:computeScore`; `available = false` when the account is in circuit-breaker cooldown OR carries a reactive `UNAVAILABLE` mark (see Task 7); `reset` basis → fully available (headroom 100).
- **⛔ Deviation from original Key Decisions (discovered during impl, 2026-06-19):** an account with **no usable ledger telemetry (basis `unknown`)** is treated as **optimistically available with `headroom_pct: null`**, NOT unavailable. Making unknown→unavailable would collapse a cold start (no account has rendered telemetry yet) to **zero Claude candidates**, defeating the account-first guarantee. The selector (Task 6) orders known-headroom accounts ahead of unknown ones, so measured headroom is still preferred — but a never-seen account remains a candidate. Only cooldown / reactive-429 marks make an account unavailable.
- Inject `UsageLedger`, an account→state lookup (from `AccountRegistry`), and the reactive-unavailable set — do not import the registry concretely into `src/providers` beyond a small readonly interface (keep the layer testable with fakes).

**Definition of Done:**

- [ ] Claude `usageSignal` returns `available:true` with a headroom % for an account whose ledger window is `live`/`aged`/`reset`.
- [ ] An account in cooldown or marked reactively-unavailable returns `available:false` with a `reason`.
- [ ] Verify: `npx vitest run tests/providers/claude-usage.test.ts -q`

### Task 3: Codex token-budget meter + codex usage signal

**Objective:** Extend `UsageLedger` with a budget-basis entry so codex token consumption accumulates against a configured cap over a rolling period, resetting at period end; expose a codex `ProviderUsage.usageSignal()` that reports available/remaining from that meter. This is the metered half of the codex failover trigger (the reactive 429 backstop is the other half, wired in Task 7).

**Files:**

- Modify: `src/accounts/usage-ledger.ts`
- Create: `src/providers/codex-usage.ts`
- Test: `tests/accounts/usage-ledger.test.ts` (extend), `tests/providers/codex-usage.test.ts`

**Key Decisions / Notes:**

- **Exact store shape (specified, not vague).** Today the ledger persists `{ accounts: { <name>: LedgerEntry } }` (`usage-ledger.ts:75`). Extend to `{ accounts: {...}, budgets: { <provider>: BudgetEntry } }` where `BudgetEntry = { tokens_used: number; cap: number; period_reset_at: number /*epoch s*/ }`. `load()` reads `parsed.budgets ?? {}` alongside `parsed.accounts`; `persist()` writes BOTH maps in one atomic tmp-write+rename (the existing `persist()` already serialises the whole object — budgets ride along, no separate write, no merge ambiguity).
- **Signatures (specified, as implemented):** `recordConsumption(provider: string, tokens: number, nowMs: number, cfg: CodexBudgetConfig): void` and `estimateBudget(provider: string, nowMs: number, cfg: CodexBudgetConfig): { tokens_used; cap; remaining; available }`. **`estimateBudget` takes the live `cfg`** (minor deviation from the original `(provider, nowMs)`) so a lowered budget cap takes effect immediately rather than after the next codex run — `cap = cfg.tokens`, `tokens_used` decays to 0 once the stored period elapses. Scoping is **global per provider** (codex auth is a single ChatGPT account, not per-aisup-account) — one `budgets.codex` entry.
- `recordConsumption`: if no entry or `nowMs/1000 >= period_reset_at`, reset `tokens_used=0` and set `period_reset_at = nowMs/1000 + cfg.period_hours*3600` and `cap = cfg.tokens`; then `tokens_used += tokens`; `persist()`. `tokens` = `input_tokens + output_tokens` (cached/reasoning excluded from the cap — document inline).
- **Concurrency:** like the existing ledger, methods are **synchronous** and the daemon is single-process/single-threaded (Node event loop) — no locking; a `recordConsumption` runs to completion (load-in-memory → mutate → atomic write) before the next. Matches `capture()`/`persist()` today.
- codex `usageSignal(nowMs, cfg)`: `available = tokens_used < cap` (after applying period reset); `remaining_tokens = max(0, cap - tokens_used)`; `basis: 'budget'`.
- Keep the existing Claude window methods untouched — this is purely additive.

**Definition of Done:**

- [ ] `recordConsumption` accumulates tokens; crossing `cap` flips `usageSignal.available` to false with `remaining_tokens:0`.
- [ ] After `period_reset_at` passes, the next `recordConsumption`/`usageSignal` sees `tokens_used` reset to 0 and `available:true`.
- [ ] Existing Claude ledger tests still pass (additive, no regression).
- [ ] Verify: `npx vitest run tests/accounts/usage-ledger.test.ts tests/providers/codex-usage.test.ts -q`

### Task 4: Codex `--json` adapter mode + JSON-stream usage/verdict parsing

**Objective:** Switch the codex adapter to `codex exec --json` and parse its stream-json output to (a) extract the final `agent_message` text (so reviewer `VERDICT:` detection and implementer output still work) and (b) extract `turn.completed.usage` for the budget meter. Non-json adapters keep the existing raw-stdout path.

**Files:**

- Create: `src/workers/codex-json.ts`
- Modify: `src/workers/review.ts` (`parseVerdict` path)
- Modify: `src/config/defaults.ts` (codex adapter `args` include `--json`; add an adapter `output_format: 'text' | 'json'` flag on `WorkerAdapterConfig` in `schema.ts`)
- Modify: `src/config/schema.ts` (adapter `output_format` field, default `'text'`)
- Test: `tests/workers/codex-json.test.ts` (real captured fixture), `tests/workers/review.test.ts` (extend)

**Key Decisions / Notes:**

- **The codex `--json` shape is ALREADY confirmed live (2026-06-19, codex-cli 0.140.0)** — a real `codex exec --json` run this planning session emitted `{"type":"turn.completed","usage":{"input_tokens":39058,"cached_input_tokens":2432,"output_tokens":35,"reasoning_output_tokens":27}}` and the final text as `{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}`. So this is NOT an unverified assumption — Tasks 3/5/7 build on a measured fact. The fixture below is that exact capture.
- **Fixture parse is done IN THIS TASK, not deferred.** Commit the captured stream as a test fixture; `codex-json` must parse it and the test must pass before Task 5 starts. (Task 10's host-gated run re-confirms end-to-end, but Task 4 stands alone on the committed fixture.)
- Fixture is the **real** captured stream: lines `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` and `{"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}`. Parser walks NDJSON lines, returns `{ finalText, usage }`; tolerant of interleaved `reasoning`/`thread.started`/`turn.started` lines.
- `parseVerdict` (review.ts:33): when `reviewerAdapter.output_format === 'json'`, run the captured stdout through `codex-json` first, then apply the existing `VERDICT: APPROVE|REJECT` extraction to `finalText`. **Fail-closed unchanged**: no parseable verdict → reject.
- Implementer output: the orchestrator still captures the diff via `git` (`orchestrator.ts:193`) regardless of stdout format; `codex-json` is only needed for usage + the reviewer verdict text. Record `usage` into the meter (Task 3) at the point the codex run completes (wired fully in Task 7).
- `output_format` defaults to `'text'` so every other adapter is unaffected.

**Definition of Done:**

- [ ] `codex-json` parses `finalText` and `usage{input_tokens,output_tokens}` from the **committed real fixture** (the 2026-06-19 capture) — this gate passes within Task 4, not Task 10.
- [ ] A reviewer adapter with `output_format:'json'` yields `APPROVE`/`REJECT` from a JSON-wrapped `VERDICT:` line; a stream with no verdict still rejects (fail-closed).
- [ ] Text-mode adapters parse exactly as before (no regression).
- [ ] Verify: `npx vitest run tests/workers/codex-json.test.ts tests/workers/review.test.ts -q`

### Task 5: Claude-as-worker adapter

**Objective:** Add a Claude worker provider that runs `claude -p --output-format json --permission-mode <bypass>` in the worktree under a scorer-selected account's `CLAUDE_CONFIG_DIR` (real auth) with an isolated `HOME`, edits files (captured as a diff like any worker), and parses Claude's JSON result for final text + token usage. This makes `provider: 'claude'` a real implementer/reviewer.

**Files:**

- Create: `src/workers/claude-adapter.ts`
- Test: `tests/workers/claude-adapter.test.ts` (unit: argv/env), `tests/host-gated/claude-worker.test.ts` (real run, env-gated)

**Key Decisions / Notes:**

- Launch plan: `command: 'claude'`, `args: ['-p', '--permission-mode', '<mode>', '--output-format', 'json', '--model', <model?>]`, prompt as final positional (`prompt_via:'arg'`). Env: allowlisted + `CLAUDE_CONFIG_DIR=<account.config_dir>` (real auth) + `HOME=<worktree>/.home` (isolation) — mirror `buildWorkerCommand` env handling (`adapter.ts:66`).
- Permission mode: use a non-interactive bypass so the worker can Edit/Write without prompts — confirm exact token (`bypassPermissions` vs `--dangerously-skip-permissions`) in the host-gated run; default to whichever the real run proves applies edits.
- Parse the final `{type:'result'}` element of the `--output-format json` array for `usage{input_tokens,output_tokens}` + `total_cost_usd` + `result` text (shape confirmed live 2026-06-19 — see `## Assumptions`); this file is the single change point if a future CLI version reshapes it.
- **Host-gated test harness (specified, runnable — not a manual procedure).** `tests/host-gated/claude-worker.test.ts`: (a) reads `AISUP_TEST_CLAUDE_WORKER`; when unset, the test **skips cleanly** with reason "AISUP_TEST_CLAUDE_WORKER not set" (never ERRORs); (b) when set, creates a scratch git repo under `/private/tmp/aisup-claude-test-<uuid>` (canonical `/private/tmp`, init + one commit) and removes it in `afterEach`; (c) resolves a real account `config_dir` from `loadConfig()` (the live `~/.aisup/config.yaml` accounts — there is no `accounts.json`), or from `AISUP_TEST_CLAUDE_CONFIG_DIR` if provided; (d) runs the real `claude -p` subprocess via the adapter's launch plan; (e) asserts a non-empty diff and a parsed usage object. Running `AISUP_TEST_CLAUDE_WORKER=1 npx vitest run tests/host-gated/claude-worker.test.ts` yields PASS or SKIP, never a harness ERROR.
- Unit test asserts argv/env only (no spawn), per the testing rules.

**Definition of Done:**

- [ ] Unit: the built launch plan has `claude -p … --output-format json`, the account's `CLAUDE_CONFIG_DIR`, and `HOME=<worktree>/.home`.
- [ ] `tests/host-gated/claude-worker.test.ts` exists and **skips cleanly** (reason logged) when `AISUP_TEST_CLAUDE_WORKER` is unset — runnable by any implementer without ERROR.
- [ ] Host-gated (when env set): a real `claude -p` worker edits a file in the scratch worktree (non-empty diff) and the adapter parses a usage object.
- [ ] Verify: `npx vitest run tests/workers/claude-adapter.test.ts -q` and `AISUP_TEST_CLAUDE_WORKER=1 npx vitest run tests/host-gated/claude-worker.test.ts -q` (PASS or SKIP, never ERROR)

### Task 6: Candidate resolution + selection (pure)

**Objective:** Implement the pure function that turns a role's ordered candidate list into a concrete ordered list of available run targets: a `claude` candidate expands to its accounts best-headroom-first (scorer/ledger), cross-LLM candidates append in config order, and any UNAVAILABLE target (no headroom, cooldown, budget exhausted, reactive 429 mark) is filtered out.

**Files:**

- Create: `src/providers/selector.ts`
- Test: `tests/providers/selector.test.ts`

**Key Decisions / Notes:**

- `resolveCandidates(roleCandidates, { claudeUsage, codexUsage, accounts }, nowMs) → ConcreteCandidate[]` where `ConcreteCandidate = { provider, account?: string, model?, effort? }`.
- Claude expansion: enumerate enabled accounts, score each via `claudeUsage.usageSignal`, drop unavailable, sort by `headroom_pct` desc (account-first ordering — same as the lead session's selection).
- Ordering invariant: **all** available Claude accounts come before the first cross-LLM candidate (account-first-then-LLM, locked decision); cross-LLM candidates keep config order.
- Returns `[]` when every candidate is unavailable → caller (Task 7) treats as `all_candidates_exhausted`.

**Definition of Done:**

- [ ] A `[claude, codex]` role with 2 healthy accounts resolves to `[claude@best, claude@second, codex]` in that order.
- [ ] An account in cooldown / a codex over budget is excluded from the resolved list.
- [ ] All-unavailable resolves to `[]`.
- [ ] Verify: `npx vitest run tests/providers/selector.test.ts -q`

### Task 7: Worker failover loop + fresh-worktree re-dispatch

**Objective:** Replace the single implementer run (and single reviewer run) in `runPipeline` with a candidate loop: run the first resolved candidate; on a failover-worthy failure (timeout, unspawnable, non-zero exit with a 429/quota/auth signal) mark that target UNAVAILABLE (reactive backstop), clean up its worktree, and re-dispatch the next candidate from a fresh worktree at the same `base_sha`; stop at the first success or when candidates are exhausted. Record codex usage into the meter on each codex run.

**Files:**

- Create: `src/workers/failover.ts`
- Modify: `src/workers/orchestrator.ts`
- Modify: `src/journal/types.ts`
- Test: `tests/workers/failover.test.ts`, `tests/workers/orchestrator.test.ts` (extend)

**Key Decisions / Notes:**

- Reuse the reactive patterns from `recovery-handler.ts` `RATE_LIMIT_PATTERNS` / auth patterns to classify a worker's stderr/exit as 429/quota/auth → mark UNAVAILABLE; a plain non-zero exit with no such signal is a genuine task failure for *that* candidate and also advances to the next (the task may still succeed elsewhere), but is journaled distinctly.
- Fresh-worktree re-dispatch: on each candidate, `createWorktree` → run → on failure `removeWorktree` before the next candidate. Preserve all existing post-implement steps (boundary audit, sanitize, validation, review) **per successful candidate**.
- **Cleanup invariants (explicit):** (1) on a failover-worthy failure, `removeWorktree` runs **before** the next `createWorktree` — only one candidate's worktree exists at a time. (2) on a successful run reaching `AWAITING_APPROVAL`, the worktree is **preserved** (existing post-merge cleanup owns it). (3) on terminal exhaustion (`FAILED`), a final cleanup pass removes the last candidate's worktree. (4) a `removeWorktree` error is journaled (`worker.worktree_cleanup_error {path, error}`) but does **not** block the next candidate. (5) `removeWorktree` already prunes the now-empty `worktree_dir` base (working-tree change applied this session — **already present, not a dependency of this plan**), so a long failover loop leaves no stale `<task-id>` subdirs.
- **⛔ Boundary audit on EVERY candidate, fail-closed (Codex review, high).** Today `auditBoundary`/`sanitizePatch` are reached only on the *success* path; a worker that times out or crashes early-returns at `orchestrator.ts:185-190` **before** the audit. Under failover that is a fail-OPEN gap: a failed candidate could mutate the **main** workspace (or a forbidden path) outside its worktree, get classified failover-worthy, and a later clean candidate reaches `AWAITING_APPROVAL` while the main-tree side effect is never reviewed. **Fix:** take the `snapshotMainTree` baseline **once before the first candidate**, and after **every** candidate attempt — success, non-zero, timeout, or 429 — run `auditBoundary` against that baseline **before** any failover or cleanup. A boundary/forbidden-path violation is **terminal** (`worker.boundary_violation` → `FAILED`, no failover, no further candidates) — a failed candidate that touched the main tree is a security event, not a retry. (The baseline stays valid across candidates because `snapshotMainTree` excludes the `worktree_dir` subtree, so create/remove of per-candidate worktrees is invisible to it.)
- Reviewer failover: when the configured reviewer (e.g. codex) is unavailable, resolve the reviewer candidate list (e.g. fall back to an open Claude account) — reuse the same loop; keep `allow_same_model_review` semantics from `review.ts`.
- New journal events: `worker.candidate_failed` (`{candidate, reason}`), `worker.failover` (`{from, to}`), `worker.all_candidates_exhausted` (`{tried: [...]}`), `worker.worktree_cleanup_error` (`{path, error}`). Terminal exhaustion → `FAILED` + Slack (Task 9).
- Bound the loop by the resolved candidate count (no infinite retry); honor `isCancelled` checks between candidates (mirror existing `:183/:199/:239`).
- Record codex `usage` (from Task 4) via `recordConsumption` (Task 3) right after a codex run resolves, success or failure.
- **Dispatch override resolution (Task 1 migration rule):** at `dispatch()`, an explicit `input.implementer`/`input.reviewer` collapses the role's candidate list to a single pinned candidate `[{provider: override}]` (no failover); unsupported override → fail-fast dispatch validation error (see Task 1).

**Definition of Done:**

- [ ] An implementer whose first candidate returns a 429-classified failure re-runs the **same task** on the next candidate in a **fresh** worktree and reaches `AWAITING_APPROVAL`; journal shows `worker.candidate_failed`→`worker.failover`→`worker.awaiting_approval`.
- [ ] All candidates failing → status `FAILED`, `worker.all_candidates_exhausted` with the tried list; no stale `<task-id>` worktree subdirs remain (assert the `worktree_dir` is clean of this task).
- [ ] A `removeWorktree` failure mid-loop emits `worker.worktree_cleanup_error` and does NOT block the next candidate.
- [ ] **(fail-closed negative test)** A candidate that mutates the **main** tree (or a forbidden path) and then fails (timeout / non-zero / 429) triggers `auditBoundary` against the pre-first-candidate baseline → terminal `worker.boundary_violation`/`FAILED` with **no** failover to a further candidate. Cover all three failure classes.
- [ ] Reviewer falls over to a Claude account when codex is unavailable.
- [ ] A codex run records its token usage into the budget meter.
- [ ] An explicit `--implementer claude` / `--implementer <adapter>` pins a single candidate (no failover); an unsupported override fails fast with the dispatch validation error.
- [ ] Verify: `npx vitest run tests/workers/failover.test.ts tests/workers/orchestrator.test.ts -q`

### Task 8: Orchestrator provider/account dependency wiring (daemon)

**Objective:** Construct the provider-usage providers (Claude + codex) and the candidate selector from the daemon's existing `AccountRegistry`, `UsageLedger`, and scorer, and inject them into `OrchestratorDeps` so the failover loop has real account/provider data. Existing single-codex configs must keep working (one-candidate lists from Task 1 back-compat).

**Files:**

- Modify: `src/daemon/index.ts`
- Modify: `src/workers/orchestrator.ts` (`OrchestratorDeps` gains `selectCandidates` + provider-usage + a `recordCodexUsage` hook; keep them optional so unit tests inject fakes)
- Test: `tests/daemon/*` smoke (extend an existing worker/daemon smoke test rather than a new file)

**Key Decisions / Notes:**

- Build `claudeUsage` from `usageLedger` + `accountRegistry`; `codexUsage` from the budget meter + `config.roles` codex budget; pass a `selectCandidates(role, nowMs)` closure into the orchestrator.
- **Optional-dep contract (explicit, no silent gaps).** `OrchestratorDeps.selectCandidates?` is optional in the TYPE only. Behavior: when **absent**, the orchestrator uses a built-in single-candidate resolver that wraps the current `resolveRouting` result as a one-element list — i.e. *exactly today's behavior, no failover loop*. When **present**, the Task 7 failover loop runs. There is no third state. The daemon (Task 8 wiring) **always** passes a real `selectCandidates`; only unit tests may omit it (to exercise the legacy single path) or pass an explicit test double (to exercise failover) — a test must **inject** its double, never rely on a guessed/partial selector.
- Document this contract in the `OrchestratorDeps`/constructor JSDoc: "`selectCandidates` is required in production (daemon injects it); omit ONLY in single-adapter unit tests, where the orchestrator falls back to the legacy one-candidate path."
- No behavior change to the lead-session failover path — this only adds worker wiring.

**Definition of Done:**

- [ ] The daemon constructs the orchestrator with provider selection deps; `aisup worker dispatch` on a single-codex config still runs end-to-end (back-compat).
- [ ] Existing orchestrator unit tests construct it **without** `selectCandidates` (legacy one-candidate path) and still pass.
- [ ] A new unit test constructs the orchestrator **with** a mock `selectCandidates` and asserts the failover loop runs once per resolved candidate (not per account).
- [ ] Verify: `npx vitest run tests/workers tests/daemon -q`

### Task 9: Observability — CLI per-provider usage + Slack failover + journal

**Objective:** Surface per-provider availability so the operator can see why selection chose what it did, and notify Slack when a worker crosses LLMs. Claude accounts show headroom % + basis (already in `aisup accounts`); add codex tokens-used vs budget + remaining; post a Slack message on `worker.failover` across providers.

**Files:**

- Modify: `src/cli/commands/worker.ts`
- Modify: `src/slack/service.ts` (a worker cross-LLM failover notification, reusing the `chat.postMessage` best-effort pattern)
- Modify: `src/daemon/index.ts` (route `worker.failover` cross-provider → Slack)
- Test: `tests/cli/worker.test.ts` (or existing CLI worker test), `tests/slack/service.test.ts` (extend)

**Key Decisions / Notes:**

- `aisup worker providers` (or extend `aisup worker status`): print each role's candidates with `available`, headroom/remaining, basis. Read via the daemon API (add a small `/api/workers/providers` read or reuse `/api/accounts` + a new providers field).
- Slack notification only on a **cross-provider** failover (claude→codex or codex→claude), not account→account within Claude (that is routine and already covered by lead-session notifications) — avoid noise.
- Keep all Slack posts best-effort (`try/catch`) like the existing session-info/stop/exhausted posts.

**Definition of Done:**

- [ ] CLI shows codex tokens-used/remaining vs budget and Claude account headroom + basis per role candidate.
- [ ] A cross-LLM `worker.failover` posts a Slack message naming from/to provider + task id.
- [ ] Verify: `npx vitest run tests/cli/worker.test.ts tests/slack/service.test.ts -q`

### Task 10: Real host-gated end-to-end validation

**Objective:** Provide a host-gated integration test plus a documented manual procedure that exercises the full account-first→cross-LLM path with the **real** codex CLI and a **real** `claude -p` worker — the no-mocks discipline Part A used. This is the acceptance evidence for the Goal Verification truths.

**Files:**

- Create: `tests/host-gated/worker-multiprovider.test.ts` (env-gated: `AISUP_TEST_MULTIPROVIDER=1`, document `CODEX_HOME` + account config dirs)
- Modify: `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md` (append a "Real-run validation" log during verification)

**Key Decisions / Notes:**

- Gated test: dispatch a bounded implement task with `roles.implementer=[claude(2 accounts), codex]`; force the first account unavailable (lowered budget / injected 429 into the candidate's captured output, mirroring Part A injection) and assert the journal failover chain + a real completion on the next candidate.
- Document required env + that the test is skipped by default (keep host-gated tests separate from unit tests — project rule).
- Manual procedure: the real daemon + `aisup worker dispatch` against a `/private/tmp` scratch repo, capturing journal + Slack evidence (the Part A harness).

**Definition of Done:**

- [ ] Host-gated test exists, is skipped without its env flag, and (when enabled) drives a real failover to completion.
- [ ] Manual real-run procedure is documented for the verification step.
- [ ] Verify: `npx vitest run tests/host-gated/worker-multiprovider.test.ts -q` (skips cleanly without the env flag)

## Open Questions

- **Default codex budget value** (`tokens: 3_000_000 / period_hours: 5`) is a starter heuristic — confirm or adjust at approval to match your ChatGPT plan. codex exposes no quota readout, so this can't be derived.

## Real-run Validation (Task 10)

### Live full-daemon run (2026-06-25) — all three Truths proven

Executed `scripts/validation/live-multiprovider-failover.sh` (committed in the closure plan) against a real state-isolated daemon, real `aisup worker dispatch`, real `claude -p` + `codex exec --json`. Exit 0; operator `~/.aisup` untouched (config sha + journal mtime/size asserted unchanged). Each leg ran its own worker (A 60s, B 2m13s, C 3s).

- **Truth 1 (Leg A, `d7b591ad`):** `candidate_failed{auth_failed, claude:noauth}` → `failover{noauth→authed}` → `completed{README.md}` → `validated` → `review_passed{approve}` → `awaiting_approval`. Real account, clean README-only patch, reviewer approved. ✓
- **Truth 2 (Leg B, `06b2d6a5`):** `candidate_failed{auth_failed, claude:noauth1}` → `failover{noauth1→codex, cross_provider:true}` → codex `completed` → `review_passed` → `awaiting_approval` (cross-LLM to a real codex winner). **(Leg C, `f44bb5e4`):** with codex budget crossed (`providers`: `codex UNAVAILABLE 0 tokens left budget_exhausted`) and all Claude unavailable → `all_candidates_exhausted`, no codex subprocess — confirming the corrected Truth 2 (budget gates codex). ✓
- **Truth 3:** `aisup worker providers` reported live availability per leg — `codex … 3000000 tokens left basis=budget` / claude `basis=unknown`, flipping to `budget_exhausted` in Leg C. ✓ Cross-provider Slack post is wired (`notifyCrossProviderFailover`) but did not fire this run (lead session blocked by an active session); the `cross_provider:true` journal event is the DoD-fallback evidence.

Two product bugs were found+fixed during this run (real-subprocess output the fake adapters could not exercise): tool-data dirs (`.codegraph/`/`.serena/` from the operator's CodeGraph SessionStart hook + Serena MCP) leaking into the captured patch → `worktree.ts` `DIFF_EXCLUDE_DIRS`; and `runWorker` tail-truncating stdout before the JSON parse (corrupting reviewer verdict + usage) → full stdout returned, truncation moved to `tailOutput` persistence. Full suite: 712 pass / 0 fail. Details in `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` § Real-run Validation.

### Host-gated test

`tests/host-gated/worker-multiprovider.test.ts` drives the account-first→cross-LLM path with a **real**
surviving `claude -p` worker. The first claude candidate is forced (injected 429) to trigger a real
failover; the next candidate edits a file for real and reaches `AWAITING_APPROVAL`. Validation/review are
faked (approve) so the test isolates the implementer failover chain.

- Skipped by default (verified: `npx vitest run tests/host-gated/worker-multiprovider.test.ts` → 1 skipped, no ERROR).
- Enable with `AISUP_TEST_MULTIPROVIDER=1`. Requires a live `~/.aisup/config.yaml` with ≥1 enabled
  account, the `claude` CLI on PATH, and (for the cross-LLM leg) `CODEX_HOME` + a configured codex adapter.
- Run: `AISUP_TEST_MULTIPROVIDER=1 npx vitest run tests/host-gated/worker-multiprovider.test.ts`.
- Asserts the journal shows `worker.candidate_failed` → `worker.failover`, terminal status
  `AWAITING_APPROVAL`, and a non-empty `changed_files` from the surviving real run.

### Manual real-run procedure (full daemon + Slack evidence)

1. Configure `roles.implementer: [claude (2+ accounts), codex]` in `~/.aisup/config.yaml`; set a small
   codex `budget` to exercise the metered cross-LLM leg. Restart the daemon:
   `source ~/.aisup/secrets.env && node dist/daemon/index.js`. Health: `curl http://127.0.0.1:7394/api/health`.
2. Inspect provider availability: `aisup worker providers` (shows each role's candidates with claude
   headroom % + basis and codex tokens-remaining vs budget).
3. Create a `/private/tmp` scratch git repo (init + one commit). Dispatch a bounded task:
   `node dist/cli/index.js worker dispatch --task-type implement --prompt "<bounded task>" --workspace <scratch>`.
4. Force a failover: drive the first claude account past its ledger headroom (or lower the codex budget for
   the cross-LLM leg). Re-dispatch.
5. Evidence to capture:
   - Journal (`/api/events` or the journal file): `worker.candidate_failed` → `worker.failover`
     (`cross_provider:true` for the codex↔claude leg) → `worker.completed` → `worker.awaiting_approval`.
   - Slack: the session channel receives the `:arrows_counterclockwise: Worker … failed over across
     providers` message on a **cross-LLM** failover only (account↔account within Claude is silent).
   - `aisup worker status <id>` shows `AWAITING_APPROVAL` with the surviving candidate's changed files.

### Validation log

- 2026-06-19: Full unit + integration suite green (`npx vitest run` → 668 passed, 6 skipped, 0 failures),
  typecheck clean. All four host-gated tests skip cleanly without their env flags (no ERROR). The
  operator-run real failover (Truths 1–3) is exercised via the gated test + manual procedure above.

### Post-review fixes (Codex adversarial review, 2026-06-19)

A Codex adversarial review flagged three high gaps against the DoD/intent; all fixed (suite → 675 passed):

1. **Pinned `--implementer claude` now resolves to a concrete account.** A pinned `claude` is "account
   auto-selected" (Task 1): `OrchestratorDeps.resolvePinnedClaude` (daemon-wired to the same scorer/selector)
   picks the best available account as a single candidate (no failover); `[]` when none available. A pinned
   adapter still runs unconditionally. (`orchestrator.ts resolveCandidates`, `daemon/index.ts`.)
2. **Default codex budget is applied.** `DEFAULT_CODEX_BUDGET = {tokens:3_000_000, period_hours:5}` +
   `resolveCodexBudget(roles)` in `config/defaults.ts`; the daemon meters codex against it by default so a
   codex-default task fails over on budget (Truth 2). **Behavior note:** a single-codex back-compat config
   is now metered — after ~3M tokens/5h with no failover target it terminates `all_candidates_exhausted`
   (the budget is tunable; raise it for high-volume single-codex). The deterministic integration smoke uses
   a fake adapter (no codex token output), so it is unaffected.
3. **Reviewer run-time failover.** `ReviewVerdict.run_failure` surfaces a failover-worthy reviewer failure
   (429/auth/timeout/unspawnable); `runReview` loops reviewer candidates — a capacity failure marks the
   reviewer unavailable, emits `worker.candidate_failed`/`worker.failover` (`role:'reviewer'`), and tries the
   next; a genuine approve/reject ends the loop (fail-closed preserved). (`review.ts`, `orchestrator.ts`.)
