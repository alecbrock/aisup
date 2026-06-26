# Implementation Plan Review: Worker Multi-Provider Failover — Closure & Real Validation

**Plan:** docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md
**Reviewed:** 2026-06-23
**Review Iterations:** 3 (initial + fix-application + re-review)
**Status:** ISSUES_FOUND

## Summary

| Severity | Current Findings | Description |
|---|---:|---|
| CRITICAL | 0 | Blocks implementation or causes incorrect behavior |
| HIGH | 0 | Significant gap likely to cause rework, failed validation, or integration confusion |
| MEDIUM | 1 | Quality issue that materially reduces clarity, coverage, or maintainability |
| LOW | 0 | Minor improvement |
| INFO | 1 | Observation or optional alternative |

**Total current findings:** 1 (+1 INFO)
**Recommendation:** FIX_AND_RE_REVIEW

**Re-review result:** The three prior findings (CR-001 journal isolation, HI-001 account-first determinism, LO-001 Task 12 down-scope) are all **genuinely resolved** — I re-verified each fix against the code, not just against the edited text. The unbiased fresh pass surfaced **one new MEDIUM** (ME-001) that the HI-001 fix made concrete rather than introduced: Task 5's three failover legs require mutually-exclusive account-availability (and codex-budget) states that a single loaded daemon config cannot satisfy, and the per-leg config/restart structure is unspecified. Bounded plan fix; re-review the Task 5 harness structure before implementing.

## Findings

### MEDIUM

#### ME-001: Task 5's three failover legs need contradictory account-availability (and codex-budget) states that one loaded daemon config cannot satisfy — the per-leg config / daemon-restart structure is unspecified

**Evidence:**
- **Account-first leg (Truth 1)** requires a **real authed Claude account available to win**: plan Truth 1 ("completes on the **next real Claude account**") and Task 5 step 6 ("real failover to a real authed account").
- **Cross-LLM leg (Truth 2a)** requires **all Claude accounts unavailable** so failover crosses to codex (`worker.failover {cross_provider:true}`); **budget-gate leg (Truth 2b)** also requires all-Claude-down.
- The per-dispatch `--implementer/--reviewer` override **pins a single candidate with NO failover**: `src/workers/orchestrator.ts:82` ("scorer-selected, single, **no failover**") and `:143-154` (an override "pins a single candidate (no failover)"). So a failover leg **cannot** be expressed per-dispatch — it must run through `config.roles` against the **global** account-availability state: `src/daemon/index.ts:205-207` builds candidates from `accountRegistry.getAll()` via `resolveCandidates(config.roles[role], …)`.
- A `claude` candidate expands to **all enabled accounts** (`src/providers/selector.ts:38-46`), and `validateRoles` requires **≥1 enabled account** whenever `claude` is listed (`src/config/loader.ts:300-302`). "All-claude-down" therefore means every enabled account must be **unavailable** (no-auth/cooldown/reactive) in the loaded config — which directly contradicts the account-first leg's need for an **available** real account in that **same** config.
- Codex availability is `tokens_used < cap` (`src/providers/codex-usage.ts:14,23`). Task 5's config has "a codex adapter … + a **tiny** `budget`" (plan step 1). Leg 2a (codex must **win**, edit a file, complete) needs codex **under** budget; leg 2b (exhausted) needs codex **over** budget. A single tiny budget supports 2b but makes 2a workable only if 2a is dispatched **before** its own ~39k-token run crosses the cap (per `defaults.ts:DEFAULT_CODEX_BUDGET` comment) — an ordering dependency the plan does not state.

**Issue:**
Task 5 describes **one** daemon under **one** `AISUP_HOME` config serving all three legs sequentially (step 1 writes a single config; step 3 starts one daemon; step 8 tears down "the daemon"). But the legs' preconditions conflict. A faithful implementer using the literal config (3 real accounts + no-auth-first + tiny codex budget) gets a working **account-first** leg, but: a cross-LLM dispatch is **won by a real account** (it is available) → **no** `cross_provider:true` event; and with claude available, codex is never reached → **no** `all_candidates_exhausted`. Two of the three Truth-2 DoD evidence bullets are unobtainable from the described config. (Note: Task 4, the host-gated test, is unaffected — each `it` builds its own orchestrator config and injects a 429, so it sidesteps the global-state constraint. The problem is specific to the live Task 5 harness driving a real daemon.)

