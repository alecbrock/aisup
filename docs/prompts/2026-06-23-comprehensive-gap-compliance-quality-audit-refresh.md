# Comprehensive Gap / Compliance / Quality Audit Refresh — aisup "road to 100%"

## Your mission

You are auditing the **aisup** supervisor-daemon project to find **everything still standing between it and "100% done."** This is a deep, unbiased, multi-pass investigation across every implementation phase, the live codebase, the existing closure plan, and the full git history. You will produce a consolidated refresh of findings and **append only new, evidence-backed findings or corrections to the existing closure plan** so that one plan captures every remaining issue, bug, fix, missing feature, test, validation, and future-product idea worth preserving.

Work thoroughly. Breadth and rigor matter more than speed. Do not rush to a summary — the value is in the findings you surface that everyone else missed, and in correctly rejecting duplicate, stale, or unsupported findings.

**Primary emphasis for this refresh:** a prior audit pass has already populated the closure plan with many defect/compliance findings. Do not ignore Checks 1-3/5 — still catch any material new bug, security issue, stale finding, or compliance gap — but the highest-value output for this run is **Check 4: current feature inventory + thoughtful discovery of high-value user-facing/product features**. Spend enough time in the user's real workflows to find product opportunities that a normal code audit would miss.

**This is a read-only audit refresh.** Do NOT modify production code, do NOT run git write commands, do NOT change behavior. Your only writes are: (1) appending a refresh section and any new tasks/deferred ideas to the closure plan named below, and (2) optional scratch notes. Read the plans, read the code, run read-only verification commands, and report.

---

## What aisup is (orient first)

aisup is a standalone TypeScript/Node (ESM) **supervisor daemon** that babysits Claude Code sessions: per-account usage tracking, automatic failover across Claude accounts (and, in Part B, across LLM providers for *workers*), Slack control plane, permission brokering, validation gates, cost tracking, and a multi-LLM **worker** orchestrator (dispatch a bounded task to an LLM worker in an isolated git worktree, cross-model review, human-approved merge). ~11,400 LOC across 20 `src/` subsystems.

The product was built in phases (Phase 1 → 2 → 3 → usage-ledger → hooks → Part B multi-provider worker failover). **Part B is the most recent feature and is marked VERIFIED** (commit `2ab8440`). A **closure plan** (the audit target below) is currently drafted but unapproved; it covers the live-validation gap, several tech-debt items already known, and at least one prior audit section. Your job is to find what *else* remains — across ALL phases, not just Part B — without duplicating what the closure plan already captures.

---

## The audit target (where your findings go)

**Append all new findings/corrections to:** `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md`

- **The target plan is no longer assumed to have only 5 tasks.** Before any audit work, read it fully and build a baseline inventory of:
  - header status / approval / worktree / type
  - all existing `## Audit Findings (...)` sections
  - every existing finding ID and severity/category
  - every existing implementation task number and title
  - every existing progress-tracking line
  - every deferred idea / out-of-scope / accepted-deviation note
- Do NOT delete, renumber, or silently rewrite existing findings/tasks.
- If you find a duplicate, stale finding, false positive, or wording problem in the existing closure plan, append it under the refresh section as a **correction note** with evidence. Do not mutate old history unless the correction is required for the plan to remain executable, and even then keep the edit minimal and explicitly documented.
- Add a new top-level section `## Audit Refresh Findings (YYYY-MM-DD)` listing only **new supported findings**, **corrections to prior findings**, and the orchestration-only workflow-mode evaluation requested below.
- Promote every newly actionable defect/gap finding into a new task appended to `## Implementation Tasks`, titled `### Task N: [REFRESH] <title>` (continue after the highest existing task number), and add a matching `[ ] Task N: [REFRESH] ...` line to `## Progress Tracking`.
- Pure enhancements, strategic product ideas, and the orchestration-only workflow-mode proposal should normally go under `## Deferred Ideas` or a new `## Future Product Ideas (YYYY-MM-DD)` section unless you can prove they must be part of the current closure scope.
- Keep the plan `Status: PENDING` / `Approved: No` unless it already says otherwise. This audit refresh should not approve the plan.

---

## Resources — READ THESE

