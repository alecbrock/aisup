# aisup Operator Runbook

## Initial Setup

### 1. Install aisup

```bash
cd ~/Projects/aisup && npm install && npm run build
# Add to PATH or alias:
alias aisup='node --import tsx/esm /path/to/aisup/src/cli/index.ts'
```

### 2. Generate config

```bash
aisup init                     # creates ~/.aisup/config.yaml and ~/.aisup/api-token
aisup init --dry-run           # preview without writing
aisup init --force             # overwrite existing config
```

Edit `~/.aisup/config.yaml` — set your account config dirs and thresholds.

**After any config change, restart the daemon:**
```bash
aisup daemon stop && aisup daemon start
```

### 3. Validate

```bash
aisup doctor    # exits non-zero if any required check fails
```

---

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.
2. Enable **Socket Mode** (Basic Information → Socket Mode).
3. Create an App-Level Token with scope `connections:write` — copy as `AISUP_SLACK_APP_TOKEN`.
4. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `chat:write`, `groups:write`, `groups:history`, `users:read`
5. Under **Event Subscriptions**, enable and subscribe to **`message.groups`**.
   - **This is mandatory.** Without it the bot connects but never receives messages in private channels.
6. Install the app to your workspace. Copy the Bot Token (`xoxb-...`) as `AISUP_SLACK_BOT_TOKEN`.
7. Set env vars and enable Slack in config:

```bash
export AISUP_SLACK_BOT_TOKEN=xoxb-...
export AISUP_SLACK_APP_TOKEN=xapp-...
```

```yaml
# ~/.aisup/config.yaml
slack:
  enabled: true
  bot_token_env: AISUP_SLACK_BOT_TOKEN
  app_token_env: AISUP_SLACK_APP_TOKEN
  allowed_user_ids: [U1234567890]   # your Slack user ID
```

---

## Security Warnings

### `!cmd` + bypassPermissions

When Claude/Pilot runs with `bypassPermissions: true`, `!cmd <text>` relayed from Slack executes directly with no confirmation gate (unless `cmd_require_confirmation: true`, the default). Any Slack user in `allowed_user_ids` can trigger local file system operations from their phone. Only add trusted users.

### Output relay to Slack

`slack.relay_output_enabled: true` posts terminal output to a Slack channel. Redaction is best-effort — it matches known patterns but cannot prevent all secrets from appearing. Slack channels have retention and logging. **Default is `false`.** Enable only if you accept the risk.

### File permissions

- `~/.aisup/` created with mode `0700`
- `~/.aisup/api-token` created with mode `0600`
- Session state files created with mode `0600`
- Journal created with mode `0600`

---

## Multi-Account Setup

```yaml
accounts:
  - name: primary
    config_dir: ~/.claude
    priority: 1
  - name: work
    config_dir: ~/.claude-work
    priority: 2
  - name: backup
    config_dir: ~/.claude-backup
    priority: 3
```

Lower `priority` = preferred when scores are equal. Accounts with more headroom score higher regardless of priority.

---

## Recovery Procedures

### Stale PID file

Symptom: `aisup daemon start` reports "daemon already running" but no daemon responds.

```bash
rm ~/.aisup/daemon.pid    # remove stale PID file
aisup daemon start
```

Or simply run `aisup daemon start` — it detects stale PIDs automatically.

### Daemon crash during switch

The daemon persists `switch_tx` before each switch phase. On restart, it detects interrupted switch transactions and logs them as `recovery.failed`. **Note:** automatic switch-transaction resumption is not yet implemented — interrupted switches require manual intervention via `aisup failover --to <account>` or `aisup stop && aisup start`.

If the source tmux session lingers after daemon crash:
```bash
tmux kill-session -t aisup-<first8-of-session-id>
aisup daemon start    # rehydration handles the rest
```

### Persisted state without tmux

Symptom: `aisup status` shows a session but `tmux list-sessions` shows nothing.

The daemon detects this on startup and logs a `session.destroyed_externally` event. **Note:** automatic crash recovery (same-account restart or account switch) is not yet implemented — use `aisup start` to create a new session manually.

### EXHAUSTED state

Symptom: `aisup status` shows `EXHAUSTED`.

Recovery options:
1. **Resume on specific account:** `aisup failover --to <account>`
2. **Discard and start fresh:** `aisup stop && aisup start`

### STOPPED with live tmux (inconsistent)

Symptom: `aisup start` rejects with "inconsistent/orphaned".

```bash
aisup stop --force    # or:
tmux kill-session -t aisup-<session-id>
aisup start --cwd /path/to/project
```

### Failed switch target

