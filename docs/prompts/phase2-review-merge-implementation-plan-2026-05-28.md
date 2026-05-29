# Codex Prompt: Merge Phase 2 Review Findings Into Implementation Plan

You are Codex working in `/Users/alecbrock/Projects/aisup`. Your task is to merge the complete review document into the Phase 2 implementation plan so the plan becomes the single actionable source of truth for future implementation.

This is a documentation/planning task only. Do not implement code fixes. Do not edit tests. Do not commit.

## Objective

Merge every relevant issue, fix, task correction, validation requirement, and important implementation detail from:

`docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`

into:

`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

The merged plan must be clear enough for a future LLM to implement without reading the review document. The review document remains evidence and history; the implementation plan must become the complete operational plan.

## Required Input Files

Read these files completely before editing anything:

1. `AGENTS.md`
2. `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
3. `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
4. `docs/plans/2026-04-29-aisup-supervisor-daemon.md`
5. `docs/plans/2026-05-07-phase1-alignment-scan.md`
6. `docs/handoff/handoff-2026-05-12T17-41-31.md`
7. `docs/prd/2026-04-29-ai-supervisor.md`

Read source files only as needed to understand why a review finding affects plan structure. Do not re-review the codebase from scratch unless the plan/review conflict requires source verification.

## Output Requirement

Edit only:

`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

Do not edit:

- `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
- source files
- tests
- package files
- generated artifacts

If you discover the plan cannot be safely merged without new source verification, stop and report the blocker instead of making a speculative merge.

## Non-Negotiable Merge Rules

- Do not paste the review document into the plan as an appendix and call it done.
- Convert review findings into plan-owned work: tasks, dependencies, file lists, config changes, event-contract changes, validation gates, and acceptance criteria.
- Merge both categories of review content:
  - Phase 1 post-implementation remediation fixes that must happen before Phase 2.
  - Phase 2 pre-implementation plan fixes that modify the Phase 2 task plan before work begins.
- Every finding ID in the review document must be accounted for in a traceability matrix inside the plan.
- Active findings must map to concrete plan work or a clear plan correction.
- Superseded, rejected, and informational findings must map to an explicit non-work disposition.
- If multiple findings require the same implementation change, consolidate the work once and map all relevant finding IDs to that one plan location.
- Keep one canonical event contract and one canonical state machine. Do not introduce competing event shapes, hidden status channels, or parallel state models.
- Keep session visibility, runner state, and daemon process lifetime separate.
- Preserve shell-free subprocess execution by default. Gate commands must use executable plus argument arrays unless the plan explicitly justifies and tests a shell boundary.
- Preserve host-gated test marker requirements: `requires_tmux`, `requires_slack`, and `requires_claude`.
- Do not include secrets, Slack tokens, Claude account paths, local transcripts, tmux captures, or `.claude/settings.local.json`.
- Do not commit.

## Expected Final Plan Shape

Use this structure unless the existing plan forces a cleaner equivalent.

### 1. Add A Review Merge Notice

Near the top of the plan, add a short note that this plan has been merged with the review document and now includes:

- Phase 1 remediation gates.
- Phase 2 plan corrections.
- A finding traceability matrix.

This notice should not be long. The plan must remain implementation-oriented.

### 2. Add A Phase 1 Remediation Gate Before Phase 2 Tasks

Before the Phase 2 implementation tasks, add a required gate for Phase 1 post-implementation fixes.

This section should:

- State that Phase 2 implementation must not begin until Phase 1 CRITICAL and HIGH remediation tasks are complete or explicitly deferred by the owner.
- Convert active Phase 1 findings into actionable remediation tasks.
- Keep Phase 1 work separate from Phase 2 work so future implementers do not confuse post-implementation fixes with new Phase 2 features.
- Avoid duplicating overlapping Phase 1 addendum and full-audit findings. If two finding IDs describe the same underlying fix, create one remediation task and map both IDs to it.

Recommended remediation task format:

```markdown
### Phase 1 Remediation R1: <title>

