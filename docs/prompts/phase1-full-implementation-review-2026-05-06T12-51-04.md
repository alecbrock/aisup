# Codex Prompt: Full Phase 1 Implementation Review

You are Codex reviewing Claude's completed Phase 1 implementation of the `aisup` project. This is a review-only task. Do not implement fixes. Do not commit. Your only durable repo change should be the review report you write under `docs/reviews`.

## Objective

Perform a full, manual, line-by-line implementation review of Phase 1 against the approved implementation plan and the actual codebase. Verify whether Claude's implementation is correct, complete, safe, and ready to use as the foundation for Phase 2 planning.

You must not trust the handoff's claims as truth. Treat the handoff as one evidence source to verify. In particular, reconcile the contradiction that it says Phase 1 is "fully implemented and VERIFIED" while also listing incomplete daemon loop wiring, API stubs, incomplete switch orchestration, incomplete `terminateRunnerForSwitch()`, incomplete rehydration, and unexecuted live gates.

## Required Input Files

Read these before drawing conclusions:

1. `/Users/alecbrock/Projects/aisup/AGENTS.md`
2. `/Users/alecbrock/Projects/aisup/CLAUDE.md`
3. `/Users/alecbrock/Projects/aisup/docs/plans/2026-04-29-aisup-supervisor-daemon.md`
4. `/Users/alecbrock/Projects/aisup/docs/handoff/handoff-2026-05-06T12-51-04.md`
5. `/Users/alecbrock/Projects/aisup/docs/prd/2026-04-29-ai-supervisor.md`
6. `/Users/alecbrock/Projects/aisup/docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md`
7. All relevant files under `/Users/alecbrock/Projects/aisup/src`
8. All relevant files under `/Users/alecbrock/Projects/aisup/tests`
9. `package.json`, `tsconfig.json`, `vitest.config.ts`, and any build/lint/test config files

## Output Requirement

Write your final review report to:

`/Users/alecbrock/Projects/aisup/docs/reviews/2026-05-06-phase1-full-implementation-review.md`

If that exact file already exists, write to:

`/Users/alecbrock/Projects/aisup/docs/reviews/2026-05-06-phase1-full-implementation-review-v2.md`

The report must be detailed enough that Phase 2 planning can rely on it. It must include every issue you found, what you did to verify that it is a real issue, and the most optimal fix.

## Non-Negotiable Review Rules

- Review the implementation plan line by line. Do not only skim the handoff or tests.
- Build a traceability matrix from every Phase 1 task and its acceptance criteria to actual implementation evidence.
- Manually inspect the code paths. Passing tests are not enough.
- Treat tmux, Claude/Pilot, Slack, subprocess, statusline, daemon lifecycle, and persisted state boundaries as high-risk.
- Use shell-free subprocess expectations from `AGENTS.md` as a hard requirement unless a shell boundary is explicitly justified and tested.
- Keep session visibility, runner state, and daemon process lifetime separate when evaluating behavior.
- Verify that terminal/system-reserved control input is rejected and that `!interrupt` is the only intended Ctrl-C path to Claude through tmux.
- Verify there is one canonical event contract and one canonical session state machine.
- Verify that pure tests and host-gated integration tests are separated with explicit markers: `requires_tmux`, `requires_slack`, and `requires_claude`.
- Do not reveal or copy secrets, Slack tokens, Claude account paths, session transcripts, tmux captures, or local `.claude/settings.local.json`.
- Do not edit production code or tests. Temporary scratch files under `/private/tmp` are acceptable if needed for deterministic verification.
- Do not proceed to Phase 2 planning. This task is only to answer whether Phase 1 is complete and what must be fixed first.

## Required Verification Commands

Run fresh verification from `/Users/alecbrock/Projects/aisup` and capture the result in the review report:

```bash
git status --short
git log --oneline -5
git show --stat --oneline b7379b4
npm run typecheck
npm run build
npm test
```

Also run these inspection commands or equivalent searches:

```bash
rg -n "TODO|FIXME|stub|placeholder|not implemented|throw new Error|performSwitch|terminateRunnerForSwitch|rehydrat|pipe-pane|execSync|spawn\\(|execFile|shell:" src tests docs
rg -n "requires_tmux|requires_slack|requires_claude|describe\\.skip|it\\.skip|process\\.env" tests
rg -n "event_type|SessionState|switch_tx|failover|EXHAUSTED|SWITCHING|SWITCH_PENDING_AT_IDLE" src tests
```

If a required command cannot run because of missing host dependencies, sandbox restrictions, or environment constraints, record:

