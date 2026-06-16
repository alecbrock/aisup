# Claude Pilot-Shell `/spec` Prompt: Phase 3 Multi-LLM Worker Orchestration

You are Claude running in Pilot Shell in `/Users/alecbrock/Projects/aisup`.

Start a new `/spec` feature-planning session for **Phase 3: Multi-LLM Worker Orchestration**. Do **not** implement yet. Your job is to produce an implementation-ready Phase 3 plan that is complete enough for later `/spec` implementation and verification with no hidden gaps.

## Current Project State

Phase 1, Phase 1 remediation, Phase 2, and Phase 2 remediation are complete.

Authoritative current state:

- `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md` is `Status: VERIFIED`, `Iterations: 5`.
- `docs/reviews/2026-06-02-phase2-spec-verify-findings.md` has a newest **Round 3 — CLEAN** compliance audit with zero open issues.
- Phase 2 explicitly deferred:
  - Worker gate engine for multi-LLM workers.
  - Multi-LLM worker orchestration.
  - Remote-control reconnect logic pending investigation.
  - Phase 4 dashboard/ntfy/enhanced Slack features.

Treat the current working tree and current files as authoritative. Do not rely on older handoff claims when they conflict with the verified Phase 2 plan and latest review.

## Objective

Create a new Phase 3 implementation plan for the PRD's approved Phase 3 scope:

- Multi-LLM worker orchestration: Codex CLI, Gemini CLI, and local LLM adapters.
- Task contract: input artifact -> isolated git worktree -> output artifacts.
- Cross-model review: reviewer model must differ from implementer model when possible.
- Merge gate: user approval required before any merge, with validation gates run on worker output.
- Routing heuristic: configurable task-type -> preferred-model mapping.
- Worker validation gate engine (`H2`) that gates worker output before merge.

The plan must make Phase 3 implementable without requiring the implementer to reread the PRD, handoffs, or prior reviews to discover critical details.

## Required Source Files To Read Before Planning

Read these files first, in this order:

1. `AGENTS.md`
2. `docs/prd/2026-04-29-ai-supervisor.md`
3. `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
4. `docs/reviews/2026-06-02-phase2-spec-verify-findings.md`
5. `docs/handoff/handoff-2026-06-01T21-04-46.md`
6. `docs/SETUP_CONTEXT.md`
7. `docs/runbook.md`
8. `package.json`

Then inspect the current implementation using targeted search and file reads. At minimum, identify existing patterns in:

- `src/config/`
- `src/cli/`
- `src/daemon/`
- `src/gates/`
- `src/journal/`
- `src/session/`
- tests under `tests/config/`, `tests/cli/`, `tests/daemon/`, `tests/gates/`, and any integration-test conventions.

Use CodeGraph/Semble only where they answer the next planning question. For named files and docs, direct reads/search are enough.

## PRD Reconciliation Requirement

Before writing the Phase 3 plan, audit `docs/prd/2026-04-29-ai-supervisor.md` for stale Phase 1/Phase 2 status and Phase 3 ambiguity.

The PRD currently says Phase 2 is "in progress" in several places even though Phase 2 is verified. If the PRD still contains stale status, update it as a small planning prerequisite or make a first Phase 3 task that does so before code work. Do not let stale PRD language become a source of truth for implementation.

The PRD Phase 3 acceptance criteria that must be preserved are:

1. Codex worker completes a bounded task in an isolated git worktree.
2. Gemini worker completes a bounded task in an isolated git worktree.
3. Cross-model review catches an intentionally seeded bug.
4. Worker cannot write outside its allowed workspace.
5. Failed validation gate blocks merge.
6. User approval is required for every merge.
7. Approved patch applies cleanly to the main workspace.

If any Phase 3 requirement is underspecified, make the plan resolve it explicitly rather than leaving it as generic "worker orchestration" prose.

## Non-Goals And Boundaries

Do not include these in Phase 3 unless a source document proves they are required now:

- Mobile dashboard, remote dashboard token auth, ntfy fallback, rich Slack formatting, Slack thread-per-tool-call. These are Phase 4.
- Proxy-level model routing or Bifrost-style API routing. The PRD explicitly says this is complementary, not a supervisor feature.
- Multiple simultaneous lead sessions. Workers may exist, but the primary user session remains one lead session at a time.
- Launchd auto-start.
- Windows/Linux support.
- Remote-control reconnect after account switches; keep it deferred unless the plan first includes an investigation task and decision gate.
- Auto-merge or auto-approval. User approval is mandatory for every merge.
- Direct git writes without explicit user approval. Planning and implementation may edit files; git `add`/`commit`/`push` remain user-authorized only.

## Required Plan Output

Create a new plan under `docs/plans/` using the project naming convention, for example:

`docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md`

Use this header shape:

```markdown
# Phase 3: Multi-LLM Worker Orchestration Implementation Plan