### Implementation plans (all phases — read every one, in order)
- `docs/plans/2026-04-29-aisup-supervisor-daemon.md` — original/master daemon plan
- `docs/plans/2026-05-06-phase1-review-completion.md`
- `docs/plans/2026-05-07-phase1-alignment-scan.md`
- `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` — Phase 2 (recovery, cost, permissions, gates)
- `docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md` — Phase 3 (worker orchestrator, Feature G + H₂)
- `docs/plans/2026-06-17-aisup-full-system-validation.md` — full-system validation log + Part B design (DRAFT; lots of PASS/GAP/FINDING rows — mine it)
- `docs/plans/2026-06-19-aisup-worker-multi-provider-failover.md` — Part B (VERIFIED) — has Goal Verification Truths, Risks, Deviations, and a post-review-fixes log
- `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md` — **the audit target** (read it first and use it as the dedupe baseline)

### Product requirements (source of product intent — compliance baseline)
- `docs/prd/2026-04-29-ai-supervisor.md`

### Reviews (prior plan + implementation reviews — mine for already-noted risks/deferrals)
- `docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md`
- `docs/reviews/2026-05-06-phase1-full-implementation-review.md`
- `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
- `docs/reviews/2026-05-28-merged-phase2-plan-merge-audit.md`
- `docs/reviews/2026-05-28-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md`
- `docs/reviews/2026-05-29-plan-review-2026-05-11-phase2-aisup-supervisor-daemon.md`
- `docs/reviews/2026-06-02-phase2-spec-verify-findings.md`
- `docs/reviews/2026-06-02-plan-review-phase3-multi-llm-worker-orchestration.md`
- `docs/reviews/2026-06-16-plan-review-phase3-multi-llm-worker-orchestration.md`

### Handoffs (session-to-session state — often record deferrals/blockers)
- `docs/handoff/handoff-2026-05-06T12-51-04.md`
- `docs/handoff/handoff-2026-05-12T17-41-31.md`
- `docs/handoff/handoff-2026-06-01T14-05-21.md`
- `docs/handoff/handoff-2026-06-01T15-40-17.md`
- `docs/handoff/handoff-2026-06-01T17-21-58.md`
- `docs/handoff/handoff-2026-06-01T21-04-46.md`
- `docs/handoff/handoff-2026-06-16T14-12-08.md`
- `docs/handoff/handoff-2026-06-18T11-56-33.md`
- `docs/handoff/handoff-2026-06-19T11-46-26.md`
- `docs/handoff/handoff-2026-06-19T14-13-19.md`

### Other context
- `docs/runbook.md` — operator runbook (cross-check against actual CLI/config/behavior for doc drift)
- `docs/SETUP_CONTEXT.md`
- `tests/integration/WORKER_HOST_GATES.md` — worker host-gated test tiers (note the placeholder tiers)
- `CLAUDE.md`, `AGENTS.md` — project engineering rules (compliance baseline for code conventions)
- `README.md`

### Codebase surface (20 `src/` subsystems — audit all)
`accounts` · `cli` · `config` · `cost` · `daemon` · `failover` · `gates` · `hooks` · `journal` · `permissions` · `providers` · `recovery` · `runner` · `session` · `skills` · `slack` · `statusline` · `util` · `workers`
Mirror test dirs under `tests/` (plus `tests/integration`, `tests/host-gated`, `tests/fixtures`).

### Non-file resources you MUST also pull from
- **Git history** — `git log --oneline` (walk every phase commit: `b7379b4` Phase1 → `da82bd3` Phase2 → `46eb76f` Phase3 → `e0e5385` ledger → `ab4e313` hooks → `2ab8440` Part B). Use `git show <sha>`, `git log -p -- <path>`, and `git log --follow` to see how a file/decision evolved, what was reverted, and what a commit message promised vs. delivered. `git blame` to find code that drifted from its plan.
- **Current codebase state** — the working tree is the truth; the plans are claims. When a plan says "X is done," open the code and confirm X is actually wired, reachable, and correct.
- **Current target-plan state** — the closure plan is also live state. Treat prior audit sections as audit history, not proof. Re-check high-risk prior findings before carrying them forward.
- **Live verification** — run `npm run typecheck`, `npm run build`, and `npx vitest run` (the suite is expected to be roughly ~675 passing, 7 skipped, but do not trust this count; record the actual current result). Inspect skips and whether they hide unproven behavior. Note: there is **no eslint config** in this repo — do not claim "lint clean"; rely on typecheck + tests.
- **Code-intelligence tools** (if available in your session): `codegraph_context`/`codegraph_explore`/`codegraph_callers`/`codegraph_impact` for structure and blast radius; `semble search`/`find_related` for intent and mutation sites; `grep`/`Read` for completeness and exact strings. Start structural when runtime entry points are unknown, confirm with reads.

---

## Orchestration requirements for this refresh

This audit is too large for one flat pass. Use a **coordinator-led, phased workflow**. If your harness supports subagents/workflows, use them deliberately; if not, simulate the same phases serially.

### Required phases

0. **Context and baseline gate**
   - Run `~/.pilot/bin/pilot check-context --json` if available.
   - If the result says `CLEAR_NEEDED`, or your context is already overloaded, STOP and tell the user to restart a fresh session with this prompt. Do not begin a broad audit in a stale/overfull context.
   - Read the target closure plan first and create the baseline inventory described above.
1. **Intent/claims model**
   - Read the PRD, all phase plans, prior reviews, and handoffs.
   - Build a claims matrix: promised capability → current plan/finding/task coverage → code evidence needed.
2. **Git-history pass**
   - Walk the named phase commits and path histories for high-risk areas.
   - Look for promises made in commits or plans that are not true in the current tree.
3. **Verification pass**
   - Run typecheck/build/test as read-only verification.
   - Record actual skip counts and inspect every skip/host-gated placeholder that matters.
4. **Subsystem audit pass**
   - Cover all `src/` subsystems and mirrored tests.
   - Each subsystem investigator must return only evidence-backed findings and explicit duplicate checks against the target plan.
5. **User-perspective/product pass**
   - Map current CLI/Slack/config/daemon/journal/notification surface.
   - Treat this as the primary emphasis of the refresh: walk workflows as the user, search for adjacent product patterns/inspiration, and record pain points and product ideas separately from defects.
   - Do not propose features until you have mapped what aisup already has, so suggestions are non-duplicative and grounded.
6. **Orchestration-only workflow-mode evaluation**
   - Evaluate the product idea described in Check 6 below against the live codebase and existing aisup goals.
7. **Synthesis and re-verification**
   - The coordinator must independently re-open and re-verify every critical/high finding and every finding that would create a new implementation task.
   - Reject duplicates, stale claims, unsupported opinions, and findings already covered by existing tasks.
   - Append only the supported delta to the target plan.

### Model-selection guidance

- Use the strongest available model for coordination, final synthesis, high/critical re-verification, architecture/security judgment, and the orchestration-only workflow-mode evaluation.
- Use a standard capable model for subsystem audits, plan/code reconciliation, and git-history investigation.
- Use cheaper/faster models only for mechanical extraction (lists of commands, config fields, existing finding IDs, TODO scans), and require the coordinator to verify anything they report before it becomes a finding.
- Do not spawn one undifferentiated batch of agents with the same prompt. Assign clear phase/subsystem scopes and require each worker to report: files read, commands run, duplicate checks performed, supported findings, and rejected candidates.
- This is an audit refresh, not implementation. Subagents must be read-only except for approved scratch notes. Only the coordinator writes the target plan.

---

## The checks (perform ALL of these)

Treat the plans as **claims to verify**, not ground truth. Several phases recorded **accepted deviations / workarounds / RCA inserts** — those are fine *as decisions*, but you must (a) confirm each documented deviation was actually implemented and resolved **optimally** (not just patched), and (b) confirm it matches what the plan recorded for it. The goal of the compliance pass is not "did we follow the plan letter-for-letter" — it is "are there gaps, missing work, sub-optimal resolutions of known issues, or stale prior-audit claims that need correction."

### Check 1 — Tech-debt & deferral sweep
Find anything **noted-and-deferred, unimplemented, stubbed, or worked-around** that must be done for "done":
- Code markers: `TODO`, `FIXME`, `HACK`, `XXX`, "deferred", "for now", "not wired", "placeholder", "stub", "temporary", "revisit", "out of scope (but needed)".
- Host-gated / skipped tests that **never actually run** and therefore prove nothing (e.g. tiers that only `expect(env===1)`; `describe.skipIf` blocks; `it.skip`). Which real behaviors have no real-execution proof?
- "Open Questions", "Deferred Ideas", "Out of Scope", "Risks", "Assumptions", and "Not Verified" sections across ALL plans — which are still open?
- Handoff "pending work" / "blockers" / "next action" items that were never closed.
- Features the PRD specifies that the code does not implement (or only partially implements).
- Existing closure-plan findings/tasks that appear stale, duplicate, or unsupported after re-checking.

### Check 2 — Full compliance audit (plan ↔ code ↔ PRD, every phase)
For each phase plan AND the PRD, map every promised capability/feature/task to its implementation and verify it is present, wired, reachable, and behaviorally correct in the current tree:
- Walk each plan's task list / DoD / Goal-Verification truths. For each, find the code that satisfies it and confirm it actually does (read it; don't trust the checkbox).
- Flag **misalignments** (code diverges from the plan in a way that was NOT a documented/accepted deviation), **gaps** (promised but missing/partial), and **pending work** (started, not finished).
- For each **documented deviation / RCA / workaround**, verify it was implemented as recorded AND resolved optimally (no lingering symptom-patch where a root-cause fix was warranted; no fail-open left behind).
- Cross-phase consistency: does a later phase contradict or silently break an earlier decision? Is there dead/orphaned code from a superseded approach? Are there "ghost constraints" (limits locked in by an old phase that no longer apply)?
- Dedupe every candidate against current Tasks 1-N and prior audit findings before recording it.

### Check 3 — Unbiased code quality / architecture / design review
Independently review the actual architecture, design, features, and logic of every subsystem for problems the plans missed, got wrong, or never considered. Look for:
- **Correctness bugs** — logic errors, race conditions, off-by-one, wrong field/assertion, mishandled async, unbounded loops/retries, resource leaks, missing cancellation, state-machine holes.
- **Fail-open / silent-failure paths** — swallowed exceptions, `try/catch` returning a default that hides a real error, fallbacks that mask missing data, validation that can be bypassed.
- **Security** — subprocess spawning (command/arg injection), env allowlist leaks, secret redaction completeness, path traversal, worktree/boundary-audit bypasses, token handling, fail-open auth/permission paths. (This product spawns real CLIs and handles real auth/tokens — weigh this heavily.)
- **Architecture / design** — leaky abstractions, modules doing too much, duplicated logic that should be shared, injected-vs-hardcoded dependencies, testability smells, files over ~800 LOC that signal a split, inconsistent patterns across subsystems.
- **Performance / easy wins** — expensive work on hot paths (polling loops, request handlers, render/statusline) without caching/memoization, heavy imports with lighter alternatives, redundant recomputation when inputs are unchanged.
- **Test integrity** — tests that assert on mocks rather than behavior ("mocks that lie"), incomplete mocks hiding real coupling, critical paths with no real coverage, assertion correctness (would a one-character bug still pass?).
- **Observability / operability** — missing journal events for important transitions, gaps that would make a production incident hard to diagnose.

### Check 4 — User-perspective feature discovery (product & UX — this is NOT an ordinary "missing features" scan)

**This is the main focus of this refresh.** Prior audit work already surfaced many implementation defects. This pass must preserve the rigor of the other checks, but it should especially answer: "Given what aisup already does today, what features would most improve the real developer/operator experience?"

**Stop being an auditor and become the user.** The user is a developer/operator who runs aisup to babysit their Claude Code sessions (multi-account failover, Slack control, permission brokering, cost tracking) and to dispatch bounded coding tasks to LLM workers (worktree isolation → cross-model review → human-approved merge). Put yourself fully in their seat and **live their real workflows**, then identify features that would genuinely improve the experience and remove friction — not generic "nice-to-haves," but changes a real daily user of *this* product would actually feel.

**Method:**
1. **Map what exists first** (so every suggestion is grounded and non-duplicative): enumerate the actual current surface — every `aisup` CLI command + flag (`src/cli/`), every Slack command (`src/slack/`), every config knob (`src/config/schema.ts` + defaults), every daemon behavior, journal event, and notification. Write this current-capability map before proposing anything.
2. **Create a feature inventory, not just a list of gaps:** group current capabilities by workflow (`setup`, `session supervision`, `failover`, `permissions`, `cost/quota`, `workers`, `review/approval/merge`, `Slack`, `observability/debugging`, `config/admin`). For each group, state what exists, what is CLI-only, what is Slack-accessible, what is automatic, and what evidence proves it.
3. **Walk each real workflow end-to-end as the user** and find where it hurts:
   - **Onboarding / setup** — first run, account config, secrets, getting the daemon healthy. Where would a new user get stuck or confused?
   - **Daily session supervision** — starting/attaching sessions, watching usage, the failover experience (does the user know what happened and why?), recovering from a stuck/exhausted session.
   - **Worker loop** — dispatch → status → review → approve/deny → merge. Is the feedback loop tight? Can the user tell *why* a worker failed over, was rejected, or exhausted candidates? How painful is reviewing a worker's diff and verdict?
   - **Slack control plane** — what can / can't the user do from Slack? Where do they have to drop to the CLI when Slack would be far more convenient?
   - **Observability / debugging** — when something goes wrong at 2am, can the user diagnose it from what aisup surfaces? Is there a live status view, a clear health signal, useful alerts?
   - **Cost & quota awareness** — does the user have the visibility and control they'd want over spend and per-account/per-provider budgets?
4. **Search thoughtfully for more features:** use the current-state map, aisup's PRD, prior plans/reviews, adjacent LLM-agent/orchestration tools, Slack-ops bots, CI babysitters, human-in-the-loop approval systems, and your own product judgment to identify feature opportunities. Do not pad with generic ideas; every idea must tie to a concrete aisup workflow and evidence of current friction or absence.
5. **Find the major pain points** — the things that would frustrate, block, or surprise a real user; the controls they'd expect but don't have; the moments where aisup is silent when it should speak, or manual when it should automate.

**Idea categories to mine (extend freely):**
- **More user control** — manual overrides, pause/resume, pin/exclude an account or provider, force/cancel/retry a failover or worker, edit-in-flight, dry-run, confirmations tuning, per-task config overrides.
- **More Slack control** — richer commands, interactive approve/deny with diff preview, worker dispatch from Slack, live status, on-demand provider/cost readouts, notification verbosity controls, threaded per-session/per-worker updates.
- **More observability** — a live status dashboard or `aisup watch`, surfaced journal timelines, health/alerting, "why did X happen" explainers, per-provider/per-account availability at a glance, worker progress.
- **Workflow nice-to-haves** — sensible defaults, task templates/presets, dispatch batching/queues, history & re-run, undo/rollback of a merge, saved configs/profiles, better diff/review ergonomics.
- **Performance** — anything sluggish in the user's loop (CLI latency, polling cadence, statusline refresh, large-journal reads) worth optimizing.
- **More automation** — auto-triage, smart retry/backoff policies, scheduled or recurring worker tasks, auto-failover tuning, proactive quota/budget warnings, auto-cleanup.
- **Safety & guardrails** — clearer blast-radius limits, confirmations on destructive ops, better secret handling UX, safer defaults.
- **Integrations** — anything that would slot aisup into the user's real toolchain (GitHub PRs, CI, notifications beyond Slack, IDE).

**External inspiration (optional but encouraged):** pull from the internet / similar projects for ideas — LLM/agent orchestrators and supervisors, CI babysitters and bots, multi-account/quota managers, Slack-ops control bots, human-in-the-loop approval tools. Use them to spot capabilities aisup is missing — but **every suggestion must map to a concrete aisup workflow and the specific pain point it removes**, with the current-state evidence (`file:line`/command) showing the gap. No generic feature lists.

**For each idea, record:** the **pain point** (what hurts today, with evidence), the **proposed feature**, the **user value** (why it matters to a daily user), rough **effort** (S/M/L), and a **priority** (would a real user hit this constantly, occasionally, or rarely?). Keep these clearly separated from bug/defect findings.

**Feature triage requirements:**
- Rank the top 10 product/UX opportunities by user value, not implementation novelty.
- Mark each idea as `current closure`, `next PRD/spec`, `future`, or `reject`.
- For `current closure`, explain why it must be solved before "100%"; otherwise defer it instead of bloating the closure plan.
- Include at least one "do not build" or "reject" idea if you encounter an attractive but low-value or off-mission feature; this proves you filtered rather than collected.
- Explicitly call out when an idea is already covered by an existing command, config option, Slack command, task, or finding.

### Check 5 — Anything else that gets us to 100% (extend freely)
Add any check you judge valuable. At minimum also consider:
- **Documentation sync** — does `runbook.md` / `README.md` / `CLAUDE.md` / `--help` text match the real CLI commands, flags, config fields, and counts? Flag stale/wrong docs.
- **Config & schema integrity** — every config field validated, documented, and defaulted sanely; back-compat paths sound; no field that silently does nothing.
- **Error-path & edge-case coverage** — empty/zero/boundary inputs, concurrent dispatch, cancellation mid-flight, downstream-unavailable, expired-credential, exactly-at-limit.
- **Dependency hygiene** — unused deps, risky/heavy deps, version drift.

### Check 6 — Orchestration-only workflow-mode evaluation (product/architecture)

Evaluate this proposed feature idea, but **do not implement it** and **do not force it into the current closure plan unless the evidence clearly says it belongs there**:

> aisup could provide an "orchestration-only workflow mode" for complex Claude/Pilot work. In this mode, the lead agent/coordinator is allowed to decompose work, choose phases, assign models, dispatch read-only or isolated-write workers, enforce worktree/session isolation, collect evidence, run review gates, and synthesize results. The coordinator is not allowed to casually edit production files outside the declared workflow. This is meant to address the user pain point where Claude/Pilot may otherwise spawn an unstructured flat batch of agents, choose inappropriate models, avoid subagent worktree isolation, or refuse useful workflows because it assumes agents would edit the same files.

Review this idea against the live aisup codebase and current product direction:

- **Current-state map:** Which existing aisup pieces already support parts of this? Check worker orchestration, role/provider selection, worktree management, validation gates, approval/merge gates, daemon/session state, CLI/Slack surfaces, config schema/defaults, journal events, and runbook docs.
- **Gap map:** What is missing for a true orchestration-only mode? Consider workflow definitions, coordinator constraints, model-policy routing, phase/task graph persistence, worker read/write isolation, subagent status protocol, review gates, evidence contracts, cancellation/retry, and UI/Slack controls.
- **Feasibility:** Is this technically reasonable within aisup's current architecture? Identify the likely files/subsystems that would change and the biggest risks.
- **Product fit:** Does it fit aisup's core goal of supervising LLM coding sessions and bounded worker tasks, or is it a separate product? Be explicit.
- **User value / UX:** Would this materially improve the daily Claude/Pilot user experience? Which concrete workflow pain does it remove? Who benefits most?
- **Implementation approach sanity check:** Would the better approach be:
  1. extend the existing worker orchestrator,
  2. add a new workflow/coordinator subsystem,
  3. integrate with Pilot `$spec`/skills as an external wrapper first,
  4. or defer until the current closure plan is executed?
- **Recommendation:** one of `do now`, `plan next`, `prototype separately`, or `defer`, with the reason.

Output this as a clearly labeled **Orchestration-Only Workflow Mode Evaluation** section in the target plan. If it is not current-closure scope, put it under deferred/future product ideas and explicitly say it should get its own PRD/spec later.

---

## Output contract

In `docs/plans/2026-06-22-aisup-worker-failover-closure-validation.md`, append:

1. **`## Audit Refresh Findings (YYYY-MM-DD)`** — group findings under the six check headings. Each finding is one row/bullet with:
   - **ID**. Use the next unused ID already implied by the closure plan if obvious; otherwise use `AF-R###` for refresh findings. Never reuse an existing ID.
   - **Severity** (`critical` / `high` / `medium` / `low` / `enhancement`)
   - **Category** (bug / security / compliance-gap / tech-debt / perf / test-integrity / docs / architecture / missing-feature / product-evaluation / correction)
   - **Evidence** — exact `file:line` (and/or commit sha / command output) that proves it. No claim without evidence.
   - **Duplicate check** — name the existing task/finding it overlaps with, or say `not covered`.
   - **Why it matters** — one line.
   - **Proposed resolution** — concrete fix/approach, "defer to PRD/spec", or "investigate" if genuinely uncertain.
   - **Accepted-deviation?** — if this corresponds to a documented deviation, say so and state whether it was resolved optimally (the finding then becomes "validate/optimize," not "missing").
