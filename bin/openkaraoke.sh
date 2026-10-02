#!/usr/bin/env bash
# Starts the OpenKaraoke server. Usage: bin/openkaraoke.sh [--library "<folder>"] [--port 6527] …
set -euo pipefail

# Resolve the repository folder even when this script is called through a symlink.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
APP_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "OpenKaraoke needs Node.js 18.17 or newer, but 'node' was not found." >&2
  echo "Install it with your package manager (e.g. 'sudo dnf install nodejs' or 'sudo apt install nodejs')." >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "OpenKaraoke needs Node.js 18.17 or newer (found $(node -v))." >&2
  exit 1
fi

exec node "$APP_DIR/server/index.js" "$@"
