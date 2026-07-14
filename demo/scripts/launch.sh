#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/demo/.work"

"$ROOT/demo/scripts/setup.sh"
tmux -L ai-terminal-sessions-demo kill-server 2>/dev/null || true

CODEX_HOME="$WORK/home/.codex" \
AI_TERMINAL_SESSIONS_DEMO=1 \
AI_TERMINAL_SESSIONS_TMUX_SERVER=ai-terminal-sessions-demo \
SHELL="$WORK/bin/demo-shell" \
PATH="$WORK/bin:$PATH" \
code --new-window \
  --password-store=basic \
  --skip-welcome \
  --skip-release-notes \
  --use-inmemory-secretstorage \
  --disable-extension vscode.github-authentication \
  --disable-extension vscode.microsoft-authentication \
  --user-data-dir "$WORK/user-data" \
  --extensions-dir "$WORK/extensions" \
  --extensionDevelopmentPath "$ROOT" \
  "$ROOT/demo/fixture"
