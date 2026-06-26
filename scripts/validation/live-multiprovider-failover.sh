#!/usr/bin/env bash
#
# Live, fully-real, no-mocks validation of Worker Multi-Provider Failover (Part B, Task 5).
#
# Stands up a REAL aisup daemon under an isolated AISUP_HOME, runs REAL `aisup worker dispatch`
# against a throwaway /private/tmp scratch repo, and forces every *reachable* failover leg for real,
# capturing the isolated journal + `worker providers` + Slack evidence into a validation log. The
# operator's real ~/.aisup is NEVER read or written (asserted: real config.yaml sha256 + journal.jsonl
# mtime/size unchanged across the run; the entire temp AISUP_HOME is removed in teardown).
#
# ⛔ DESIGN NOTES (read before running):
#   • Forcing a claude candidate to FAIL: a "no-auth" account whose config_dir is an EMPTY temp dir.
#     `claude -p` there prints "Not logged in · Please run /login" and exits non-zero → the worker
#     failover engine classifies it `auth_failed` (failover-worthy) → fails over. VERIFIED 2026-06-25
#     that an empty CLAUDE_CONFIG_DIR fails even under the Option-C real-HOME/keychain auth.
#   • Per-leg config matrix (ME-001): the three legs need MUTUALLY-EXCLUSIVE account/budget states,
#     so each leg runs as its OWN short daemon lifecycle (stop → rewrite config under the SAME
#     isolated AISUP_HOME → restart → preflight → dispatch). Dispatch uses NO --implementer/--reviewer
#     (those PIN a single candidate with no failover); failover is driven by config.roles + account state.
#   • HI-001 determinism: a fresh isolated ledger + an isolated statusline.directory (no shared
#     /tmp/pilot-failover telemetry) ⇒ all accounts report `unknown` basis ⇒ the selector preserves
#     CONFIG ORDER, so the no-auth account listed FIRST is the first-tried (and first-failed) candidate.
#   • claude OAuth is in the macOS Keychain (real HOME) and codex auth is ~/.codex via CODEX_HOME — the
#     daemon below is started with the real environment (secrets.env) + CODEX_HOME exported. Account
#     config_dir values are ABSOLUTE real paths so real auth works regardless of HOME.
#
# Usage:  bash scripts/validation/live-multiprovider-failover.sh
# Requires: a logged-in real Claude account (REAL_AUTHED_CONFIG_DIR below), `claude` + `codex` on PATH,
#           codex ChatGPT auth in ~/.codex, ~/.aisup/secrets.env (Slack tokens), tmux, a free PORT.

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON="$REPO_ROOT/dist/daemon/index.js"
CLI="$REPO_ROOT/dist/cli/index.js"
PORT="${AISUP_VAL_PORT:-7397}"                 # non-default (operator default is 7394)
REAL_HOME="$HOME"
REAL_CODEX_HOME="${CODEX_HOME:-$REAL_HOME/.codex}"
SECRETS_ENV="$REAL_HOME/.aisup/secrets.env"
# A KNOWN-AUTHED real Claude account for the winning candidate in Leg A (primary may be 401 — use a
# logged-in account). Override with AISUP_VAL_AUTHED_DIR=… if needed.
REAL_AUTHED_CONFIG_DIR="${AISUP_VAL_AUTHED_DIR:-$REAL_HOME/.claude-account2}"

UUID="$(/usr/bin/uuidgen 2>/dev/null || echo "$$-$RANDOM")"
AISUP_HOME="/private/tmp/aisup-val-$UUID"
SCRATCH="/private/tmp/aisup-val-scratch-$UUID"
NOAUTH_DIR="$AISUP_HOME/noauth-claude"          # empty → forces auth_failed
LOG="$AISUP_HOME/validation.log"
DAEMON_PID=""

