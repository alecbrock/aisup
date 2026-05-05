# Implement aisup Plan

Implement `docs/plans/2026-04-29-aisup-supervisor-daemon.md` in this repository.

Required context:
- `CLAUDE.md`
- `AGENTS.md`
- `docs/prd/2026-04-29-ai-supervisor.md`
- `docs/reviews/2026-05-05-aisup-final-blocking-plan-review-v2.md`

Execution requirements:
1. Use `subagent-driven-development` if subagents are available; otherwise use `executing-plans` serially.
2. Follow TDD for production behavior.
3. Keep pure unit tests separate from `requires_tmux`, `requires_slack`, and `requires_claude` integration tests.
4. Verify each task before marking it complete.
5. Do not commit unless explicitly asked.
