# Implementation Plan Review: Phase 2 aisup Supervisor Daemon

**Plan:** `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
**Reviewed:** 2026-05-28
**Review Iterations:** 4
**Status:** ISSUES_FOUND

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 0 | Blocks implementation or causes incorrect behavior |
| HIGH | 2 | Significant gap that will cause rework |
| MEDIUM | 0 | Quality issue that should be fixed before implementation |
| LOW | 0 | Minor improvement |
| INFO | 0 | Observation or suggestion |

**Total findings:** 2
**Recommendation:** FIX_AND_RE_REVIEW

The traceability matrix includes all 76 finding IDs from `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`, with zero duplicate IDs. The second merge audit's seven resolved items are present in the current plan body. The remaining issues below are implementation-readiness gaps found during the final local-evidence pass.

Iteration 4 re-ran the ID comparison, rechecked both findings against current source, and ran fresh verification (`npm run typecheck`, focused CLI/Slack/server tests, and the full Vitest suite). No additional blockers were found.

## Findings

### HIGH

#### HI-001: Integration smoke test still shares the production tmux socket

**Evidence:**
- Task 1 requires an isolated temp daemon home, test-specific port, PID, token, sessions, and journal paths, but does not require a test-specific tmux socket. It also suggests verifying attach with `tmux -L aisup has-session` (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:336`, `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:338`).
- The daemon hardcodes the tmux socket as `aisup` (`src/daemon/index.ts:47`).
- `aisup start --dry-run` enumerates `listSessions('aisup')` (`src/cli/commands/start.ts:57`), and `aisup attach` hardcodes `tmux -L aisup` (`src/cli/commands/attach.ts:38`).
- The Phase 1 alignment scan requires live tmux enumeration to use the configured socket and attach to use the same socket as daemon-created sessions (`docs/plans/2026-05-07-phase1-alignment-scan.md:481`, `docs/plans/2026-05-07-phase1-alignment-scan.md:678`).

**Issue:**
Task 1's smoke test can isolate filesystem state while still seeing or colliding with a real user's tmux server on socket `aisup`. If a live aisup session exists, `SessionManager.getBlockingSession()` will see `aisup-*` sessions on the shared socket even when the temp state directory is empty, which can block or distort the smoke test. Cleanup code also has no plan-level way to distinguish test sessions from live sessions at the socket boundary.

**Impact:**
The first host-gated integration test can fail on a normal development machine with an active aisup session, or worse, interact with live supervised tmux sessions. That undermines the plan's Phase 1 remediation gate and violates the stated requirement that live user supervisor state is not touched.

**Optimal Fix:**
Add a plan requirement before Task 1 implementation to make the tmux socket configurable and test-isolated. The smallest durable path is to add `daemon.tmux_socket` or `session.tmux_socket` with default `aisup`, set it to a unique value such as `aisup-test-<pid>` in the smoke test config, and replace the hardcoded socket in daemon startup, dry-run session enumeration, attach, rehydration wiring, loop-manager deps, SlackService wiring, and Task 1's `tmux -L ... has-session` check.

**Why This Fix:**
It preserves the existing production default while giving host-gated tests a real isolation boundary. It also satisfies the current alignment scan socket-parity requirements instead of relying on "temp HOME" to isolate a resource that is not under HOME.

**Fix Validated:**
YES - `SessionManager` already accepts `tmuxSocket` through `SessionManagerOpts` (`src/session/manager.ts:22-27`), and SlackService/rehydration/loop-manager already accept socket values through their dependency objects. The missing piece is a plan-owned config/source for daemon and CLI code that currently hardcode `aisup`.

**Validation Command:**
`rg -n "tmux_socket|tmux socket|const tmuxSocket = 'aisup'|listSessions\\('aisup'\\)|'-L', 'aisup'" src/config src/daemon src/cli src/session tests docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`

**Affected Tasks:**
Task 1, C1, Phase 1 Remediation R14, attach/socket verification.

---

#### HI-002: Task 10 preserves permit routing but not the deny keystroke contract from HI-010

**Evidence:**
- Prior review HI-010's optimal fix required both `case 'permit'` and `case 'deny'` handlers, with `permit` sending the approval keystroke and `deny` sending the denial keystroke (`docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md:692-696`).
- The merged plan defines only `approval_key` in `PermissionsConfig` and defaults (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:275`, `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:284-293`).
- Task 10 says auto-grant/deny side effects live at the daemon/Slack boundary, but only specifies the approval keystroke as `config.permissions.approval_key` plus Enter (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:548-553`).
- The host-gated Claude permission validation path verifies only approval behavior (`docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:340`, `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md:632`).
- AGENTS.md requires terminal/system-reserved control input to be rejected during validation, with `!interrupt` as the only intentional Ctrl-C path (`AGENTS.md:8`).
- The PRD lists Slack-based approve/deny for pending permission prompts as Phase 2 scope (`docs/prd/2026-04-29-ai-supervisor.md:79-80`).

**Issue:**
The plan tells implementers how to approve a prompt but not how to deny one. A zero-context implementer can add `!deny`, `onPermissionDeny`, `permission.denied`, and `permission.auto_denied` while leaving the Claude prompt blocked because no denial input, denial key, or validated "no keystroke" behavior is specified.