- exact command
- exact failure
- whether the failure blocks review confidence
- the next best evidence you used instead

## Review Method

Work in this order.

### 1. Establish Repo State

Verify:

- current branch and cleanliness
- whether commit `b7379b4` exists and matches the handoff claim
- whether there are untracked files or uncommitted changes that affect review scope
- whether the implementation files listed in the handoff actually exist
- whether the test counts claimed in the handoff match current test output

### 2. Create Plan Traceability

For each plan task, inspect the task text, key decisions, files, acceptance criteria, and any cross-references elsewhere in the plan. Then verify the implementation against code and tests.

Tasks to cover explicitly:

- Task 1: Project scaffolding and config
- Task 2: Event journal
- Task 3A: CLI scaffolding and daemon/API basics
- Task 3: Session controller with tmux
- Task 4: Runner abstraction
- Task 5: Account registry and scoring
- Task 6: Statusline store
- Task 7: Account switching and transcript migration
- Task 8: Monitoring daemon loops
- Task 9: Slack integration
- Task 10: Slack control commands
- Task 11: Workflow skill detection and propagation
- Task 12: CLI polish and HTTP API completion
- Task 13: Live acceptance gates
- Task 14: Runbook and README

For each task, classify as:

- `Complete`: all planned behavior exists and is verified by relevant tests/manual inspection
- `Partial`: meaningful implementation exists but important planned behavior is missing or unverified
- `Missing`: planned behavior is absent
- `Incorrect`: implementation exists but violates plan, PRD, or AGENTS rules
- `Deferred by plan`: explicitly out of Phase 1 and correctly not implemented

### 3. Investigate Known High-Risk Claims First

Do not stop at these, but make sure each is deeply verified:

- Daemon loop tick wiring: confirm whether live daemon ticks actually poll statusline telemetry, output logs, account health, idle state, and session state, or whether callbacks are placeholders.
- Daemon API routes: confirm whether POST/DELETE `/api/sessions` and POST `/api/failover` call real `SessionManager`/`Switcher` behavior or return stubs.
- `performSwitch()`: confirm whether a single callable full 10-step switch sequence exists with `switch_tx` transaction safety, target retry policy, stable `aisup_session_id`, event journaling, transcript migration, and cleanup.
- `terminateRunnerForSwitch()`: confirm whether switch-owned runner termination exists and preserves `SWITCHING` state without emitting `session.stop`.
- Rehydration: confirm whether daemon startup reconciles persisted state and live tmux sessions, restores pipe-pane, handles `switch_tx`, state-without-tmux, tmux-without-state, and inconsistent STOPPED/live states.
- Live gates: confirm which gates were actually executed, which were fixture-only, which require operator action, and whether the handoff overstates verification.
- Slack: confirm Slack client/channel/relay/commands are more than type stubs and that disabled Slack mode works without tokens.
- Security: confirm secret redaction/scanning is recursive enough, no tokens are written by init/logging, local API auth is enforced, runtime file permissions are correct, symlinks/path traversal are rejected where required, and shell boundaries are controlled.
- State/event model: confirm there is exactly one session state machine and one event contract, with no hidden competing status channels.
- Tests: confirm plan-required integration tests or deterministic fixture reproductions exist for subprocess, tmux, statusline, Claude resume, Slack webhook, and daemon lifecycle bugs.

### 4. Manual Code Review Checklist

Inspect every module with attention to:

- correctness of async lifecycle and cleanup
- daemon start/stop semantics
- tmux session creation, attach, detach, stop, capture, pipe-pane, pane death detection
- subprocess use through `execFile`/argument arrays
- shell escaping only at justified tmux boundaries
- config loading, defaults, validation, path expansion, permissions
- event journal append behavior, JSONL correctness, malformed line handling, ENOSPC behavior, secret scanning
- account scoring, freshness handling, disabled accounts, circuit breaker persistence/cooldown
- statusline file matching by session/account/cwd/launch time, symlink rejection, stale telemetry rejection
- failover migration integrity, transcript path safety, collision behavior
- failover orchestration and transaction durability
- Slack auth, allowed-user checks, command parsing, confirmation TTL, output relay cursoring, redaction
- workflow skill detection and continuation prompt behavior
- CLI HTTP client behavior, readiness retries, 503 handling, daemon PID handling
- README/runbook accuracy compared with actual behavior

### 5. Compare Tests to Risk

For each significant behavior, decide whether the test is:

- direct and sufficient
- indirect but useful
- fixture-only
- host-gated and skipped unless environment is available
- missing
- testing a stub instead of real behavior

