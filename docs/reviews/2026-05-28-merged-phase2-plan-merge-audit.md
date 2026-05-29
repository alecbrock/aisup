# Merged Phase 2 Plan Review-to-Plan Audit - 2026-05-28

## Verdict

Final closure status: `MERGE_CLEAN_AFTER_FINAL_PATCH`.

The merged implementation plan now contains a complete traceability matrix for all 76 review finding IDs, and the final-pass gaps identified in this audit have been patched into `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`.

Recommendation: the plan is ready to use as the implementation source of truth after owner approval. This audit only validates review-to-plan merge completeness; it does not mean the Phase 1 or Phase 2 code work is implemented.

## Final Closure Update

2026-05-28 final pass rechecked both review documents against the implementation plan and applied the missing plan details. No additional unresolved merge issues were found.

Resolved in the plan:

- MERGE-HI-001: C1 now includes exact `RecoveryConfig`, `PermissionsConfig`, and `GatesConfig` defaults.
- MERGE-HI-002: R7 now names exact migration and telemetry journal detail requirements.
- MERGE-HI-003: R9 now requires status timestamps, telemetry summary, `active_skill`, and recovery guidance.
- MERGE-ME-001: R11 now requires 429/rate-limit classification after externally destroyed tmux sessions.
- MERGE-ME-002: R13 now preserves the five-minute restart failure window.
- MERGE-ME-003: Task 1 and Validation Gates now own `AISUP_TEST_PERMISSIONS=1` live Claude permission validation.
- MERGE-ME-004: Task 9 now selects `picomatch` as the direct glob dependency.

## Coverage Checked

- Review document: `docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md`
- Merged plan: `docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md`
- Matrix rows found in merged plan: 76
- Expected rows found: 76
- Duplicate finding IDs in traceability matrix: 0
- Typecheck after final patch: passed

The traceability matrix itself is complete. The findings below are preserved as audit history and are resolved by the final patch.

## Findings

### MERGE-HI-001 [RESOLVED]: HI-001 defaults were mapped but the exact safe defaults were not merged

**Severity:** HIGH

**Review Evidence:** HI-001 requires concrete defaults for `recovery`, `permissions`, and `gates`, including `auto_resume_exhausted: true`, `exhausted_poll_interval_s: 60`, `network_error_threshold: 3`, permission policy defaults, Slack routing defaults, TTL, and gate trigger defaults.

**Plan Evidence:** Consolidation C1 says only to "Update `CONFIG_DEFAULTS` for every new section" and lists field names, but does not specify the concrete default values.

**Issue:** A future implementer can satisfy the plan text while choosing different defaults than the reviewed fix intended.

**Optimal Fix:** In C1, add the exact default object values for `RecoveryConfig`, `PermissionsConfig`, and `GatesConfig`, including the existing review's safe defaults plus `max_exhausted_retries: 5` and `approval_key: 'y'`.

**Affected Findings:** HI-001, ME-023, ME-002

### MERGE-HI-002 [RESOLVED]: P1-FULL-010 journal contract was merged too generically

**Severity:** HIGH

**Review Evidence:** P1-FULL-010 requires exact migration and telemetry event corrections: `migration.already_migrated` must align with the canonical `migration.skipped_already_migrated` name, migration events must include fields such as `target_path`, `source_size`, `target_sha256`, and invalid-path events must use safe reason enums. It also requires `telemetry.invalid_json` parse-summary details and enriched `telemetry.session_mismatch` observed/expected criteria.

**Plan Evidence:** R7 says "Migration events include safe source/target path metadata, size, hashes, and safe reason enums" and that telemetry events include safe criteria, but it does not name the canonical event rename or exact required fields.

**Issue:** The plan captures the spirit of the fix, but not enough exact contract detail to prevent a second incomplete implementation.