**Findings:** P1-FULL-001, P1-CR-001
**Severity:** CRITICAL
**Objective:** ...
**Files:** ...
**Implementation Requirements:** ...
**Tests:** ...
**Acceptance Criteria:** ...
```

### 3. Fold Phase 2 Findings Into Existing Tasks

For each active Phase 2 finding, update the relevant task directly:

- Add missing files to the task's file list.
- Correct wrong implementation assumptions.
- Add missing dependencies.
- Add missing config schema/defaults/loader work.
- Add missing event types and journal detail contracts.
- Add required tests and host markers.
- Add required validation commands.
- Remove or correct stale task language that would cause a future implementer to do the wrong thing.

Do not leave critical fixes only in prose outside the tasks. If a future implementer executes tasks top-to-bottom, they must naturally perform the corrected work.

### 4. Add Cross-Cutting Consolidation Tasks Only When Needed

Add new tasks only when existing tasks cannot cleanly own the work.

Likely candidates:

- Event contract consolidation: one task that owns `src/journal/types.ts` updates and event detail shape alignment.
- Config schema/defaults/loader consolidation: one task that owns new config sections across recovery, permissions, gates, and cost.
- Phase 1 remediation gate: separate from Phase 2 feature tasks.

Do not create broad catch-all tasks that future implementers can skip. If a cross-cutting task exists, it must have precise files, requirements, tests, and acceptance criteria.

### 5. Add A Finding Traceability Matrix

At the end of the plan, add a required traceability matrix with one row per finding ID.

Required columns:

```markdown
| Finding ID | Review Status | Plan Destination | Merge Disposition | Required Work |
|------------|---------------|------------------|-------------------|---------------|
```

Use these dispositions:

- `Merged`
- `Merged with <other finding ID>`
- `Superseded - no work`
- `Rejected - no work`
- `Informational - noted`

The traceability matrix is mandatory. It is the proof that no review item was dropped.

## Required Finding Inventory

The merged plan must account for every ID below.

### Phase 2 Review Findings

Critical:

- CR-001
- CR-002
- CR-003
- CR-004
- CR-005, superseded by CR-006, no active work as CR-005
- CR-006

High:

- HI-001
- HI-002
- HI-003
- HI-004
- HI-005
- HI-006
- HI-007
- HI-008
- HI-009
- HI-010
- HI-011
- HI-012
- HI-013
- HI-014

Medium:

- ME-001
- ME-002
- ME-003
- ME-004
- ME-005
- ME-006
- ME-007
- ME-008
- ME-009
- ME-010
- ME-011
- ME-012
- ME-013
- ME-014
- ME-015
- ME-016
- ME-017
- ME-018
- ME-019, rejected, no active work as ME-019
- ME-020
- ME-021
- ME-022
- ME-023
- ME-024

Low:

- LO-001
- LO-002
- LO-003
- LO-004
- LO-005
- LO-006
- LO-007
- LO-008

Informational:

- IN-001
- IN-002
- IN-003
- IN-004

### Phase 1 Compliance Addendum Findings

- P1-CR-001
- P1-CR-002
- P1-CR-003
- P1-HI-001

These overlap with the full Phase 1 audit. Map them to the same remediation tasks where appropriate.

### Full Phase 1 Compliance Audit Findings

- P1-FULL-001
- P1-FULL-002
- P1-FULL-003
- P1-FULL-004
- P1-FULL-005
- P1-FULL-006
- P1-FULL-007, rejected, no active work as P1-FULL-007
- P1-FULL-008
- P1-FULL-009
- P1-FULL-010
- P1-FULL-011
- P1-FULL-012
- P1-FULL-013
- P1-FULL-014
- P1-FULL-015
- P1-FULL-016

## Required Merge Treatment By Category

### Active Phase 1 Findings

Turn these into Phase 1 remediation tasks before Phase 2:

- Account scoring and eligibility not wired into daemon account selection.
- Pre-switch no-target EXHAUSTED path not persisted or journaled.
- Failed transcript migration can still launch target with `--resume`.
- Mid-switch rehydration remains manual for important switch transaction phases.
- Misleading `session.stop` journal event from idle tick.
- Automatic retry includes COOLDOWN accounts.
- `onSwitch` does not pass reason/current score to target selection.
- Canonical journal detail contract remains incomplete.
- Persisted EXHAUSTED sessions are not rehydrated for status or recovery.
- Online status/log/accounts observability uses stale or wrong sources.
- Optional Slack runtime edge contracts remain incomplete.
- Live recovery does not distinguish externally destroyed tmux sessions.
- Active-session telemetry binding accepts candidates without cwd/project identity.
- Same-account restart counter escalates late and never resets on successful restart.
- Alignment scan progress remains stale despite implementation.

Do not include P1-FULL-007 as active work. It is rejected.

### Active Phase 2 Critical/High Findings

These must be merged as blocking plan corrections:

- Remove or correct phantom work around already-existing pipe-pane restore and switch-tx recovery behavior.
- Fix gate trigger logic around `active_skill` transitions.
- Correct `onIdle` and gate trigger design so idle observation does not imply session stop.
- Re-arm EXHAUSTED polling from persisted state after daemon restart.
- Add missing files to task file lists, especially config defaults, failover types, daemon index, and server option boundaries.
- Add rehydration recovery callbacks or an equivalent deferred recovery boundary.
- Fix validation gate command config to use shell-free `command` plus `args`.
- Fix config validation so new sections are not silently dropped.
- Make cost aggregation use the journal reader and configured journal path.
- Account for active-session filtering in recovery loops.
- Export or otherwise handle circuit breaker state typing.
- Add missing Slack command dispatch cases and service option extensions.
- Put permission auto-grant keystroke integration in a daemon/tmux-aware boundary.
- Fix smoke test isolation and attach automation problems.

### Active Phase 2 Medium/Low Findings

Merge these into the relevant tasks as clarity, correctness, test, or acceptance criteria changes. They are not optional if they describe active review findings.

Pay special attention to:

- `aisup log --type cost.snapshot` must either be implemented or removed from verification.
- Offline cost mode must use `config.journal.path`, not a hardcoded `~/.aisup/journal.jsonl`.
- EXHAUSTED max retry config and `recovery.exhausted_max_retries` event ownership must be explicit.
- Permission glob matching needs a direct dependency or a documented local matcher.
- `!gate` must either be implemented by a task or removed from the file structure.
- Remote-control reconnect scope must be explicitly included or deferred with rationale.
- Event type union updates must be consolidated so event contract drift does not grow.

### Superseded, Rejected, And Informational Findings

Do not turn these into implementation work:

- CR-005: superseded by CR-006.
- ME-019: rejected.
- P1-FULL-007: rejected.

Informational findings should be noted in traceability and, where useful, reflected as future considerations or non-blocking notes. Do not let informational notes block implementation.

## Merge Workflow

Follow this order.

### 1. Establish Repository State

Run:

```bash
git status --short
git rev-parse --short HEAD
```

Record whether the plan or review are untracked/modified. Do not revert unrelated user changes.

### 2. Read And Extract

Read the full implementation plan and review document. Build a scratch finding inventory from the review before editing the plan.

For each finding, capture:

- ID
- active/superseded/rejected/info status
- affected task or Phase 1 remediation area
- exact fix required
- required files
- tests or validation required
- whether it overlaps with another finding

### 3. Design The Merge Map

Before editing, decide:

- Which Phase 1 remediation tasks are needed.
- Which existing Phase 2 tasks receive which findings.
- Whether cross-cutting consolidation tasks are needed.
- How the traceability matrix will map every finding ID.

Prefer preserving existing task numbering where possible. If inserting work before Task 0, use a separate "Phase 1 Remediation Gate" section rather than renumbering every Phase 2 task.

### 4. Edit The Plan

Use precise edits. Keep the plan concise but complete.

For each task touched:

- Update dependencies.
- Update files.
- Update implementation requirements.
- Update tests.
- Update acceptance criteria.
- Update validation commands.

Avoid vague text like "address review findings." The plan must say exactly what to do.

### 5. Add Traceability Matrix

Add the matrix after the implementation tasks or near the end of the plan.

Every ID in the "Required Finding Inventory" above must appear exactly once as a primary row. If a finding is merged with another, its row should point to the shared plan destination.

### 6. Run Completeness Checks

After editing, run searches similar to:

```bash
rg -n "CR-001|CR-002|CR-003|CR-004|CR-005|CR-006" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "HI-00[1-9]|HI-01[0-4]" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "ME-00[1-9]|ME-01[0-9]|ME-02[0-4]" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "LO-00[1-8]|IN-00[1-4]" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "P1-CR-00[1-3]|P1-HI-001|P1-FULL-00[1-9]|P1-FULL-01[0-6]" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
```

Also search for stale or risky phrases that should have been corrected:

```bash
rg -n "shell command|shell commands|shell: true|npx tsc --noEmit|~/.aisup/journal.jsonl|EXHAUSTED state NOT persisted|CLAUDE_CONFIG_DIR=''" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
```

If any stale phrase remains intentionally, make sure nearby plan text explains the corrected meaning.

### 7. Final Self-Audit

Before reporting completion, answer these questions from the final plan:

- Can a future implementer complete all Phase 1 CRITICAL/HIGH remediation before Phase 2 without reading the review?
- Can a future implementer complete all Phase 2 corrected tasks without reading the review?
- Does every finding ID map to one plan destination?
- Are rejected/superseded findings clearly marked as no-work?
- Are Phase 1 remediation tasks separate from Phase 2 feature tasks?
- Are event-contract changes centralized?
- Are config schema/defaults/loader changes centralized or repeated clearly in every affected task?
- Are shell-free subprocess rules explicit for validation gates?
- Are host-gated integration tests explicitly marked?
- Are configured paths used instead of hardcoded paths?

If any answer is no, keep editing.

## Final Response Requirements

When done, report:

- The plan file edited.
- The merge structure used.
- Counts of findings mapped.
- Any findings intentionally marked superseded, rejected, or informational.
- Verification/search commands run.
- Any residual risks or unresolved owner decisions.

Do not claim implementation readiness if Phase 1 remediation or Phase 2 critical/high findings remain unresolved in the plan.
