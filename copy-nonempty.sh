#!/bin/sh

copy_command=${AI_TERMINAL_PBCOPY:-/usr/bin/pbcopy}

if IFS= read -r first_line; then
  {
    printf '%s\n' "$first_line"
    cat
  } | "$copy_command"
elif [ -n "$first_line" ]; then
  printf '%s' "$first_line" | "$copy_command"
fi
