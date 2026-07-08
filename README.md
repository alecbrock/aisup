# aisup

AI supervisor daemon for Claude/Pilot coding sessions: multi-account failover, Slack remote control, workflow skill propagation, and session observability. Phases 1–3 are implemented — session management, account scoring/selection, reactive + proactive failover, transcript migration, event journal, Slack remote control, the permission broker, validation gates, cost tracking, and multi-LLM workers (isolated git worktrees with cross-model review and a human-approved merge), including account-first → cross-LLM worker failover (Part B). The HTTP mobile dashboard (Phase 4) is the remaining roadmap item.

## Prerequisites

- Node.js ≥22
- tmux ≥3.2
- `pilot` or `claude` CLI on PATH
- Two or more Claude account config directories (e.g. `~/.claude`, `~/.claude-account2`)
- (Optional) Slack app with Socket Mode for remote control

## Install

```bash
git clone https://github.com/yourorg/aisup
cd aisup
npm install
npm run build   # produces dist/
```

Or run from source with tsx:

```bash
alias aisup='node --import tsx/esm src/cli/index.ts'
```

## Quick Start

```bash
# 1. Generate default config
aisup init

# 2. Edit ~/.aisup/config.yaml — add your account config dirs

# 3. Validate prerequisites
aisup doctor

# 4. Start the daemon
aisup daemon start

# 5. Start a supervised session in your project
aisup start --cwd /path/to/project

# 6. Attach to the session
aisup attach

# 7. Check status
aisup status
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `aisup init [--dry-run] [--force]` | Generate default config |
| `aisup doctor` | Validate prerequisites |
| `aisup daemon start` | Start daemon in background |
| `aisup daemon stop` | Stop daemon |
| `aisup start [--cwd PATH] [--plan PATH] [--dry-run]` | Start supervised session |
| `aisup stop [--force]` | Stop current session |
| `aisup attach` | Attach to active tmux session |
| `aisup status` | Show daemon and session status |
| `aisup failover --to ACCOUNT` | Manual account failover |
| `aisup health` / `aisup watch` | Unified live snapshot (session, accounts, workers, cost, events); `watch` auto-refreshes |
| `aisup pause` / `aisup resume` | Pause/resume the active session (SIGSTOP/SIGCONT its runner) to save headroom |
| `aisup log [--limit N] [--type T] [--account A] [--session S] [--since ISO] [--details]` | Show/filter recent events; `--details` shows failover rationale |
| `aisup explain <event_type>` | Explain what a journal event type means |
| `aisup session timeline [id]` / `aisup session rename <id> <name>` | Ordered session lifecycle / label a session (also `start --name`) |
| `aisup accounts [--pin\|--exclude\|--enable\|--disable <name>\|--clear]` | Show accounts, or apply a runtime override (no restart) |
| `aisup cost [--by account\|skill\|provider\|task]` | Cost windows, or a dimensional breakdown |
| `aisup daemon reload` | Hot-reload config (thresholds/verbosity/accounts) without dropping the session |
| `aisup worker retry\|undo\|cleanup [--force]` · `aisup worker logs <id> [--follow]` | Retry a failed worker / revert a merge / clean orphan worktrees / stream live output |

**Control vs observe:** interactive control (approve permissions, drive workers, pause/failover) lives in **Slack**; the read-only `/dashboard` is **observe-only**. See "Slack control & dashboard" below.

## Config Reference (`~/.aisup/config.yaml`)

```yaml
accounts:
  - name: primary
    config_dir: ~/.claude
    priority: 1
thresholds:
  soft_pct: 85    # switch at idle when usage reaches this
  hard_pct: 95    # interrupt and switch immediately
runner:
  command: claude  # launches Claude Code (Pilot Shell hooks load automatically); set to another CLI to detach
  resume_flag: --resume
slack:
  enabled: false  # set true and configure tokens to enable
daemon:
  port: 7394
```

See `aisup init --dry-run` for the full config template.

## Slack control & dashboard

aisup separates **control** from **observe**:

- **Control (Slack, interactive):** with `slack.enabled: true` and the Slack app's **Interactivity** toggle ON, Claude's permission requests post as Block Kit cards with Approve / Approve-for-session / Deny buttons — no `!permit` typing, and they never time out. Worker approvals, `!pause`/`!resume`, `!account …`, `!worker …`, and a live activity feed are also driven from Slack. Optional `notifications.ntfy` mirrors key push events to an ntfy topic (notification-only).
- **Observe (dashboard, read-only):** `http://127.0.0.1:<daemon.port>/dashboard` is a token-authed, auto-refreshing HTML page showing the active session, per-account headroom, worker queue, cost-today, and recent events. Paste the daemon token once (it is exchanged in-page for a short-lived read-only cookie — **never placed in a URL**); the dashboard cannot reach any control route. Remote access is the operator's tunnel choice.

Enable Slack interactivity and review the never-expire permission behavior in `docs/runbook.md`.

## Security

- API token stored at `~/.aisup/api-token` (mode 0600)
- All API routes require `Authorization: Bearer <token>`
- HTTP server binds to `127.0.0.1` only
- `!cmd` in Slack relays input to the session — review `bypassPermissions` risk before enabling
- Output relay to Slack uses best-effort redaction — do not rely on it for secrets
- See `docs/runbook.md` for full security guidance

## Tests

```bash
npm test                          # all tests
npx vitest run tests/config/      # config only
npx vitest run tests/session/     # requires tmux
```
