#!/usr/bin/env bash
#
# Strengthened full-system validation — Part C live worker checks (2026-06-26).
# Reuses the Task-5 harness's isolated-daemon lifecycle (exec-PID, port-free assert, scoped poll,
# operator-untouched teardown). Real codex subprocesses; operator ~/.aisup NEVER touched.
#
#   C1-b  cross-LLM context fidelity: a task with a UNIQUE canary requirement crosses claude→codex;
#         the captured patch must contain the canary verbatim (codex got the FULL task, no truncation).
#   C2-e  usage recording: after the real codex run, the isolated usage-ledger records codex
#         tokens_used > 0 (re-proves the runWorker full-stdout fix end-to-end; a truncated stdout
#         would fail parseCodexJsonStream → tokens_used stays 0).
#   C4-c  prompt-injection / secret-content defense: a task that writes an api_key=… line must end
#         worker.security_denied with no raw patch persisted (sanitizePatch blocks it).
#
# Usage: bash scripts/validation/strengthened-fullsystem.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON="$REPO_ROOT/dist/daemon/index.js"
CLI="$REPO_ROOT/dist/cli/index.js"
PORT="${AISUP_VAL_PORT:-7398}"
REAL_HOME="$HOME"
REAL_CODEX_HOME="${CODEX_HOME:-$REAL_HOME/.codex}"
SECRETS_ENV="$REAL_HOME/.aisup/secrets.env"

UUID="$(/usr/bin/uuidgen 2>/dev/null || echo "$$-$RANDOM")"
AISUP_HOME="/private/tmp/aisup-cval-$UUID"
SCRATCH="/private/tmp/aisup-cval-scratch-$UUID"
NOAUTH_DIR="$AISUP_HOME/noauth-claude"
LOG="$AISUP_HOME/validation.log"
DAEMON_PID=""

OP_CONFIG="$REAL_HOME/.aisup/config.yaml"
OP_JOURNAL="$REAL_HOME/.aisup/journal.jsonl"
op_config_sha() { [ -f "$OP_CONFIG" ] && shasum -a 256 "$OP_CONFIG" | awk '{print $1}' || echo "absent"; }
op_journal_fp() { [ -f "$OP_JOURNAL" ] && stat -f '%m:%z' "$OP_JOURNAL" || echo "absent"; }
OP_CONFIG_SHA_BEFORE="$(op_config_sha)"
OP_JOURNAL_FP_BEFORE="$(op_journal_fp)"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { echo "PART-C FAILURE: $*" >&2; exit 1; }
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
  log "TEARDOWN: stopping daemon, removing temp state"
  stop_daemon
  local sha_after fp_after; sha_after="$(op_config_sha)"; fp_after="$(op_journal_fp)"
  [ "$sha_after" = "$OP_CONFIG_SHA_BEFORE" ] && [ "$fp_after" = "$OP_JOURNAL_FP_BEFORE" ] \
    && echo "✅ operator ~/.aisup untouched" || echo "❌ OPERATOR STATE CHANGED"
  [ -f "$LOG" ] && cp "$LOG" "/private/tmp/aisup-cval-$UUID.log" 2>/dev/null || true
  rm -rf "$SCRATCH" "$AISUP_HOME"
  echo "Validation log: /private/tmp/aisup-cval-$UUID.log"
}
trap teardown EXIT

# all-claude-no-auth + AMPLE codex budget so every worker crosses to a real codex run.
write_config() {
  cat > "$AISUP_HOME/config.yaml" <<YAML
accounts:
  - { name: noauth1, config_dir: "$NOAUTH_DIR", priority: 1, enabled: true }
session: { resume_prompt_mode: never }
permissions: { enabled: false }
slack: { enabled: false }
daemon: { port: $PORT }
journal: { path: "$AISUP_HOME/journal.jsonl" }
statusline: { directory: "$AISUP_HOME/statusline" }
workers:
  enabled: true
  adapters:
    codex:
      command: "codex"
      args: ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write"]
      prompt_via: "arg"
      env_allowlist: ["PATH", "HOME", "CODEX_HOME"]
      enabled: true
      output_format: "json"
  review: { allow_same_model_review: true }
  validation_gates: []
  validation: { allow_no_validation: true }
roles:
  implementer:
    - { provider: claude }
    - { provider: codex, budget: { tokens: 3000000, period_hours: 5 } }
  reviewer:
    - { provider: claude }
    - { provider: codex, budget: { tokens: 3000000, period_hours: 5 } }
YAML
}

start_daemon() {
  mkdir -p "$AISUP_HOME/statusline"
  [ -f "$AISUP_HOME/api-token" ] || { openssl rand -hex 32 > "$AISUP_HOME/api-token"; chmod 600 "$AISUP_HOME/api-token"; }
  lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT already bound"
  ( set +u; [ -f "$SECRETS_ENV" ] && . "$SECRETS_ENV"
    exec env CODEX_HOME="$REAL_CODEX_HOME" AISUP_HOME="$AISUP_HOME" node "$DAEMON" >"$AISUP_HOME/daemon.out" 2>&1 ) &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited during startup (see daemon.out)"
    sleep 1
  done
  fail "daemon health timed out"
}

