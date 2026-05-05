---
name: handoff
description: |
  Stop implementation and create a complete session handoff for account transfer.
  Use when: user says "handoff", "stop and handoff", "session transfer", "switch account",
  "pause implementation", "save progress", or invokes /handoff. Fully automatic — gathers
  all context, writes handoff doc + resume prompt, outputs only the prompt path.
  Designed for multi-session implementation across Claude accounts.
targets: [claude]
tags: [workflow, session-management]
metadata:
  author: alec.m.brock@gmail.com
  version: 1.0.0
---

# /handoff — Implementation Session Handoff

Stop implementation. Create handoff document + resume prompt. Output prompt path. Nothing else.

## Iron Laws

1. **No questions.** Gather everything programmatically. Zero user interaction.
2. **No more code changes** after this skill is invoked. Finish your current atomic operation (save the file, finish the test), then stop.
3. **Final output is ONLY the prompt file path.** One line. That's the entire response after the files are written.

## Step 1: Capture Next Action (BEFORE gathering context)

Before running any commands, write down internally what you know from the current session:

- What task you were working on (task number and name from the plan)
- The EXACT next step you were about to take (file path, function name, test to write — be surgical)
- Any in-flight decisions, partial implementations, or open questions
- Any context that only exists in your working memory right now

This is the single most important piece of the handoff. A vague "continue Task 3" is useless. "Write `tests/session/tmux.test.ts` — next test case is `should destroy session and clean up pipe-pane log`, mocking `child_process.execFile` for `tmux kill-session`" is what the next session needs.

## Step 2: Generate Timestamp

```bash
TS=$(date +%Y-%m-%dT%H-%M-%S) && echo "$TS"
```

Use this for both output filenames. Store it.

## Step 3: Gather Context

Collect ALL of the following. Run commands in batch where possible to minimize round-trips.

### 3a: Git State

```bash
git branch --show-current
git log --oneline -20
git status --short
git diff --stat
```

If there are uncommitted changes, also capture the full diff:

```bash
git diff
git diff --cached
```

### 3b: Plan Progress

Read `docs/plans/2026-04-29-aisup-supervisor-daemon.md` and extract:

- All task checkboxes: `[x]` (done) and `[ ]` (pending)
- The Done/Left counters from the Progress Tracking section
- Which task is currently in progress (first unchecked, or the one you were working on)

### 3c: Task List

If TaskList tool is available, read all tasks and their statuses. If not available, note "TaskList not available — task state captured from plan checkboxes."

### 3d: Test Results

```bash
npx vitest run 2>&1 | tail -50
```

Handle these cases:
- Tests pass: record count and status
- Tests fail: record which tests fail and why
- No tests yet: note "No tests exist yet"
- Vitest not configured: note "Vitest not yet set up"

### 3e: Source and Test File Inventory

```bash
find src -type f 2>/dev/null | sort
find tests -type f 2>/dev/null | sort
```

### 3f: Recent Session Changes

```bash
git log --oneline --name-status HEAD~5..HEAD 2>/dev/null
```

If fewer than 5 commits exist, use `git log --oneline --name-status`.

## Step 4: Write Handoff Document

```bash
mkdir -p docs/handoff
```

Write to `docs/handoff/handoff-$TS.md` using the Write tool:

```markdown
# Implementation Handoff — $TS

## Session Summary

[1-2 sentences: what this session accomplished overall]

## Completed Work

### Plan Tasks Completed

[For each task completed or partially completed:]
- [x] Task N: [name] — [what was done, key files created]

### Files Created

| File | Purpose |
|------|---------|
| `src/path/to/file.ts` | [1-line description] |

[Include ALL files created during this session]

### Files Modified

| File | Changes |
|------|---------|
| `path/to/file` | [what changed and why] |

### Tests Written

| Test File | Covers |
|-----------|--------|
| `tests/path/to/test.ts` | [what behavior it verifies] |

## Decisions Made

[For EACH non-trivial decision made during implementation:]

- **Decision:** [what was decided]
  **Rationale:** [why — this is critical for the next session to understand]
  **Alternatives rejected:** [what else was considered]

[If no significant decisions: "No notable decisions beyond plan specifications."]

## Deviations from Plan

[Anything that changed from the implementation plan:]
- [deviation description and why it was necessary]

[If perfectly on-plan: "None — implementation followed the plan exactly."]

## Current State

### Git
- **Branch:** `[branch name]`
- **Last commit:** `[hash] [message]`
- **Uncommitted changes:** [none / list of files with brief description]

### Tests
- **Status:** [all passing (N tests) / N failing / no tests yet]
- **Output:** [key lines from test results]

### Plan Progress
- **Done:** [N] / [Total tasks]
- **Left:** [M]
- **Current task:** Task [N]: [name]

## Pending Work

### Remaining Plan Tasks

[For each remaining task from the plan:]
- [ ] Task N: [name] — [1-line scope description]

### Immediate Next Action

> **THE VERY NEXT THING TO DO:**
>
> [Be extremely specific. Not "continue Task 3" but exactly what file to create/modify, what function to write, what test to add, what the expected behavior is. Include file paths, function signatures, test names. The next session should be able to start coding within 60 seconds of reading this.]

### After That

[2-3 bullet points of what follows the immediate next action, for broader orientation]

## Blockers and Issues

[Problems discovered, workarounds applied, open questions, things that surprised you.]

[If clean: "No blockers or issues."]
```

## Step 5: Write Resume Prompt

Write to `docs/prompts/resume-$TS.md` using the Write tool:

```markdown
Read these files in order before doing anything else:

1. `docs/handoff/handoff-$TS.md` — Complete state from previous session
2. `docs/plans/2026-04-29-aisup-supervisor-daemon.md` — Implementation plan
3. `CLAUDE.md` — Project rules
4. `AGENTS.md` — Engineering rules

The handoff document contains everything: what's done, what's pending, decisions made, current git/test state, and the exact next action to take.

After reading all four files, do this:

1. State in 2-3 sentences what you understand the current progress to be and what the immediate next action is
2. Resume implementation from exactly where the previous session stopped — the handoff document's "Immediate Next Action" section tells you precisely what to do
3. Follow TDD (write failing test first, then implement, then verify)
4. Verify each task before marking it complete
5. When you need to stop or switch accounts, invoke /handoff to create the next handoff
```

## Step 6: Final Output

After writing both files successfully, your ENTIRE remaining response is this single line:

```
docs/prompts/resume-$TS.md
```

Nothing before it. Nothing after it. No explanation, no summary, no "handoff complete" message. Just the path. The user will copy this path and paste it into a new Claude session.

## When NOT to Use

- No implementation work was done in this session (nothing to hand off)
- All plan tasks are complete (use /finishing-a-development-branch instead)
- You're in the middle of an unsaved edit or running test (finish the atomic unit first)
