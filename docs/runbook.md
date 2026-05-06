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

The daemon persists `switch_tx` before each switch phase. On restart, it reads `switch_tx` and resumes from the last completed phase. No manual action needed in most cases.

If the source tmux session lingers after daemon crash:
```bash
tmux kill-session -t aisup-<first8-of-session-id>
aisup daemon start    # rehydration handles the rest
```

### Persisted state without tmux

Symptom: `aisup status` shows a session but `tmux list-sessions` shows nothing.

The daemon detects this on startup and runs crash recovery (same-account restart or account switch). If recovery fails, the session enters `EXHAUSTED`.

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

When a target launch fails, aisup records the attempt and retries the next eligible account. If all targets fail after source termination, the session enters `EXHAUSTED`. Check `aisup log` for `runner.launch_failed` events to diagnose.

### Port conflict

Symptom: daemon won't start, port in use.

```bash
aisup doctor    # reports owning PID
lsof -i :<port>
```

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