Call out tests that pass while proving the wrong thing, especially tests that assert placeholder/stub responses.

### 6. Decide Phase 2 Readiness

End with a clear decision:

- `READY FOR PHASE 2 PLANNING: YES`
- `READY FOR PHASE 2 PLANNING: YES, WITH BLOCKING PHASE 1 CARRYOVER`
- `READY FOR PHASE 2 PLANNING: NO`

Use `NO` if Phase 1 must be fixed before planning can responsibly continue. Use `YES, WITH BLOCKING PHASE 1 CARRYOVER` only if planning can proceed but the plan must begin with explicit Phase 1 completion/fix tasks.

## Required Report Structure

Write the report with this structure:

```markdown
# Phase 1 Full Implementation Review - 2026-05-06

## Executive Decision

- READY FOR PHASE 2 PLANNING: <YES | YES, WITH BLOCKING PHASE 1 CARRYOVER | NO>
- One-paragraph rationale.

## Verification Summary

| Check | Result | Evidence |
|---|---:|---|
| git status | ... | ... |
| commit b7379b4 | ... | ... |
| typecheck | ... | ... |
| build | ... | ... |
| tests | ... | ... |
| manual plan traceability | ... | ... |

## Critical Findings

List Blocker and High findings first. If none, say `None`.

## Complete Findings List

For EVERY issue found, use this exact template:

### ISSUE-001: <short title>

- Severity: <Blocker | High | Medium | Low>
- Category: <Correctness | Completeness | Security | Test Gap | Docs | Architecture | Operational Risk>
- Plan reference: `<file>:<line>` or section name
- Code reference: `<file>:<line>` for every relevant source location
- Expected behavior:
- Actual behavior:
- Verification performed:
- Why this is a real issue:
- Most optimal fix:
- Required test/fixture:
- Phase 2 impact:

## Plan Traceability Matrix

| Plan Task | Status | Implementation Evidence | Test Evidence | Gaps |
|---|---|---|---|---|
| Task 1 | ... | ... | ... | ... |
| Task 2 | ... | ... | ... | ... |
| Task 3A | ... | ... | ... | ... |
| Task 3 | ... | ... | ... | ... |
| Task 4 | ... | ... | ... | ... |
| Task 5 | ... | ... | ... | ... |
| Task 6 | ... | ... | ... | ... |
| Task 7 | ... | ... | ... | ... |
| Task 8 | ... | ... | ... | ... |
| Task 9 | ... | ... | ... | ... |
| Task 10 | ... | ... | ... | ... |
| Task 11 | ... | ... | ... | ... |
| Task 12 | ... | ... | ... | ... |
| Task 13 | ... | ... | ... | ... |
| Task 14 | ... | ... | ... | ... |

## Test Coverage Assessment

Summarize what the tests prove, what they do not prove, and any tests that assert stubs or placeholders.

## Security and Secrets Assessment

Summarize findings related to secrets, tokens, shell boundaries, file permissions, symlinks, path traversal, and control input.

## Runtime and Lifecycle Assessment

Summarize tmux, daemon, API, monitoring loops, rehydration, failover, and state machine concerns.

## Documentation Accuracy

List any README/runbook/handoff/PRD claims that conflict with implementation.

## Optimal Fix Order

Provide the shortest safe fix sequence before Phase 2 feature work. Include only fixes supported by findings above.

## Residual Risks

List risks that remain even if all findings are addressed.
```

## Severity Guidance

- `Blocker`: Phase 1 claim is materially false, MVP cannot perform a core promised behavior, a safety/security invariant is violated, or Phase 2 planning would be built on a false assumption.
- `High`: important behavior is incomplete or incorrect, but there is a clear workaround or it affects a narrower path.
- `Medium`: correctness, resilience, test, or documentation gap that should be fixed but does not invalidate the MVP by itself.
- `Low`: cleanup, clarity, minor docs mismatch, or non-blocking polish.

## Evidence Standards

For every issue, include direct evidence. Acceptable evidence includes:

- source file and line number
- test file and line number
- command output summarized with exact command and result
- plan/handoff/PRD line number
- deterministic fixture reproduction
- primary runtime evidence from tmux/Pilot/Slack when available

Do not write vague findings like "may be incomplete" without verifying. If evidence is inconclusive, state exactly what remains unknown and why.

## Final Instruction

After writing the report file under `docs/reviews`, respond with only:

1. the review report path
2. the executive decision
3. the number of findings by severity
4. any verification commands that could not be run

Do not include the full review body in chat; it belongs in the report file.