# ── Operator-state safety snapshot ──────────────────────────────────────────────────────────────
OP_CONFIG="$REAL_HOME/.aisup/config.yaml"
OP_JOURNAL="$REAL_HOME/.aisup/journal.jsonl"
op_config_sha() { [ -f "$OP_CONFIG" ] && shasum -a 256 "$OP_CONFIG" | awk '{print $1}' || echo "absent"; }
op_journal_fp() { [ -f "$OP_JOURNAL" ] && stat -f '%m:%z' "$OP_JOURNAL" || echo "absent"; }
OP_CONFIG_SHA_BEFORE="$(op_config_sha)"
OP_JOURNAL_FP_BEFORE="$(op_journal_fp)"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { echo "PREFLIGHT/RUN FAILURE: $*" >&2; exit 1; }

acli() { AISUP_HOME="$AISUP_HOME" node "$CLI" "$@"; }   # CLI against the isolated state dir

stop_daemon() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  # Wait for the listener to actually release :PORT so the next leg binds a genuinely FRESH daemon
  # rather than colliding with (and silently deferring to) a not-yet-dead one.
  for _ in $(seq 1 40); do lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
  DAEMON_PID=""
}

teardown() {
  set +e
  log "TEARDOWN: stopping session + daemon, removing temp state"
  acli stop --force >/dev/null 2>&1 || true
  stop_daemon
  # ⛔ Operator-state invariants — never touched.
  local sha_after fp_after; sha_after="$(op_config_sha)"; fp_after="$(op_journal_fp)"
  if [ "$sha_after" != "$OP_CONFIG_SHA_BEFORE" ]; then echo "❌ OPERATOR config.yaml CHANGED ($OP_CONFIG_SHA_BEFORE → $sha_after)"; fi
  if [ "$fp_after" != "$OP_JOURNAL_FP_BEFORE" ]; then echo "❌ OPERATOR journal.jsonl CHANGED ($OP_JOURNAL_FP_BEFORE → $fp_after)"; fi
  [ "$sha_after" = "$OP_CONFIG_SHA_BEFORE" ] && [ "$fp_after" = "$OP_JOURNAL_FP_BEFORE" ] && echo "✅ operator ~/.aisup untouched (config sha + journal mtime/size unchanged)"
  # Preserve the validation log outside AISUP_HOME before removing it.
  [ -f "$LOG" ] && cp "$LOG" "/private/tmp/aisup-val-$UUID.log" 2>/dev/null || true
  rm -rf "$SCRATCH" "$AISUP_HOME"
  echo "Validation log saved at /private/tmp/aisup-val-$UUID.log"
}
trap teardown EXIT

# ── Throwaway config writer (per-leg account/budget matrix) ─────────────────────────────────────
# $1 = accounts YAML block; $2 = codex budget tokens; $3 = codex budget period_hours
write_config() {
  local accounts_block="$1" budget_tokens="$2" budget_hours="$3"
  cat > "$AISUP_HOME/config.yaml" <<YAML
$accounts_block
session:
  resume_prompt_mode: never
permissions:
  enabled: false
slack:
  enabled: true
  bot_token_env: "AISUP_SLACK_BOT_TOKEN"
  app_token_env: "AISUP_SLACK_APP_TOKEN"
  allowed_user_ids: ["U0BB4624YN5"]
daemon:
  port: $PORT
# journal.path + statusline.directory set EXPLICITLY under AISUP_HOME (CR-001 belt-and-suspenders /
# HI-001 — the isolated daemon never reads the operator's shared /tmp/pilot-failover telemetry).
journal:
  path: "$AISUP_HOME/journal.jsonl"
statusline:
  directory: "$AISUP_HOME/statusline"
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
  review:
    allow_same_model_review: true
  validation_gates: []
  validation:
    allow_no_validation: true
roles:
  implementer:
    - { provider: claude }
    - { provider: codex, budget: { tokens: $budget_tokens, period_hours: $budget_hours } }
  reviewer:
    - { provider: claude }
    - { provider: codex, budget: { tokens: $budget_tokens, period_hours: $budget_hours } }
YAML
}

