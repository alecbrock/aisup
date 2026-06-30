#!/usr/bin/env bash
#
# Live lead-session + Slack validation (Feature E) — the half NOT exercised by the worker harnesses.
# Stands up a REAL isolated daemon with Slack ENABLED (operator tokens), starts a REAL supervised
# claude lead session against a /private/tmp scratch repo, and confirms a REAL Slack channel is
# created + the session-info post fires. Operator ~/.aisup is NEVER touched.
#
# Real spend: a real claude lead session launches. Teardown stops the session (posts the stop
# message) + daemon; the created Slack channel persists for the operator to see.
#
# Usage: bash scripts/validation/lead-session-slack.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON="$REPO_ROOT/dist/daemon/index.js"
CLI="$REPO_ROOT/dist/cli/index.js"
PORT="${AISUP_VAL_PORT:-7399}"
REAL_HOME="$HOME"
REAL_CODEX_HOME="${CODEX_HOME:-$REAL_HOME/.codex}"
SECRETS_ENV="$REAL_HOME/.aisup/secrets.env"
AUTHED1="${AISUP_VAL_AUTHED_DIR:-$REAL_HOME/.claude-account2}"
AUTHED2="$REAL_HOME/.claude-account3"
ALLOWED_USER="${AISUP_VAL_SLACK_USER:-U0BB4624YN5}"

UUID="$(/usr/bin/uuidgen 2>/dev/null || echo "$$-$RANDOM")"
AISUP_HOME="/private/tmp/aisup-lead-$UUID"
SCRATCH="/private/tmp/aisup-lead-scratch-$UUID"
LOG="$AISUP_HOME/validation.log"
DAEMON_PID=""

OP_CONFIG="$REAL_HOME/.aisup/config.yaml"; OP_JOURNAL="$REAL_HOME/.aisup/journal.jsonl"
op_config_sha() { [ -f "$OP_CONFIG" ] && shasum -a 256 "$OP_CONFIG" | awk '{print $1}' || echo absent; }
op_journal_fp() { [ -f "$OP_JOURNAL" ] && stat -f '%m:%z' "$OP_JOURNAL" || echo absent; }
OP_C0="$(op_config_sha)"; OP_J0="$(op_journal_fp)"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { echo "LEAD-SESSION FAILURE: $*" >&2; exit 1; }
acli() { AISUP_HOME="$AISUP_HOME" node "$CLI" "$@"; }

stop_daemon() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  for _ in $(seq 1 40); do lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
  DAEMON_PID=""
}

teardown() {
  set +e
  log "TEARDOWN: stopping lead session + daemon (Slack channel persists for review)"
  acli stop --force >/dev/null 2>&1 || true
  stop_daemon
  local c1 j1; c1="$(op_config_sha)"; j1="$(op_journal_fp)"
  [ "$c1" = "$OP_C0" ] && [ "$j1" = "$OP_J0" ] && echo "✅ operator ~/.aisup untouched" || echo "❌ OPERATOR STATE CHANGED"
  [ -f "$LOG" ] && cp "$LOG" "/private/tmp/aisup-lead-$UUID.log" 2>/dev/null || true
  rm -rf "$SCRATCH" "$AISUP_HOME"
  echo "Log: /private/tmp/aisup-lead-$UUID.log"
}
trap teardown EXIT

