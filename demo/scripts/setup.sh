#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/demo/.work"
HOME_DIR="$WORK/home"
BIN_DIR="$WORK/bin"
SESSIONS="$HOME_DIR/.codex/sessions/2026/07/13"

mkdir -p "$BIN_DIR" "$SESSIONS" "$WORK/user-data/User" "$WORK/extensions"
cp "$ROOT/demo/user-settings.json" "$WORK/user-data/User/settings.json"
clang -O2 -Wall -Wextra "$ROOT/demo/mock-agent/codex.c" -o "$BIN_DIR/codex"
cp "$ROOT/demo/mock-agent/demo-shell.sh" "$BIN_DIR/demo-shell"
chmod +x "$BIN_DIR/codex" "$BIN_DIR/demo-shell" "$ROOT/demo/scripts/mock-ci.sh"

cp "$ROOT/demo/transcripts/working.jsonl" "$SESSIONS/rollout-2026-07-13T10-00-00-11111111-1111-4111-8111-111111111111.jsonl"
cp "$ROOT/demo/transcripts/ready.jsonl" "$SESSIONS/rollout-2026-07-13T10-01-00-22222222-2222-4222-8222-222222222222.jsonl"
cp "$ROOT/demo/transcripts/permission.jsonl" "$SESSIONS/rollout-2026-07-13T10-02-00-33333333-3333-4333-8333-333333333333.jsonl"
cp "$ROOT/demo/transcripts/ci.jsonl" "$SESSIONS/rollout-2026-07-13T10-03-00-44444444-4444-4444-8444-444444444444.jsonl"

touch -t 202607131002 "$SESSIONS/rollout-2026-07-13T10-02-00-33333333-3333-4333-8333-333333333333.jsonl"

printf 'Demo prepared in %s\n' "$WORK"
