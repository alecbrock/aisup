#!/bin/sh
# Deterministic test fixture: echoes commands, exits on "quit"
# Used by session controller integration tests.
while true; do
  printf '> '
  IFS= read -r line || break
  case "$line" in
    quit) printf 'goodbye\n'; exit 0 ;;
    *)    printf 'echo: %s\n' "$line" ;;
  esac
done