**Impact:**
The permission broker can pass unit tests for routing and events while failing the user-visible approve/deny workflow. The default policy is `default_action: "deny"`, so an incomplete deny action is especially risky: unmatched prompts could be marked denied in the journal while the runner remains stuck at the prompt.

**Optimal Fix:**
Extend C1 and Task 10 with an explicit denial action contract. Prefer adding `permissions.denial_key` with a default selected by live validation, and require `sendText(config.permissions.denial_key)` followed by `sendEnter()` for auto-deny and `!deny`, using the same freshness and TTL checks as approval. Validate `approval_key` and `denial_key` as non-empty printable text without NUL/newline/control input; Enter remains a separate `sendEnter()` call. Extend the host-gated `AISUP_TEST_PERMISSIONS=1` path to validate both approval and denial behavior. If Claude's current prompt has no safe denial keystroke, the plan must say that explicitly and define the fallback behavior, such as expiring the pending request with a Slack/manual instruction instead of claiming the prompt was denied.

**Why This Fix:**
It completes the same boundary that HI-010 already required without moving side effects into `policy.ts` or inventing another event channel. It also makes deny behavior testable against the real Claude prompt instead of relying on ambiguous mocks.

**Fix Validated:**
NO - [FIX UNVALIDATED] The need for a plan-owned deny action is validated by the prior review, current plan text, and PRD scope. The exact denial key is not validated locally because it depends on current Claude permission prompt behavior and must be verified through the host-gated Claude permission test.

**Validation Command:**
Manual/host-gated: `AISUP_INTEGRATION=1 AISUP_TEST_PERMISSIONS=1 npx vitest run tests/integration/smoke.test.ts`, with assertions for both approve and deny prompt outcomes.

**Affected Tasks:**
C1, Task 1, Task 10, Validation Gates, HI-010 merge coverage.

---

## Review Methodology

Read the full implementation plan, the full merged-plan audit, and all finding headings plus optimal-fix sections from the prior 3,209-line plan review. Rechecked the Phase 1 compliance addendum and full Phase 1 audit sections against the current plan's remediation gate and traceability matrix. Verified every matrix ID from the first review is present in the plan and that the second audit's resolved `MERGE-HI-*` / `MERGE-ME-*` findings are represented in current plan text.

Repository evidence checked included config schema/defaults/loader, daemon startup, daemon server routes, loop-manager, rehydration, session manager/tmux boundaries, Slack command dispatch, journal reader/writer/types, statusline store/types, failover switcher/migrator/types, account scoring/circuit breaker, CLI start/attach/log/status/accounts/stop/failover commands, package scripts, Vitest config, PRD, and Phase 1 alignment scan.

Commands run:

```bash
git status --short
wc -l docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md docs/reviews/2026-05-28-merged-phase2-plan-merge-audit.md
rg -n "^(#|##|###|####)|^\\*\\*Status:\\*\\*|^\\*\\*Recommendation:\\*\\*|^\\*\\*Total findings:\\*\\*" docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md
awk -F'|' '/^\\| (CR|HI|ME|LO|IN|P1-)/ {count++; gsub(/^ +| +$/,"",$2); ids[$2]++} END{printf("rows=%d\\n",count); for (id in ids) if (ids[id]>1) print id, ids[id]}' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "TODO|FIXME|TBD|unclear|placeholder|not specified|maybe|should probably|address review findings|see review|later integration|such as" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "tmux_socket|tmux socket|const tmuxSocket = 'aisup'|listSessions\\('aisup'\\)|'-L', 'aisup'" src/config src/daemon src/cli src/session tests docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "deny|denial|permission|permit|approval_key|send denial|send approval|auto-deny|auto-grant" docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md docs/reviews/2026-05-28-merged-phase2-plan-merge-audit.md docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
node -e "const fs=require('fs'); const review=fs.readFileSync('docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md','utf8'); const plan=fs.readFileSync('docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md','utf8'); const ids=[...new Set([...review.matchAll(/^#### ((?:CR|HI|ME|LO|IN)-\\d+|P1-(?:CR|HI)-\\d+|P1-FULL-\\d+)/gm)].map(m=>m[1]))].sort(); const rows=[...plan.matchAll(/^\\| ((?:CR|HI|ME|LO|IN)-\\d+|P1-(?:CR|HI)-\\d+|P1-FULL-\\d+) \\|/gm)].map(m=>m[1]); const rowSet=new Set(rows); console.log('review_ids='+ids.length); console.log('matrix_rows='+rows.length); console.log('duplicates='+rows.filter((id,i)=>rows.indexOf(id)!==i).join(',')); console.log('missing_from_matrix='+ids.filter(id=>!rowSet.has(id)).join(',')); console.log('extra_matrix_ids='+rows.filter(id=>!ids.includes(id)).join(','));"
npm run typecheck
npx vitest run tests/slack/commands.test.ts tests/daemon/server.test.ts tests/cli/commands.test.ts
npx vitest run
```

Verification results: `npm run typecheck` passed; focused tests passed with 30 tests; full Vitest passed with 273 tests and 11 tmux-backed tests skipped because the sandbox cannot connect to the tmux socket. No destructive or networked commands were run.