2. **New tasks** — promote every newly actionable defect/gap into `### Task N: [REFRESH] <title>` under `## Implementation Tasks` (continue after the highest existing task), each with the standard four bold fields (`**Objective:**`, `**Files:**`, `**Key Decisions / Notes:**`, `**Definition of Done:**`), and a matching `[ ] Task N: [REFRESH] ...` line in `## Progress Tracking`.
3. **Corrections** — if a prior finding/task is stale, duplicated, false-positive, or under-specified, add a small correction note with evidence. Do not silently rewrite old audit history.
4. **Orchestration-only workflow mode evaluation** — include the Check 6 analysis as a product/architecture evaluation, normally under future/deferred ideas unless it is clearly current-closure scope.
5. **Feature discovery report** — include the current feature inventory, top 10 ranked product/UX opportunities, rejected/duplicate ideas, and the recommended next PRD/spec candidates.
6. **Coverage report** — a short note stating which phases/subsystems you audited, which subagents/phases were used, and any areas you could not fully cover (with the reason), so the gap in the audit itself is visible.

**Dedupe:** before adding a finding, check it is not already covered by existing closure-plan tasks, existing audit findings, accepted deviations, or out-of-scope sections. Reference the existing task/section instead of duplicating.

**Triage honesty:** distinguish a real defect (with evidence) from a style opinion or product idea. Rank by severity. Do not pad with trivia; do not silently drop a real edge case because it was "probably fine."