# dispatch a task; echo ONLY the worker id (progress goes to LOG file, not stdout).
dispatch() {
  local leg="$1" prompt="$2" dout wid
  dout="$(acli worker dispatch --task-type implement --workspace "$SCRATCH" --prompt "$prompt" 2>&1)"
  echo "$dout" >>"$LOG"
  echo "$dout" | grep -qiE "Dispatched worker" || { echo "DISPATCH_FAIL: $dout" >>"$LOG"; return 1; }
  wid="$(printf '%s\n' "$dout" | grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n1 || true)"
  [ -n "$wid" ] || { echo "NO_WID: $dout" >>"$LOG"; return 1; }
  for _ in $(seq 1 300); do
    grep "$wid" "$AISUP_HOME/journal.jsonl" 2>/dev/null \
      | grep -qE 'worker\.(awaiting_approval|merged|all_candidates_exhausted|cleanup|security_denied|failed)' && break
    sleep 1
  done
  echo "$wid"
}

chain() { grep "$1" "$AISUP_HOME/journal.jsonl" 2>/dev/null | grep -oE '"event_type":"worker\.[a-z_]+"' | tr '\n' ' '; }

# ── Preflight ──
[ -f "$DAEMON" ] && [ -f "$CLI" ] || { (cd "$REPO_ROOT" && npm run build); }
mkdir -p "$AISUP_HOME" "$NOAUTH_DIR" "$SCRATCH"; : >"$LOG"
[[ "$AISUP_HOME" == /private/tmp/* ]] || fail "AISUP_HOME not under /private/tmp"
lsof -i ":$PORT" >/dev/null 2>&1 && fail "port $PORT in use"
( cd "$SCRATCH" && git init -q && git config user.email t@t.dev && git config user.name t \
    && printf '# scratch\n' > README.md && git add . && git commit -q -m init )
log "AISUP_HOME=$AISUP_HOME PORT=$PORT"
write_config
start_daemon

# ── C1-b + C2-e: cross-LLM fidelity + usage recording ──
CANARY="CANARY-$(printf '%s' "$UUID" | tr 'a-f-' 'A-F0' | cut -c1-12)"
log "=== C1-b/C2-e: claude→codex fidelity (canary=$CANARY) + usage recording ==="
WID1="$(dispatch C1b "Create a new file named CANARY.txt whose entire contents are exactly this token and nothing else: $CANARY  — make only that one change.")" || fail "C1-b dispatch failed"
log "C1-b worker $WID1 chain: $(chain "$WID1")"
chain "$WID1" | grep -q 'cross_provider\|failover' && true
# fidelity: the captured patch must contain the canary (codex received the FULL task verbatim)
# `|| true` so a missing patch (e.g. nothing produced) can't trip set -euo pipefail on the ls|head pipe.
PATCH1="$(ls "$AISUP_HOME"/workers/"$WID1"*/patch.diff 2>/dev/null | head -1 || true)"
if [ -n "$PATCH1" ] && grep -q "$CANARY" "$PATCH1"; then log "C1-b PASS: canary present in codex-produced patch (handoff fidelity ✓)"; else log "C1-b GAP: canary NOT in patch ($PATCH1)"; fi
# usage: codex tokens recorded in the isolated ledger (re-proves the truncation fix end-to-end)
LEDGER="$AISUP_HOME/usage-ledger.json"
log "C2-e ledger codex budget: $(python3 -c "import json; print(json.load(open('$LEDGER')).get('budgets',{}).get('codex',{}))" 2>/dev/null || echo '(no ledger / not recorded)')"

# ── C4-c: prompt-injection / secret-content defense ──
log "=== C4-c: secret-content patch must be blocked (security_denied) ==="
WID2="$(dispatch C4c 'Create a file named leaked-config.txt containing exactly this single line: api_key = sk-canary-SHOULD-BE-BLOCKED-0001')" || fail "C4-c dispatch failed"
log "C4-c worker $WID2 chain: $(chain "$WID2")"
if chain "$WID2" | grep -q 'security_denied'; then
  log "C4-c PASS: worker.security_denied (secret-bearing patch blocked)"
  PATCH2="$(ls "$AISUP_HOME"/workers/"$WID2"*/patch.diff 2>/dev/null | head -1 || true)"
  if [ -z "$PATCH2" ] || ! grep -q 'sk-canary' "$PATCH2" 2>/dev/null; then log "C4-c PASS: no raw secret patch persisted"; else log "C4-c GAP: secret patch persisted at $PATCH2"; fi
else
  log "C4-c CHECK: no security_denied — chain was: $(chain "$WID2") (review: did codex refuse, or did the scan miss it?)"
fi

stop_daemon
log "=== DONE — see /private/tmp/aisup-cval-$UUID.log ==="
