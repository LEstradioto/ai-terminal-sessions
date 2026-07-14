#!/bin/sh

if [ "${1:-}" = "-lic" ]; then
  exec /bin/sh -c "${2:-}"
fi

exec /bin/sh "$@"