When a target launch fails during `performSwitch`, aisup records the attempt and retries the next eligible account (for automatic switches). If all targets fail after source termination, the switch returns `exhausted` status. Check `aisup log` for `runner.launch_failed` events to diagnose. **Note:** automatic switch-triggered retries from daemon monitoring loops are not yet wired — manual failover via `aisup failover --to <account>` is the current path.

### Port conflict

Symptom: daemon won't start, port in use.

```bash
aisup doctor    # reports owning PID
lsof -i :<port>
```

---

## Multi-LLM Workers (Phase 3)

A **worker** runs a bounded coding task with an LLM CLI (Codex / Gemini / local) inside an isolated
detached git worktree, validates the output diff with the gate engine, has a **different** model
review it, and — only after **explicit user approval** — applies the diff to the main workspace as a
working-tree patch. aisup never auto-commits and never auto-merges.

### Enabling workers

Workers are **off by default**. Add a `workers` section to `~/.aisup/config.yaml`:

```yaml
workers:
  enabled: true
  workspace_root: null            # null ⇒ resolved at dispatch: --workspace > this > active lead session cwd
  worktree_dir: ".aisup-workers"  # relative to workspace_root; MUST be gitignored
  max_concurrent: 2
  retention:
    keep_merged: false            # remove worktree after merge
    keep_rejected: true           # keep rejected/failed worktrees for inspection
    max_age_hours: 168
  security:
    env_allowlist: ["PATH", "HOME", "LANG"]   # effective allowlist = union(this, adapter.env_allowlist)
    boundary_audit: true          # MUST be true
    forbidden_path_globs:
      - "**/.claude/settings.local.json"
      - "**/.claude/transcripts/**"
      - "**/*.jsonl"
      - "**/*.tmux-capture"
      - "**/*.pem"
      - "**/.env"
      - "**/.env.*"
  adapters:
    codex:  { command: "codex",  args: [], prompt_via: "arg",   enabled: false }
    gemini: { command: "gemini", args: [], prompt_via: "arg",   enabled: false }
    local:  { command: "",       args: [], prompt_via: "stdin", enabled: false }
  routing:
    default_implementer: "codex"
    default_reviewer: "gemini"
    by_task_type: {}              # e.g. { bugfix: { implementer: codex, reviewer: gemini } }
  review:
    allow_same_model_review: false  # the ONLY review knob; parse failure ALWAYS rejects (fail-closed)
  validation_gates:               # GateCommandConfig[] run with cwd=worktree; each gate's cwd MUST be null
    - { name: typecheck, command: "npm", args: ["run", "typecheck"], timeout_seconds: 120, required: true, cwd: null }
  validation:
    allow_no_validation: false    # fail-CLOSED: with no REQUIRED gate, validation FAILS (no zero-check merge)
  merge:
    require_approval: true        # MUST be true — no auto-merge
    apply_check_required: true
```

- The adapter `codex`/`gemini`/`local` presets ship **disabled** with conservative defaults and
  **no invented CLI flags** — set `command`/`args`/`prompt_via` to match your installed CLI version.
