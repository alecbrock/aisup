# aisup

AI supervisor daemon for Claude/Pilot coding sessions. Targets multi-account failover, Slack remote control, workflow skill propagation, and session observability. Phase 1 provides the core primitives (session management, account scoring, transcript migration, event journal); full automated failover orchestration and Slack control are in progress for Phase 2.

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
| `aisup log [--limit N]` | Show recent events |
| `aisup accounts` | Show account usage and health |

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
  command: pilot  # or claude
  resume_flag: --resume
slack:
  enabled: false  # set true and configure tokens to enable
daemon:
  port: 7394
```

See `aisup init --dry-run` for the full config template.

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