start_daemon() {
  mkdir -p "$AISUP_HOME/statusline"
  # api-token: the daemon's HTTP API + every CLI command (start/dispatch/providers) authenticate with
  # this shared 0600 bearer token. It is normally written by `aisup init` (randomBytes(32).hex), which
  # this harness skips — so generate it once here (reused across legs). Without it, the daemon rejects
  # every authed request and each CLI command ENOENTs → "Daemon not running" (the Leg-A silent failure).
  # The daemon writes its hook-settings to AISUP_HOME/claude-hooks.json (isolated; no operator-dir edits).
  [ -f "$AISUP_HOME/api-token" ] || { openssl rand -hex 32 > "$AISUP_HOME/api-token"; chmod 600 "$AISUP_HOME/api-token"; }
  # ⛔ Port MUST be free here — else a stale ORPHANED daemon silently serves this leg with the PREVIOUS
  # leg's config + carried-over reactive state (the run-2 bug: stop_daemon killed the wrapper subshell,
  # not node, so the Leg-A daemon kept :PORT and answered every leg's health check + dispatch).
  lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT still bound before daemon start — previous daemon not stopped"
  # Real environment (Slack tokens) + CODEX_HOME for codex auth + the isolated AISUP_HOME. `exec` so the
  # backgrounded subshell IS replaced by node → $! is the REAL daemon PID (so stop_daemon kills node, not
  # a wrapper that orphans the daemon). Each leg therefore boots a genuinely fresh daemon (clean reactive
  # state + the leg's own config), which is exactly what the ME-001 per-leg matrix requires.
  ( set +u; [ -f "$SECRETS_ENV" ] && . "$SECRETS_ENV"
    exec env CODEX_HOME="$REAL_CODEX_HOME" AISUP_HOME="$AISUP_HOME" node "$DAEMON" >"$AISUP_HOME/daemon.out" 2>&1 ) &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited during startup (see $AISUP_HOME/daemon.out)"
    sleep 1
  done
  fail "daemon health check timed out on port $PORT"
}

# All accounts must report `unknown` basis before dispatch (HI-001 deterministic config order).
preflight_providers() {
  local out; out="$(acli worker providers 2>&1 || true)"
  echo "$out" >>"$LOG"
  # Detect a FAILED command first (missing token → "Daemon not running", parse/ENOENT errors) — otherwise
  # an error string that happens to lack live|aged|reset is silently read as "all unknown ✓" (false pass).
  echo "$out" | grep -qiE "Daemon not running|No provider roles|ENOENT|Error:" && fail "worker providers failed: $out"
  echo "$out" | grep -qE "basis=" || fail "worker providers returned no provider data: $out"
  echo "$out" | grep -qiE "basis=(live|aged|reset)" && fail "an account reports non-unknown basis — shared telemetry leaked (HI-001)"
  log "preflight: worker providers all at unknown basis ✓"
}

# Dispatch (no pin) + poll the isolated journal for a terminal worker state.
dispatch_and_capture() {
  local leg="$1" dout wid
  dout="$(acli worker dispatch --task-type implement --workspace "$SCRATCH" \
    --prompt 'Append a single new line that says "hello from worker" to README.md. Make only that one edit.' 2>&1)"
  echo "$dout" >>"$LOG"
  # Abort fast on a failed dispatch instead of polling a journal that will never get worker.* events.
  echo "$dout" | grep -qiE "Dispatched worker" || fail "[$leg] dispatch did not succeed: $dout"
  # ⛔ Scope the terminal-state poll (and the chain display) to THIS leg's worker id. The journal is
  # append-only across legs, so an UNSCOPED grep for any terminal event makes every later leg break
  # instantly on an EARLIER leg's terminal event (e.g. Leg A's awaiting_approval) → B/C never run.
  wid="$(printf '%s\n' "$dout" | grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' | head -n1 || true)"
  [ -n "$wid" ] || fail "[$leg] could not parse worker id from: $dout"
  log "[$leg] dispatched (${dout}); waiting for terminal state of ${wid}"
  for _ in $(seq 1 240); do
    grep "$wid" "$AISUP_HOME/journal.jsonl" 2>/dev/null \
      | grep -qE 'worker\.(awaiting_approval|merged|all_candidates_exhausted|cleanup)' && break
    sleep 1
  done
  log "[$leg] journal failover chain (${wid}):"
  grep "$wid" "$AISUP_HOME/journal.jsonl" 2>/dev/null | grep -oE '"event_type":"worker\.[a-z_]+"' | tee -a "$LOG" || true
}

