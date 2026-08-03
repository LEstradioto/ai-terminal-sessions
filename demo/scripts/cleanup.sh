#!/bin/sh

set -eu

TMUX_SERVER=${AI_TERMINAL_SESSIONS_TMUX_SERVER:-ai-terminal-sessions-demo}
tmux -L "$TMUX_SERVER" kill-server 2>/dev/null || true
printf 'Stopped the isolated demo tmux server.\n'
