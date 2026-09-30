#!/usr/bin/env bash
# Installs OpenKaraoke as a systemd *user* service: it starts when you log in and restarts
# by itself if it ever crashes. Your karaoke folder, port and PIN are passed on to the server.
#
#   bin/install-service.sh --library "/run/media/$USER/SMILE-2/Karaoke"   # install + start
#   bin/install-service.sh --library "…" --port 8080 --pin 1234
#   bin/install-service.sh --status       # is it running? (also: journalctl --user -u openkaraoke -f)
#   bin/install-service.sh --uninstall    # stop and remove it
#
# The drive may be plugged in later: OpenKaraoke notices within 20 seconds.
# To start it at boot even before you log in: sudo loginctl enable-linger "$USER"
set -euo pipefail

NAME="openkaraoke"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

# Resolve the repository folder even when this script is called through a symlink.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
APP_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found on this computer — start OpenKaraoke with bin/openkaraoke.sh instead." >&2
  exit 1
fi

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --status) exec systemctl --user status "$NAME.service" --no-pager ;;
  --uninstall)
    systemctl --user disable --now "$NAME.service" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    echo "OpenKaraoke service removed."
    exit 0
    ;;
esac

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "OpenKaraoke needs Node.js 18.17 or newer, but 'node' was not found." >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "OpenKaraoke needs Node.js 18.17 or newer (found $("$NODE" -v))." >&2
  exit 1
fi

# systemd's own quoting for ExecStart: "…" with \ and " escaped, % and $ doubled.
sd_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//%/%%}"
  s="${s//\$/\$\$}"
  printf '"%s"' "$s"
}

ARGS=""
PORT_HINT=8080
while [ $# -gt 0 ]; do
  case "$1" in
    --library|-l|--port|-p|--pin|--data|--host|--log)
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }
      value="$2"
      if [ "$1" = "--library" ] || [ "$1" = "-l" ] || [ "$1" = "--data" ]; then value="$(cd "$value" 2>/dev/null && pwd || echo "$value")"; fi
      if [ "$1" = "--port" ] || [ "$1" = "-p" ]; then PORT_HINT="$value"; fi
      ARGS="$ARGS $(sd_quote "$1") $(sd_quote "$value")"
      shift 2
      ;;
    --no-scan) ARGS="$ARGS --no-scan"; shift ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=OpenKaraoke — karaoke party server
Documentation=file://$APP_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(sd_quote "$NODE") $(sd_quote "$APP_DIR/server/index.js")$ARGS
Restart=on-failure
RestartSec=3
Environment=LOG_LEVEL=info
# Give a running song's state time to be saved on shutdown.
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$NAME.service"
sleep 1
if systemctl --user is-active --quiet "$NAME.service"; then
  echo "OpenKaraoke is running as a user service and starts again when you log in."
  echo "  Host:   http://localhost:$PORT_HINT/host"
  echo "  Logs:   journalctl --user -u $NAME -f"
  echo "  Remove: bin/install-service.sh --uninstall"
  echo "Tip: 'sudo loginctl enable-linger $USER' starts it at boot, before anyone logs in."
else
  echo "The service was installed but is not running. See: journalctl --user -u $NAME -e" >&2
  exit 1
fi
