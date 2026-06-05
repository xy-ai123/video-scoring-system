#!/usr/bin/env bash
# scripts/open-dashboard.sh
# -------------------------
# Open the current dashboard URL in your default browser. The URL lives
# in `.tunnel-url` at the project root, which `tunnel.sh` rewrites every
# time it starts. Use this instead of a bookmark — bookmarks go stale
# because quick-tunnel URLs change on every restart.
#
# Usage:
#   ./scripts/open-dashboard.sh          # opens /admin/clipping
#   ./scripts/open-dashboard.sh /login   # opens any path you pass

set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
URL_FILE="$ROOT/.tunnel-url"
PATH_PART="${1:-/admin/clipping}"

if [ ! -f "$URL_FILE" ]; then
  echo "No .tunnel-url file found at $URL_FILE." >&2
  echo "Start the tunnel first: ./scripts/tunnel.sh" >&2
  exit 1
fi

URL="$(cat "$URL_FILE")"
if [ -z "$URL" ]; then
  echo ".tunnel-url is empty — wait a few seconds after starting tunnel.sh and try again." >&2
  exit 1
fi

FULL="${URL%/}${PATH_PART}"
echo "Opening $FULL"
open "$FULL"