**Optimal Fix:** Expand R7 with the exact event names and required fields from P1-FULL-010. Explicitly require `migration.skipped_already_migrated`, `target_path`, `source_size`, `target_sha256`, structured invalid-path reason enums, `telemetry.invalid_json` parse summary, and `telemetry.session_mismatch` expected/observed fields.

**Affected Findings:** P1-FULL-010, R7

### MERGE-HI-003 [RESOLVED]: P1-FULL-012 status observability fields were not fully preserved

**Severity:** HIGH

**Review Evidence:** P1-FULL-012 requires `/api/status` and `aisup status --json` to expose persisted session ID, status, account, cwd, tmux name, active skill, timestamps, telemetry summary, and recovery guidance; it also requires accounts/log parity.

**Plan Evidence:** R9 correctly covers persisted status refresh, configured journal paths, and richer account data, but it does not explicitly require status timestamps, telemetry summary, or recovery guidance.

**Issue:** A future implementer could complete R9 and still leave `aisup status --json` under-specified relative to the review fix.

**Optimal Fix:** Extend R9 requirements and tests to include `active_skill`, timestamps, telemetry summary, and recovery guidance in online status/JSON output.

**Affected Findings:** P1-FULL-012, R9

### MERGE-ME-001 [RESOLVED]: P1-FULL-014 omitted the 429-classification step for externally destroyed tmux sessions

**Severity:** MEDIUM

**Review Evidence:** P1-FULL-014 requires checking whether the tmux session exists before `isProcessDead()`, emitting `session.destroyed_externally`, scanning the last output window for 429 classification, and then applying the same restart/switch/exhaustion decision matrix.

**Plan Evidence:** R11 includes `hasSession()`/`sessionExists()`, checking before `isProcessDead()`, and emitting `session.destroyed_externally`, but it does not mention scanning the last output window for 429 classification.

**Issue:** Missing that classification step can make externally destroyed sessions fall into the wrong recovery path.

**Optimal Fix:** Add to R11: after a missing tmux session is detected, scan the last output window for 429/rate-limit classification before choosing restart, switch, or exhaustion.

**Affected Findings:** P1-FULL-014, R11

### MERGE-ME-002 [RESOLVED]: P1-FULL-016 lost the five-minute restart failure window

**Severity:** MEDIUM

**Review Evidence:** P1-FULL-016 cites the source plan requirement: switch after three same-account restart failures within five minutes, and reset counters after successful restart.

**Plan Evidence:** R13 says to escalate after the third failed restart and reset counters after success, but does not preserve the five-minute window.

**Issue:** Without the time window, implementers may count all historical restart failures indefinitely, or pick an arbitrary window.

**Optimal Fix:** Add the explicit five-minute rolling window to R13 requirements and tests.

**Affected Findings:** P1-FULL-016, R13

### MERGE-ME-003 [RESOLVED]: Live Claude permission validation is noted but not owned by a task or validation gate

**Severity:** MEDIUM

**Review Evidence:** ME-002 marks the `y` + Enter approval key as `[FIX UNVALIDATED]` pending a live Claude permission prompt. ME-009 also notes exact permission prompt patterns depend on Claude Code version. ME-003 says bypass-mode smoke tests cannot validate permission patterns.

**Plan Evidence:** Task 8 says live validation with bypass disabled is "a later integration check", Task 10 uses `approval_key` with `sendText()` + `sendEnter()`, and Task 1 records when permission output was not tested. No task or validation gate owns the later live check.

**Issue:** Implementation can pass all listed plan tests with mocks while never validating that the configured approval key and detector patterns work against a real current Claude prompt.

**Optimal Fix:** Add an explicit host-gated permission validation gate, e.g. `AISUP_TEST_PERMISSIONS=1` with bypass mode disabled and `@requires_claude`, to validate prompt detection and `approval_key` behavior. If it cannot run in CI, require a documented manual result in `tests/integration/TELEMETRY_FIELDS.md` or a dedicated permission validation artifact.