Created: 2026-06-02
Author: alec.m.brock@gmail.com
Status: PENDING
Approved: No
Iterations: 0
Worktree: No
Type: Feature
```

If `/spec` asks about worktree isolation, recommend `Worktree: No` for this plan unless the user explicitly wants a separate planning worktree. Phase 3 itself must still implement isolated worker worktrees.

Register the plan after creating or updating its header:

```bash
~/.pilot/bin/pilot register-plan "docs/plans/2026-06-02-phase3-multi-llm-worker-orchestration.md" "PENDING" 2>/dev/null || true
```

## Required Plan Shape

The plan must contain, at minimum:

### 1. Source-Of-Truth And Status Reconciliation

- State that Phase 1 and Phase 2 are verified prerequisites.
- Cite the verified Phase 2 plan and Round 3 clean review.
- List PRD status updates needed before or during Phase 3.
- List explicit non-goals and deferred Phase 4 items.

### 2. Phase 3 Architecture

Define the worker system in concrete terms:

- Worker lifecycle state machine.
- Worker task contract schema.
- Worker adapter interface.
- Worktree creation, cleanup, and isolation rules.
- Output artifact contract.
- Cross-model review contract.
- Merge gate contract.
- Validation gate integration contract.
- Event journal additions.
- CLI/API/Slack surfaces, if any.
- Failure modes and recovery behavior.

Use one canonical event contract and one canonical state machine. Do not introduce hidden worker status channels or competing task formats.

### 3. Config Contract

Specify exact config keys, defaults, and validation rules. Include at least:

- Worker orchestration enabled/disabled flag.
- Worker adapter definitions for Codex, Gemini, and local LLM.
- Command/args/env handling for each adapter.
- Routing map from task type to preferred implementer/reviewer model.
- Per-worker workspace root and worktree naming.
- Allowed workspace boundaries.
- Gate commands as executable + argument arrays.
- Review policy requiring reviewer != implementer when possible.
- Merge policy requiring user approval.
- Cleanup/retention policy for worktrees and artifacts.

Do not invent local secrets, tokens, account paths, model names, or provider-specific commands unless verified in repo/local config or marked as user-provided placeholders.

### 4. Task Breakdown

Break the plan into implementation tasks with dependencies. Each task must have:

- Objective.
- Files to create/modify.
- Implementation requirements.
- Tests.
- Acceptance criteria.
- Validation commands.

At minimum, include tasks for:

1. PRD/status reconciliation for Phase 3 source-of-truth cleanup.
2. Worker config schema/defaults/loader validation.
3. Worker task contract and artifact model.
4. Worker adapter interface plus Codex adapter.
5. Gemini adapter.
6. Local LLM adapter or stubbed local adapter with a clear executable contract.
7. Worktree isolation and workspace-boundary enforcement.
8. Worker dispatcher and routing heuristic.
9. Worker validation gate engine (`H2`) using the existing supervisor gate patterns where appropriate.
10. Cross-model review flow with reviewer != implementer policy.
11. Merge gate requiring user approval and clean patch application.
12. CLI/API surfaces for dispatch/status/review/approve/merge.
13. Slack notification/control surfaces only if they are genuinely required for Phase 3; otherwise defer to a later optional task.
14. Integration/e2e smoke tests, including Codex/Gemini/local host gates.
15. Documentation/runbook updates.

### 5. Validation Strategy

The plan must define exact validation gates:

- Unit tests for pure contract parsing, routing, adapter command construction, event emission, and policy decisions.
- Integration tests for worktree lifecycle and workspace-boundary enforcement.
- Host-gated integration tests for real Codex, Gemini, and local LLM workers. Use explicit markers/env gates and skip by default.
- A deterministic seeded-bug test proving cross-model review catches a real defect.
- A failed-gate test proving merge is blocked.
- A user-approval test proving merge cannot happen without approval.
- A patch-apply test proving an approved worker output applies cleanly to the main workspace.
- Full suite/typecheck/build commands.

For any UI-visible Phase 3 surface, include browser automation requirements from `AGENTS.md`. If no UI is added, state "no browser E2E required; API/CLI profile only" and still include program-execution checks.

### 6. Security And Isolation Requirements

Make these explicit and testable:

- Workers cannot write outside the assigned worktree/workspace.
- Worker subprocesses use shell-free execution by default.
- Environment variables passed to workers are allowlisted.
- Secrets, Slack tokens, Claude account paths, session transcripts, tmux captures, and `.claude/settings.local.json` are never committed or included in artifacts.
- Worker output artifacts are sanitized before review/merge where needed.
- Validation and merge operations cannot run destructive git commands automatically.

### 7. Event And Observability Contract

List exact journal event types and required detail fields for worker lifecycle, dispatch, completion, review, gate pass/fail, approval, merge success/failure, cleanup, and security denials.

Preserve the existing journal style and avoid duplicate event names for the same concept.

### 8. Traceability Matrix

Add a matrix proving every Phase 3 PRD acceptance criterion maps to plan tasks and validation.

Required columns:

```markdown
| PRD Acceptance Criterion | Plan Destination | Validation Evidence Required | Notes |
|---|---|---|---|
```

Also include a "Deferred / Not Phase 3" matrix for Phase 4 and explicitly out-of-scope items so they cannot silently leak into Phase 3.

### 9. Final Self-Audit Checklist

Add a checklist that must be true before implementation starts:

- PRD Phase 3 scope is reconciled with verified Phase 1/2 state.
- No Phase 4 or proxy-routing scope leaked in.
- Worker worktree isolation is testable.
- Cross-model review policy is concrete.
- Merge approval gate is concrete.
- Validation gate engine is concrete.
- Config defaults and validation are exact.
- Event contract is canonical.
- Host-gated tests have explicit env markers.
- The plan can be implemented without reading prior reviews for missing requirements.

## Required Review Loop Before Approval

After drafting the plan, run a pre-implementation plan audit before asking for approval.

Create or update a review artifact under:

`docs/reviews/2026-06-02-plan-review-phase3-multi-llm-worker-orchestration.md`

The review must check:

- PRD-to-plan traceability.
- Current codebase compatibility.
- Config/schema/default precision.
- Worker isolation and security boundaries.
- Git/worktree lifecycle and cleanup.
- Validation gate correctness.
- Cross-model review correctness.
- Merge approval correctness.
- Host-gated test realism.
- Docs/runbook coverage.
- No stale Phase 2 assumptions.
- No Phase 4 scope leakage.

If the review finds issues, patch the plan and rerun the review from scratch. Repeat until the newest review says zero blocking implementation-readiness issues remain.

Do not ask for plan approval until the newest review is clean or only contains explicitly accepted non-blocking residual risks.

## Planning Discipline

- Use TDD in the eventual implementation plan. Do not over-test: keep tests behavior-focused and parsimonious.
- Prefer existing project patterns over new abstractions unless Phase 3 genuinely needs them.
- Keep source edits scoped to Phase 3. Do not refactor Phase 1/2 systems unless needed for worker integration and named in the plan.
- Do not invent third-party CLI signatures. Verify local command availability where possible, or mark host-gated commands as placeholders requiring user configuration.
- If a product/architecture decision is unavoidable, stop and present the decision clearly before finalizing the plan.
- Do not commit.

## Desired End State Of This `/spec` Planning Session

By the end of planning, the repository should have:

1. A new Phase 3 implementation plan under `docs/plans/`.
2. The PRD reconciled if needed, or a plan task that reconciles it before code work.
3. A clean Phase 3 plan-review artifact under `docs/reviews/`.
4. A plan that is `Status: PENDING`, `Approved: No`, ready for user approval.
5. Clear next command for the user: re-enter `/spec` against the new plan after approval to implement.

