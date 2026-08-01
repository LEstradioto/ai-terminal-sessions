#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
WORK="$ROOT/demo/.work"

if [ -f "$WORK/user-data/code.lock" ]; then
  printf 'Close the existing AI Terminal Sessions demo window, then run this command again.\n' >&2
  printf 'If VS Code crashed, remove demo/.work after confirming no demo process is running.\n' >&2
  exit 1
fi

tmux -L ai-terminal-sessions-demo kill-server 2>/dev/null || true
case "$WORK" in
  "$ROOT/demo/.work") rm -rf "$WORK" ;;
  *) printf 'Refusing to reset unexpected demo path: %s\n' "$WORK" >&2; exit 1 ;;
esac
"$ROOT/demo/scripts/setup.sh"

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
