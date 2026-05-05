#!/bin/bash
# statusline-tap.sh — captures Claude Code's statusline stdin JSON, then passes
# input through to pilot's real statusline unchanged.
#
# Round 5 corrections applied:
#   - keyed by session_id (not PID), per Claude Code docs
#   - atomic write via tmp + rename
#   - 'resets_at' is documented as Unix epoch seconds (no conversion here)
#
# Install: set settings.json "statusLine.command" to this script's absolute path.
# Files written to: /tmp/pilot-failover/statusline-<session_id>.json
#                   /tmp/pilot-failover/statusline-latest.json (symlink to newest)

set -euo pipefail

TAP_DIR="/tmp/pilot-failover"
mkdir -p "$TAP_DIR"

INPUT="$(cat)"

SID=""
if command -v jq >/dev/null 2>&1; then
  SID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi
if [ -z "$SID" ] && command -v python3 >/dev/null 2>&1; then
  SID="$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("session_id","") or "")
except: pass' 2>/dev/null || true)"
fi

if [[ "$SID" =~ ^[0-9a-fA-F-]{8,}$ ]]; then
  OUT="$TAP_DIR/statusline-$SID.json"
else
  OUT="$TAP_DIR/statusline-unknown-$$.json"
fi

TMP="${OUT}.$$.tmp"
printf '%s' "$INPUT" > "$TMP"
mv -f "$TMP" "$OUT"
ln -sfn "$OUT" "$TAP_DIR/statusline-latest.json" 2>/dev/null || true

PILOT_BIN="${PILOT_BIN:-$HOME/.pilot/bin/pilot}"
printf '%s' "$INPUT" | "$PILOT_BIN" statusline
