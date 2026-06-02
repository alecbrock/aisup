# Integration Smoke Test — Telemetry & Permission Validation Record

This file accompanies `tests/integration/smoke.test.ts` (plan Task 1). It records the statusline
telemetry fields the supervisor consumes, the availability of cost telemetry, and the
status/procedure for the host-gated Claude permission validation.

## How the smoke test runs

- Guarded by `AISUP_INTEGRATION=1` (suite is skipped otherwise) **and** an actual `tmux` probe on
  a unique per-process socket `aisup-test-<pid>`.
- Every subprocess runs under a throwaway `HOME` with its own `.aisup/config.yaml`, test port,
  api-token, sessions/journal paths, and `session.tmux_socket`.
- The production `aisup` tmux socket is never created, enumerated, attached, or killed. Cleanup
  (`tmux -L aisup-test-<pid> kill-server`) only ever targets the test socket.

```
AISUP_INTEGRATION=1 npx vitest run tests/integration/smoke.test.ts
AISUP_INTEGRATION=1 AISUP_TEST_PERMISSIONS=1 npx vitest run tests/integration/smoke.test.ts
```

## Statusline telemetry fields

Authoritative source: `StatuslineTelemetry` in `src/statusline/types.ts`. The supervisor reads
these from per-account statusline tap files (`config.statusline.directory`).

| Field | Type | Used by |
|-------|------|---------|
| `session_id` | string | telemetry identity (R12), resume |
| `transcript_path` | string | migration, resume eligibility (R3) |
| `rate_limits.five_hour.used_percentage` | number | threshold/failover scoring |
| `rate_limits.five_hour.resets_at` | number (epoch s) | reset ETA |
| `rate_limits.seven_day.used_percentage` | number | threshold/failover scoring |
| `rate_limits.seven_day.resets_at` | number (epoch s) | reset ETA |
| `cwd` | string | telemetry identity (R12) |
| `workspace.project_dir` | string | telemetry identity (R12) |
| `model.id` | string | account/cost reporting |
| `model.display_name` | string | display |
| `context_window.used_percentage` | number | context reporting |
| `context_window.context_window_size` | number | cost/context snapshot (Task 3) |
| `cost.total_cost_usd` | number | cost snapshot/aggregation (Tasks 3–5) |
| `session_name` | string | display |
| `version` | string | diagnostics |

### Observed in the automated smoke run

**None.** The automated `@requires_tmux` flow uses a stub runner (`/bin/sh` running
`tests/fixtures/fake-runner.sh`) so it can exercise the daemon → tmux → session lifecycle and the
socket-isolation contract **without a real Claude**. The stub emits no statusline tap file, so no
live telemetry fields are observed and `cost.total_cost_usd` is **not available** in this mode.

Live telemetry/cost observation requires a real Claude/Pilot runner writing statusline taps and is
covered by the manual `@requires_claude` procedure below.

## `cost.total_cost_usd` availability

- Automated stub run: **not available** (no real runner, no statusline tap).
- Real-runner run: available whenever Claude's statusline includes a `cost.total_cost_usd` value.
  Task 3 extracts it before the `rate_limits` guard and journals upward deltas ≥ `$0.01` only.

## Permission prompt validation (`AISUP_TEST_PERMISSIONS=1`)

**Status in this environment: NOT RUN (skipped).**

**Exact reason:** the `AISUP_TEST_PERMISSIONS=1` path requires (a) a real Claude runner that can be
driven into an interactive permission prompt with **bypass mode disabled**, and (b) the permission
detector + policy + broker, which land in plan Tasks 8–10. This host/CI has no such interactive
runner wired at Task 1 time, so the sub-test is gated behind `AISUP_TEST_PERMISSIONS=1` and remains
`it.skip` in the default and `AISUP_INTEGRATION=1`-only runs. Bypass mode is effectively enabled for
the stub flow (the stub never prompts), so permission output is intentionally not exercised there.

### Manual procedure (run when a real Claude host is available, after Tasks 8–10)

1. Configure an isolated daemon home with a real runner (`runner.command: pilot`) and
   `permissions.enabled: true`, with bypass mode **disabled** so prompts actually appear. Set a
   unique `session.tmux_socket: aisup-test-<pid>`.
2. Start a session and drive Claude to an action that triggers a permission prompt.
3. Assert the detector emits `permission.detected` with the parsed `<tool>:<detail>` request.
4. Send `config.permissions.approval_key` followed by `sendEnter()`; assert the prompt is approved
   (`permission.granted` / `permission.auto_granted`).
5. Repeat for a fresh prompt sending `config.permissions.denial_key` + `sendEnter()`; assert denial
   (`permission.denied` / `permission.auto_denied`) is emitted only after the keystroke.
6. If the active prompt has no safe printable denial key, fall back to `permission.expired` plus a
   Slack/manual instruction (see plan Task 10) instead of claiming denial.
7. Record the observed prompt formats and the approve/deny outcomes here.