# ── Preflight ───────────────────────────────────────────────────────────────────────────────────
[ -f "$DAEMON" ] && [ -f "$CLI" ] || { (cd "$REPO_ROOT" && npm run build); }
mkdir -p "$AISUP_HOME" "$NOAUTH_DIR" "$SCRATCH"
: >"$LOG"
log "AISUP_HOME=$AISUP_HOME  PORT=$PORT  authed-account=$REAL_AUTHED_CONFIG_DIR"
[[ "$AISUP_HOME" == /private/tmp/* ]] || fail "AISUP_HOME is not under /private/tmp — refusing"
lsof -i ":$PORT" >/dev/null 2>&1 && fail "port $PORT is already in use"
[ -d "$REAL_AUTHED_CONFIG_DIR" ] || fail "authed account config_dir not found: $REAL_AUTHED_CONFIG_DIR"

# Scratch git repo (init + one commit) — the worker branches a worktree from HEAD.
( cd "$SCRATCH" && git init -q && git config user.email t@t.dev && git config user.name t \
    && printf '# scratch\n' > README.md && git add . && git commit -q -m init )

# Lead session for Slack: a mapped channel is needed so the cross-LLM failover posts a real message.
# (Starts a real supervised session; comment out if running headless without a lead runner.)
start_lead_session() {
  acli start --cwd "$SCRATCH" >>"$LOG" 2>&1 || log "WARN: lead session start failed — Slack post evidence may be the journal cross_provider event only"
}

# ── Leg A — account-first (Truth 1): no-auth account FIRST, then a real authed account ───────────
log "=== LEG A: account-first failover (Truth 1) ==="
write_config "accounts:
  - { name: noauth, config_dir: \"$NOAUTH_DIR\", priority: 1, enabled: true }
  - { name: authed, config_dir: \"$REAL_AUTHED_CONFIG_DIR\", priority: 2, enabled: true }" 3000000 5
start_daemon
preflight_providers
start_lead_session
dispatch_and_capture "A"
log "[A] EXPECT: worker.candidate_failed → worker.failover → worker.completed → worker.awaiting_approval, scratch README edited by the REAL account"
stop_daemon

# ── Leg B — cross-LLM (Truth 2a): ALL claude no-auth + AMPLE codex budget ────────────────────────
log "=== LEG B: cross-LLM claude→codex failover (Truth 2a) ==="
write_config "accounts:
  - { name: noauth1, config_dir: \"$NOAUTH_DIR\", priority: 1, enabled: true }" 3000000 5
start_daemon
preflight_providers
start_lead_session
dispatch_and_capture "B"
log "[B] EXPECT: worker.failover {cross_provider:true} with a REAL codex winner; a real Slack post to the lead-session channel (or the cross_provider journal event as recorded evidence)"
stop_daemon

# ── Leg C — budget gate (Truth 2b): ALL claude no-auth + CROSSED codex budget ────────────────────
log "=== LEG C: codex budget gate (Truth 2b) ==="
# Pre-seed the isolated ledger with codex usage OVER the tiny cap so the selector marks codex exhausted.
RESET_AT=$(( $(date +%s) + 18000 ))
cat > "$AISUP_HOME/usage-ledger.json" <<JSON
{ "accounts": {}, "budgets": { "codex": { "tokens_used": 1000, "cap": 1, "period_reset_at": $RESET_AT } } }
JSON
write_config "accounts:
  - { name: noauth1, config_dir: \"$NOAUTH_DIR\", priority: 1, enabled: true }" 1 5
start_daemon
preflight_providers
dispatch_and_capture "C"
log "[C] EXPECT: worker.all_candidates_exhausted with NO codex subprocess (budget gated)"
stop_daemon

log "=== DONE — review the chains above + $AISUP_HOME/daemon.out; evidence copied to /private/tmp/aisup-val-$UUID.log ==="