**Affected Findings:** ME-002, ME-003, ME-009, Task 1, Task 8, Task 10

### MERGE-ME-004 [RESOLVED]: ME-024 selects a direct glob dependency but does not name it

**Severity:** MEDIUM

**Review Evidence:** ME-024 requires choosing one implementation path for permission glob matching: a direct dependency such as `picomatch`/`minimatch`, or a documented local matcher.

**Plan Evidence:** Task 9 says, "Add a direct glob matcher dependency such as `picomatch`, or document and test a local matcher. This plan selects a direct dependency..."

**Issue:** The plan says it selects a direct dependency but still leaves the exact dependency open with "such as". This is avoidable ambiguity in security-sensitive permission policy matching.

**Optimal Fix:** Pick the exact dependency in Task 9, preferably `picomatch`, and require tests for the exact `<tool>:<detail>` examples against that library.

**Affected Findings:** ME-024, Task 9

## Verified Good Merges

The audit specifically confirmed these review fixes are present in task bodies, not only in the matrix:

- Phase 1 CRITICAL addendum issues are represented by R1-R4.
- P1-FULL-005 idle `session.stop` misuse is represented by R5 and Task 12.
- P1-FULL-008/P1-FULL-009 retry eligibility and soft-target execution are represented by R6.
- P1-FULL-011 and CR-006 persisted `EXHAUSTED` rehydration/re-arm are represented by R8 and Task 7.
- CR-001/CR-002 phantom rehydration gaps are corrected in Task 2's current-behavior section.
- CR-003 gate trigger is corrected to idle plus non-null `active_skill`, with active-skill clearing in Task 12.
- HI-005/HI-012 shell-free gate execution is corrected in Task 11.
- HI-013/HI-014 smoke-test home isolation and noninteractive attach handling are corrected in Task 1.
- ME-021/ME-022 cost/log type filtering and configured journal paths are corrected in Task 5.
- LO-004 event union consolidation is centralized in C1.

## Verification Commands Run

```bash
wc -l docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md
rg -n "^#### (CR|HI|ME|LO|IN)-|^#### P1-|^#### P1-FULL-" docs/reviews/2026-05-12-plan-review-phase2-aisup-supervisor-daemon.md
rg -n "^### Phase 1 Remediation|^### Consolidation|^### Task|^## Finding Traceability|^\\| (CR|HI|ME|LO|IN|P1-)" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
awk -F'|' '/^\\| (CR|HI|ME|LO|IN|P1-)/ {count++; gsub(/^ +| +$/,"",$2); if ($2 ~ /^CR-/) cr++; else if ($2 ~ /^HI-/) hi++; else if ($2 ~ /^ME-/) me++; else if ($2 ~ /^LO-/) lo++; else if ($2 ~ /^IN-/) inf++; else if ($2 ~ /^P1-CR-/) p1cr++; else if ($2 ~ /^P1-HI-/) p1hi++; else if ($2 ~ /^P1-FULL-/) p1full++} END{printf("rows=%d CR=%d HI=%d ME=%d LO=%d IN=%d P1-CR=%d P1-HI=%d P1-FULL=%d\\n",count,cr,hi,me,lo,inf,p1cr,p1hi,p1full)}' docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "TODO|FIXME|TBD|unclear|placeholder|not specified|maybe|should probably|address review findings|see review" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "skipped_already_migrated|already_migrated|migration\\.skipped|migration\\.completed|migration\\.invalid_path|source_size|target_path|target_sha256|parse_error_summary|telemetry\\.invalid_json|telemetry\\.session_mismatch" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "AISUP_TEST_PERMISSIONS|approval key|approval_key|bypass mode disabled|live validation|Manual test|requires_claude|permission prompt output|permission patterns" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
rg -n "picomatch|minimatch|micromatch|direct glob|glob matcher|such as" docs/plans/2026-05-11-phase2-aisup-supervisor-daemon.md
npm run typecheck
```
