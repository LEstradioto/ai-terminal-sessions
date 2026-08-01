#!/bin/sh

set -eu

if [ "$#" -eq 0 ]; then
  printf 'usage: %s <image-or-video> [...]\n' "$0" >&2
  exit 2
fi

failed=0
scan_image() {
  image=$1
  source=$2
  text=$(mktemp)
  tesseract "$image" stdout 2>/dev/null > "$text" || true
  if rg -i '(/Users/|gmail|contra-glosa|orgId|claude\.ai|lestra@)' "$text"; then
    printf 'privacy check failed: %s\n' "$source" >&2
    failed=1
  fi
  rm -f "$text"
}

for asset in "$@"; do
  case "$asset" in
    *.gif|*.mov|*.mp4|*.m4v|*.webm)
      frames=$(mktemp -d)
      if ! ffmpeg -loglevel error -i "$asset" -vf fps=1 "$frames/frame-%05d.png"; then
        printf 'could not inspect video: %s\n' "$asset" >&2
        failed=1
      else
        for frame in "$frames"/*.png; do
          [ -f "$frame" ] || continue
          scan_image "$frame" "$asset"
        done
      fi
      rm -rf "$frames"
      ;;
    *) scan_image "$asset" "$asset" ;;
  esac
done
exit "$failed"