**Impact:**
The cross-LLM and budget-gate DoD bullets (plan Task 5 DoD: `worker.failover {cross_provider:true}`; `worker.all_candidates_exhausted`) cannot be produced from the single config as written, forcing the implementer to redesign the harness mid-implementation. Worse failure mode: a "cross-LLM" dispatch silently won by a real Claude account looks like a successful run but emits no `cross_provider` event, so the leg can be mis-recorded as passing without proving the Truth.

**Optimal Fix:**
Specify Task 5 as running the legs under **separate per-leg configs / short daemon lifecycles** (the harness is a script that already owns the config under `AISUP_HOME` — stop, rewrite config, restart between legs, all within the same isolated `AISUP_HOME`):
- **Leg A (account-first / Truth 1):** `accounts = [no-auth (listed first), ≥1 real authed]`, default roles. Expect a real-account win with `candidate_failed→failover→completed`.
- **Leg B (cross-LLM / Truth 2a):** `accounts =` all no-auth claude entries; codex budget **ample** (enough for ≥1 run — e.g. the 3M default or ≥100k). Expect codex win + `cross_provider:true`.
- **Leg C (budget-gate / Truth 2b):** `accounts =` all no-auth claude; codex budget **already crossed** (tiny, e.g. `tokens:1`, OR run Leg C after Leg B has consumed the budget). Expect `all_candidates_exhausted` with no codex subprocess.
Add a per-leg preflight assertion that `aisup worker providers` reflects the intended availability before each dispatch (Leg A: ≥1 claude available; Legs B/C: all claude unavailable; Leg C: codex over budget).

**Why This Fix:**
Per-leg configs are the only way to satisfy the contradictory account/budget preconditions; per-dispatch pinning cannot substitute (it disables failover, so no `cross_provider` event is ever emitted). Restart-per-leg is cheap for a shell harness and keeps each leg's evidence unambiguous.

**Fix Validated:**
YES — verified: override-pins-no-failover (`orchestrator.ts:82,143-154`); global-account candidate construction (`daemon/index.ts:205-207`, `accounts/registry.ts:25-26`); claude-expansion + ≥1-enabled-account rule (`selector.ts:38-46`, `loader.ts:300-302`); codex `used < cap` budget gate (`codex-usage.ts:14,23`). [FIX UNVALIDATED] only for the live codex per-run token cost vs a "tiny" cap, which is an already-accepted live-spend assumption.

**Validation Command or Check:**
Per leg, after daemon start: `AISUP_HOME=<temp> node dist/cli/index.js worker providers` must show the intended availability (Legs B/C: all claude `unavailable`; Leg A: ≥1 claude available; Leg C: codex `budget_exhausted`), then assert the leg's terminal journal event.

**Test Changes:**
None — Task 4's host-gated matrix already isolates per-leg via its own orchestrator config and injected 429, so it is unaffected.

**Affected Tasks or Sections:**
Task 5 (Key Decisions steps 1 + 6; the cross-LLM and budget-gate DoD bullets), Goal Verification Truth 2.

---

### INFO

#### IN-002: AF-R007 audit-refresh note still reads "Task 12 is currently listed under Phase B" — stale after LO-001 moved it to Phase E

The historical Audit Refresh finding AF-R007 (plan body) describes Task 12 as "currently listed under 'Phase B — Stability & security (high)'." LO-001's fix moved Task 12 to Execution-Order Phase E and re-scoped its objective, so that descriptive clause is now stale. The "Plan-Review Fixes Applied (2026-06-23)" section already records the resolution, so this is cosmetic. Optional: append "(now moved to Phase E — see Plan-Review Fixes Applied)" to the AF-R007 clause for internal consistency. No action required.

## Resolved or Superseded Findings

#### CR-001 (was CRITICAL): journal not relocated by `AISUP_HOME` — **RESOLVED**

The plan now directs the fix at the correct seam and mandates the test the old DoD grep can't substitute for:
- Task 1 Files (plan line 95) and Key Decisions (line 102) instruct `loader.ts` to resolve the config-driven `journal.path` default through `aisupHome()` (two valid options given: substitute the default when `raw` does not override `journal.path` in `validateConfig`, or remap a leading `~/.aisup` segment in `expandPath`).
- Task 1 DoD (lines 110-111) adds a **dedicated** "journal resolves under `AISUP_HOME`" assertion and explicitly notes the grep returns false-green.
- Task 5 (lines 197, 198, 204) sets `journal.path` explicitly under `AISUP_HOME` as belt-and-suspenders and asserts the real `~/.aisup/journal.jsonl` mtime+size is unchanged across the run.