- `.aisup-workers/` must be gitignored (it is in this repo's `.gitignore`); the loader warns if not.
- With `workers.enabled: true` you must have ≥1 enabled adapter, a `default_implementer` that resolves
  to an **enabled** adapter, and (unless `validation.allow_no_validation: true`) ≥1 `required`
  validation gate — otherwise the config is rejected.

### Operating workers

Worker execution lives in the daemon; the CLI talks to it over the localhost API.

```bash
aisup worker dispatch --task-type implement --prompt "add a retry to fetchUser" --workspace ~/proj
aisup worker dispatch --prompt @task.md            # load the prompt from a file
aisup worker list
aisup worker providers                              # per-role provider availability (claude headroom, codex budget)
aisup worker status <id>                            # status, changed files, gates, review, approval
aisup worker review <id>                            # cross-model review verdict (read-only)
aisup worker logs <id>                              # sanitized stdout/stderr tails + artifact paths
aisup worker approve <id>                           # apply the patch to the main workspace
aisup worker deny <id>
aisup worker cancel <id>
```

`dispatch` returns immediately (`202`/`QUEUED`); the pipeline runs in the background and pauses at
`AWAITING_APPROVAL`. Lifecycle:
`QUEUED → RUNNING → IMPLEMENTED → VALIDATING → REVIEWING → AWAITING_APPROVAL → MERGING → MERGED`
(terminal: `MERGED`/`FAILED`/`REJECTED`/`CANCELLED`).

**Where approval lives:** worker approval is available via the CLI (`aisup worker approve <id>`) and
the daemon HTTP API (localhost, `config.daemon.port`, default `7394`). Slack offers the same actions
as **subcommands**: `!worker status`, `!worker approve <id>`, `!worker deny <id>` (bare `!deny`
remains the permission-denial command — it is not overloaded). Because approving applies a patch to
the workspace, `!worker approve <id>`/`!worker deny <id>` are **two-step**: the request is staged and
you must reply `!confirm` within 60s (same `ConfirmationStore` gate as `!stop`).

### Security boundary (state precisely)

The enforceable guarantees are:
1. **Only the worktree git diff is ever a merge candidate** — a write anywhere else can never reach
   the main workspace through merge (structural diff-scoping).
2. **Main-workspace and configured forbidden-path changes are detected** by the boundary audit —
   ignored-aware `git status --porcelain --ignored` plus a content-hash snapshot that also catches
   **content changes to pre-existing ignored files** (e.g. an existing `.env`).
3. **Trusted-CLI `$HOME` writes are redirected** into a per-task throwaway `HOME` inside the worktree
   (`.home/`), which is excluded from the diff.

**Accepted residual:** an arbitrary absolute-path write **outside `workspace_root` and outside the
temp HOME** (e.g. `/tmp`, `/etc`) is **neither prevented nor detected** in Phase 3 — the audit only
snapshots the workspace tree and the configured forbidden-path set. The structural diff-scoping still
guarantees such writes never reach the merge candidate. OS sandboxing (`sandbox-exec`) is the named
deferred hardening. Threat model: accidental escape by a CLI the operator already trusts — not an
adversarial binary.

Merge applies a **working-tree patch only** (`git apply` after `git apply --check`); aisup never runs
`add`/`commit`/`push`/`reset`/`clean`/`branch` against the main workspace. The sole automatic
`git add` is the worktree-local `add -A -N` intent-to-add (isolated worktree only). Approval is
required for **every** merge — after an apply conflict or a patch-artifact hash mismatch, approval is
reset and a fresh approval is required before any retry.

### Operability notes

- **Fresh-worktree deps:** validation gates run in a clean nested worktree with no installed deps.
  Node gates resolve the parent repo's `node_modules` via upward lookup (the worktree is nested under
  `workspace_root`); other ecosystems (pnpm/Yarn-PnP, Python venv, Go) must self-provision in the
  gate command.
- **Large patches:** reviewer adapters should prefer `prompt_via: stdin` or `file` over a positional
  `arg` so a large diff cannot exceed `ARG_MAX`/`E2BIG`.
- **Committed base:** workers branch from the committed `base_ref` (default `HEAD`) resolved to an
  immutable `base_sha`, so uncommitted main-tree edits are not seen by the worker and advancing the
  source branch after dispatch does not change the applied result.
- **Host-gated tests:** real provider CLIs are exercised only behind host gates
  (`AISUP_TEST_CODEX=1` / `AISUP_TEST_GEMINI=1` / `AISUP_TEST_LOCAL_LLM=1`); the always-run
  deterministic suite uses fake `node -e` adapters. See `tests/integration/WORKER_HOST_GATES.md`.

---

## Live Gate Execution Checklist

Operator checklist for full MVP validation (run after automated tests pass):

- [ ] Gate 1: `aisup doctor` — all green
- [ ] Gate 2: `aisup start --cwd <project>` — Pilot launches in tmux, pipe-pane log captures output
- [ ] Gate 3: `aisup start --dry-run` — correct account selected based on telemetry
- [ ] Gate 4: `aisup failover --to <account>` — transcript copied, resumed with `--resume`
- [ ] Gate 4b: failover before telemetry hydrated → `launch_mode: fresh` in response
- [ ] Gate 5: /spec across failover — plan state and skill persist in resumed session
- [ ] Gate 6: Slack `!status`, `!cmd`, user auth blocking
- [ ] Gate 7: daemon restart → session rehydrated, pipe-pane restored
- [ ] Gate 8: echo 429 pattern via fake-runner → daemon triggers failover
- [ ] Gate 9: 3 recovery failures → circuit breaker trips, `circuit_breaker.tripped` in journal

---

## Troubleshooting

### Pipe-pane not capturing output

1. Check `aisup status` — `output_log_path` should exist
2. Run `aisup doctor` — verifies tmux ≥3.2 and `#{pane_pipe}` support
3. Tail the log: `tail -f ~/.aisup/sessions/<id>/output.log`

### Auth issues (401 from daemon)

- Token at `~/.aisup/api-token` — regenerate with `aisup init --force`
- Restart daemon after regeneration

### Statusline telemetry not hydrating

- Verify `/tmp/pilot-failover/` contains `statusline-<uuid>.json` files
- Verify the `transcript_path` in the JSON starts with your account's config dir
- `aisup log` — check for `telemetry.session_mismatch` events

### Config changes not taking effect

aisup does not hot-reload config. Restart the daemon:
```bash
aisup daemon stop && aisup daemon start
```
