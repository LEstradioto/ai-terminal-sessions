#!/bin/sh

set -eu

if [ "$#" -eq 0 ]; then
  printf 'usage: %s <image-or-video> [...]\n' "$0" >&2
  exit 2
fi

failed=0
for asset in "$@"; do
  text=$(mktemp)
  tesseract "$asset" stdout 2>/dev/null > "$text" || true
  if rg -i '(/Users/|gmail|contra-glosa|orgId|claude\.ai|lestra@)' "$text"; then
    printf 'privacy check failed: %s\n' "$asset" >&2
    failed=1
  fi
  rm -f "$text"
done
exit "$failed"