Re-verified the fix is feasible against code: `validateConfig` receives `raw` (`loader.ts:370`) so it can detect a `journal.path` override and substitute `aisupHome()` for the default; `expandPath` (`loader.ts:29-37`) is the only tilde-expansion site so the alternative remap is localized. The journal default (`defaults.ts:101`) and sole daemon consumption (`daemon/index.ts:103,367`) are unchanged and compatible with both options. **Genuinely resolved.**

#### HI-001 (was HIGH): account-first leg order-nondeterministic + bad fallback — **RESOLVED**

- Task 5 now sets `statusline.directory` to an isolated path under `AISUP_HOME` (line 197) so the daemon never ingests the operator's shared `/tmp/pilot-failover` telemetry, lists the no-auth failing account **first** (line 197), adds a preflight asserting **all accounts report `unknown` basis** before dispatch (line 196), and corrects the fallback to "seed highest-headroom isolated telemetry" rather than a reactive-unavailable mark (line 199). Assumptions/Risks updated to match.

Re-verified the determinism claim against code (this is the key check): `AccountRegistry` preserves **config order** (Map insertion order from `config.accounts`, no priority sort — `registry.ts:8-22, 25-26`); `resolveCandidates` never references priority and uses a **stable** sort (`selector.ts:53`); an account with no ledger telemetry returns **unknown headroom** (`claude-usage.ts:44-48`). So with an isolated/empty ledger, all accounts tie at unknown headroom and the stable sort preserves config order → the **first-listed no-auth account is tried first → real `worker.candidate_failed`**. The corrected fallback is consistent with `selector.ts:43` (a dropped/unavailable candidate emits no event, so a reactive mark could not produce `candidate_failed`). **Genuinely resolved.**

#### LO-001 (was LOW): Task 12 stale wording / high-priority placement — **RESOLVED**

Task 12's objective is re-scoped to a LOW-priority confirm-coverage task (plan line 366); it is removed from Execution-Order Phase B (line 303) and added to Phase E (line 306); Progress Tracking is annotated (line 75). Re-verified the down-scope is correct against code: `workers/validation.ts:74` (`cwd:null`), `:20-26` (isolated `HOME`, no `process.env` spread), `:65` (fail-closed) confirm AF-R001/R002 are resolved in code as the refresh claimed. **Resolved** (residual cosmetic note → IN-002).

#### IN-001 (INFO): `loader.ts:487-488` real-`~/.claude*` placeholder mkdir — **UNCHANGED, no action**

Still informational: the placeholder branch is not hit by Task 5 (the harness writes the config first, so `existsSync(resolvedPath)` is true), and `.claude` dirs are correctly not relocated by `AISUP_HOME`. No change required.

## Review Methodology

**Files and docs read (re-review pass):** current edited plan regions (Task 1 Files/Key-Decisions/DoD lines 88-113; Task 5 Key-Decisions/DoD lines 196-211; Execution Order lines 303-306; Progress Tracking line 75; Risks/Assumptions/Runtime-Environment edits); `src/providers/selector.ts`, `src/providers/claude-usage.ts`, `src/providers/codex-usage.ts`, `src/accounts/registry.ts` (ordering), `src/workers/orchestrator.ts` (dispatch override / no-failover semantics), `src/daemon/index.ts` (candidate construction at 205-210), `src/config/loader.ts` (validateConfig/expandPath), `src/workers/validation.ts` (Task 12 down-scope). Carried forward from iteration 1: full plan, `defaults.ts`, `journal/writer.ts`, `pid.ts`, `statusline/store.ts`, codex-json + worker-harness symbols, referenced docs.

**Searches and commands run:** `git log -1` (HEAD still `2ab8440`, unchanged — prior code verification current); `git status` (plan + review untracked, no code changes); account-ordering and dispatch-override greps across `daemon/index.ts`, `accounts/registry.ts`, `cli/commands/worker.ts`, `workers/orchestrator.ts`, `daemon/server.ts`.

**External contracts checked:** none new; codex CLI write/JSON behavior and `claude -p` empty-config-dir behavior remain accepted live-spend assumptions recorded in the plan.

**Skipped checks, missing context, and residual risk:** Did not re-execute the test suite (read-only audit; HEAD unchanged from the plan's reported `675 pass / 0 fail / 7 skip`). The live-run behaviors (codex per-run token cost vs a tiny cap; `claude -p` auth-fail-vs-hang) are inherently unverifiable without spending real quota and are flagged as assumptions. ME-001's per-leg-config fix is validated against the selection/budget code paths but its live execution will only be proven when Task 5 runs during `spec-verify`. The ~30 low-severity `[agent-reported]` items remain triaged-at-implementation per the plan's own disposition and were not re-derived.