---

## Execution strategy (be exhaustive)

- This is large. Decompose by **phase** and by **subsystem** and cover them systematically. You may fan out parallel read-only investigators per subsystem/phase if your harness supports it, then synthesize — but every finding must carry `file:line` evidence you can stand behind.
- Recommended order: (0) context/baseline gate and target-plan inventory; (1) read the PRD + all plans + reviews + handoffs to build the intent/claims model; (2) walk git history to see what actually shipped vs. promised; (3) run typecheck/build/test to ground the current state; (4) subsystem-by-subsystem code read for Checks 1–3 + 5; (5) the Check 4 product/UX pass — map the current surface, then walk the workflows as the user; (6) Check 6 orchestration-only workflow-mode evaluation; (7) synthesize, dedupe, re-verify critical/highs, and write only the delta into the closure plan.
- A finding that the **plans themselves are wrong** (an over-claimed truth, an unreachable design, a contradictory decision) is one of the highest-value outputs — surface those explicitly. (Example already found: under the locked account-first selector, codex is always tried after every available Claude account, so a "codex→Claude failover" is structurally unreachable — the kind of plan-vs-reality gap to hunt for.)
- A finding that a **prior audit finding is wrong** is also valuable. Record it as a correction with evidence; do not preserve bad findings out of inertia.

