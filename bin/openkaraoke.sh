#!/usr/bin/env bash
# Starts the OpenKaraoke server. All arguments are passed through, e.g.
#   bin/openkaraoke.sh --library "/run/media/$USER/SMILE-2/Karaoke"
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 18.17 or newer (e.g. 'sudo dnf install nodejs' or 'sudo apt install nodejs')." >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "OpenKaraoke needs Node.js 18.17 or newer; found $(node -v)." >&2
  exit 1
fi

exec node "$DIR/server/index.js" "$@"
