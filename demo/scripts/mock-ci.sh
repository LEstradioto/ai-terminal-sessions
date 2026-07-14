#!/bin/sh

set -eu

trap 'exit 0' INT TERM
run=41
while true; do
  printf '\033[1;36mCI run #%s\033[0m  main → preview\n' "$run"
  printf '\033[32m✓ lint\033[0m      1.2s\n'
  printf '\033[32m✓ tests\033[0m     8.4s  \033[2m50 passed\033[0m\n'
  printf '\033[33m● deploy\033[0m    publishing artifact…\n'
  sleep 2
  printf '\033[32m✓ deploy\033[0m    preview ready\n'
  printf '\033[2m────────────────────────────────────────\033[0m\n'
  run=$((run + 1))
  sleep 3
done
