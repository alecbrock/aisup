# aisup — Claude Implementation Rules

Read this file before implementation work.

## Primary Context

- Implementation plan: `docs/plans/2026-04-29-aisup-supervisor-daemon.md`
- Product requirements: `docs/prd/2026-04-29-ai-supervisor.md`
- Final blocking review: `docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md`
- Pilot statusline tap fixture: `scripts/failover/statusline-tap.sh`

The final blocking review has already been applied to the plan. Do not re-open non-blocking design debates during implementation. If a new blocker is found, stop and document the exact blocking condition, affected task, and proposed minimal fix.

## Execution Rules

- Follow `AGENTS.md` for repository-wide engineering rules.
- Use the local `.claude/skills/subagent-driven-development` workflow when executing the plan with subagents.
- Use `.claude/skills/executing-plans` for serial execution if subagents are unavailable.
- Use `.claude/skills/test-driven-development` for production behavior changes.
- Use `.claude/skills/verification-before-completion` before claiming any task is complete.
- Do not commit unless explicitly asked by the user, even if a copied skill suggests committing.

## Implementation Boundaries

- This repository is the standalone `aisup` project. Do not import or copy application code from the source project.
- Reuse only generic Claude/Pilot workflow assets copied into `.claude/skills` and the statusline tap fixture in `scripts/failover`.
- Keep host-gated tests separate from pure unit tests and document required environment variables for Slack/Claude integration tests.
- Treat `~/.claude`, `~/.claude-account2`, Slack tokens, and Pilot session IDs as user-local runtime configuration, not repository content.
