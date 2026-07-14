#!/bin/sh

set -eu

tmux -L ai-terminal-sessions-demo kill-server 2>/dev/null || true
printf 'Stopped the isolated demo tmux server.\n'
