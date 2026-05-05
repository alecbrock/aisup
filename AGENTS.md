# aisup Agent Rules

1. Treat tmux, Claude, Pilot, and Slack subprocess output as primary evidence; investigate the named boundary before changing adjacent orchestration code.
2. For subprocess, tmux, statusline, Claude resume, Slack webhook, or daemon lifecycle bugs, add one real integration test or deterministic fixture reproduction before iterating on fixes.
3. Use one canonical event contract and one state machine; do not add competing event shapes or hidden status channels.
4. Separate session visibility, runner state, and daemon process lifetime; attach/detach/watch behavior must not implicitly kill or reset runtime state.
5. Persist supervisor state durably enough for daemon restart and rehydration; never rely on arm-time snapshots for long-running monitoring.
6. Reject terminal/system-reserved control input during validation. `!interrupt` is the only intentional Ctrl-C path, and it must target Claude through the tmux pane.
7. Keep pure logic tests separate from host-gated integration tests with explicit markers: `requires_tmux`, `requires_slack`, and `requires_claude`.
8. Use shell-free subprocess execution by default (`execFile`/argument arrays). Shell boundaries must be explicitly justified and tested.
9. Do not commit secrets, Slack tokens, Claude account paths, session transcripts, tmux captures, or local `.claude/settings.local.json`.
10. Do not commit unless the user explicitly asks for a commit.