[ -f "$DAEMON" ] && [ -f "$CLI" ] || { (cd "$REPO_ROOT" && npm run build); }
mkdir -p "$AISUP_HOME/statusline" "$SCRATCH"; : >"$LOG"
[[ "$AISUP_HOME" == /private/tmp/* ]] || fail "AISUP_HOME not under /private/tmp"
lsof -i ":$PORT" >/dev/null 2>&1 && fail "port $PORT in use"
[ -d "$AUTHED1" ] || fail "authed account not found: $AUTHED1"
[ -f "$SECRETS_ENV" ] || fail "secrets.env (Slack tokens) not found: $SECRETS_ENV"
# clear any orphan tmux that would block a fresh start ("STOPPED but live tmux exists")
for s in $(tmux -L aisup ls 2>/dev/null | awk -F: '{print $1}'); do tmux -L aisup kill-session -t "$s" 2>/dev/null || true; done

( cd "$SCRATCH" && git init -q && git config user.email t@t.dev && git config user.name t \
    && printf '# scratch\n' > README.md && git add . && git commit -q -m init )

cat > "$AISUP_HOME/config.yaml" <<YAML
accounts:
  - { name: account2, config_dir: "$AUTHED1", priority: 1, enabled: true }
  - { name: account3, config_dir: "$AUTHED2", priority: 2, enabled: true }
slack:
  enabled: true
  bot_token_env: "AISUP_SLACK_BOT_TOKEN"
  app_token_env: "AISUP_SLACK_APP_TOKEN"
  allowed_user_ids: ["$ALLOWED_USER"]
  relay_output_enabled: true
daemon: { port: $PORT }
journal: { path: "$AISUP_HOME/journal.jsonl" }
statusline: { directory: "$AISUP_HOME/statusline" }
YAML

[ -f "$AISUP_HOME/api-token" ] || { openssl rand -hex 32 > "$AISUP_HOME/api-token"; chmod 600 "$AISUP_HOME/api-token"; }
log "AISUP_HOME=$AISUP_HOME PORT=$PORT authed=$AUTHED1"
( set +u; . "$SECRETS_ENV"
  exec env CODEX_HOME="$REAL_CODEX_HOME" AISUP_HOME="$AISUP_HOME" node "$DAEMON" >"$AISUP_HOME/daemon.out" 2>&1 ) &
DAEMON_PID=$!
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon died on startup (see daemon.out)"; sleep 1; done
log "daemon up; starting REAL lead session…"

START_OUT="$(acli start --cwd "$SCRATCH" 2>&1)"; echo "$START_OUT" >>"$LOG"
log "acli start → $START_OUT"

# Poll the isolated journal for the Slack channel creation + session lifecycle (up to 90s).
CHAN=""
for _ in $(seq 1 90); do
  if grep -q 'slack.channel_created' "$AISUP_HOME/journal.jsonl" 2>/dev/null; then
    CHAN="$(grep 'slack.channel_created' "$AISUP_HOME/journal.jsonl" | grep -oE '"channel[_a-z]*":"[^"]+"' | head -1)"
    break
  fi
  grep -q 'session.started\|session.active' "$AISUP_HOME/journal.jsonl" 2>/dev/null && true
  sleep 1
done

log "=== lead-session journal events ==="
grep -oE '"event_type":"(session|slack|telemetry)\.[a-z_]+"' "$AISUP_HOME/journal.jsonl" 2>/dev/null | sort | uniq -c | tee -a "$LOG" || true
echo "--- slack event details ---" | tee -a "$LOG"
grep 'slack\.' "$AISUP_HOME/journal.jsonl" 2>/dev/null | grep -oE '"event_type":"slack\.[a-z_]+"|"channel[_a-z]*":"[^"]+"|"error":"[^"]+"' | tee -a "$LOG" || true

if [ -n "$CHAN" ]; then
  log "E PASS: Slack channel created → $CHAN"
  grep -q 'slack.session_info\|Supervised session started\|session_info_posted' "$AISUP_HOME/journal.jsonl" 2>/dev/null \
    && log "E PASS: session-info post fired" || log "E NOTE: no explicit session-info-post event (check slack events above)"
else
  log "E GAP: no slack.channel_created within 90s — daemon.out tail follows for diagnosis:"
  tail -25 "$AISUP_HOME/daemon.out" 2>/dev/null | tee -a "$LOG" || true
fi
log "=== DONE — channel (if created) persists; see /private/tmp/aisup-lead-$UUID.log ==="