## Definition of done for this audit refresh

- The target closure plan has been read first and inventoried; final output clearly states the highest existing task number and existing audit/finding section(s) it deduped against.
- Every phase plan, the PRD, all reviews, and all handoffs have been read and reconciled against the current code.
- Git history walked for the phase commits; current tree verified to build, typecheck, and pass tests (with the skip set understood and the actual current counts recorded).
- All six checks performed across all 20 subsystems; coverage report states any gaps.
- Check 4 is treated as the main value of the refresh and includes a written current-capability map, workflow-grouped feature inventory, top 10 ranked product/UX opportunities, rejected/duplicate ideas, and user-perspective feature ideas tied to concrete workflow pain points with evidence.
- Check 6 includes a concrete recommendation on orchestration-only workflow mode: feasibility, product fit, user value, implementation approach, and whether it should be current closure scope or a future PRD/spec.
- New findings appended to the closure plan with IDs, severity, evidence, duplicate checks, and proposed resolutions; newly actionable defects/gaps promoted to `[REFRESH]` tasks; the plan remains unapproved unless the user explicitly says otherwise.
- A crisp final summary to the user: total new findings by severity/category, corrections to prior findings, the top 5 highest-impact remaining defects/gaps, the top 5 highest-value user-experience/product ideas (including orchestration-only mode if applicable), and the single biggest risk to "100%."
