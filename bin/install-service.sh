#!/usr/bin/env bash
# Installs OpenKaraoke as a systemd *user* service: it starts when you log in and restarts
# by itself if it ever crashes. Run it again to change the options (the service restarts).
#
#   bin/install-service.sh --library "/run/media/$USER/<drive>/Karaoke"   # install + start
#   bin/install-service.sh --library "…" --port 6527 --pin 1234   # --port: only that port
#   bin/install-service.sh --status       # is it running? (also: journalctl --user -u openkaraoke -f)
#   bin/install-service.sh --uninstall    # stop and remove it
#
# --library and --pin are saved in the settings once, like a change made in Settings (which
# can change them again later): they are not passed on every start, and the PIN is not
# written in the service file. --port, --host, --data, --log and --no-scan are.
#
# The drive may be plugged in later: OpenKaraoke notices within 20 seconds.
# To start it at boot even before you log in: sudo loginctl enable-linger "$USER"
set -euo pipefail

NAME="openkaraoke"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

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

ARGS=""       # passed on every start (ExecStart)
START=()      # the same, for the one-off setup run below
SAVE=()       # --library / --pin: saved in the settings once
while [ $# -gt 0 ]; do
  case "$1" in
    --library|-l|--port|-p|--pin|--data|--host|--log)
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }
      value="$2"
      if [ "$1" = "--library" ] || [ "$1" = "-l" ] || [ "$1" = "--data" ]; then value="$(cd "$value" 2>/dev/null && pwd || echo "$value")"; fi
      case "$1" in
        --library|-l|--pin) SAVE+=("$1" "$value") ;;
        *) ARGS="$ARGS $(sd_quote "$1") $(sd_quote "$value")"; START+=("$1" "$value") ;;
      esac
      shift 2
      ;;
    --no-scan) ARGS="$ARGS --no-scan"; START+=(--no-scan); shift ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done
# The service doesn't see this shell's environment: a data folder chosen with
# OPENKARAOKE_DATA is passed on, so that the service uses the same one.
if [ -n "${OPENKARAOKE_DATA:-}" ] && [[ " ${START[*]-} " != *" --data "* ]]; then
  value="$(cd "$OPENKARAOKE_DATA" 2>/dev/null && pwd || echo "$OPENKARAOKE_DATA")"
  ARGS="$ARGS --data $(sd_quote "$value")"
  START+=(--data "$value")
fi

# Stop a running copy first: it would save its own settings over the new ones when it
# stops, and it has to restart anyway to use the new options.
was_running=""
if systemctl --user is-active --quiet "$NAME.service" 2>/dev/null; then was_running=1; fi
systemctl --user stop "$NAME.service" 2>/dev/null || true

# Checks that the port is free (bin/openkaraoke.sh may still be running), saves --library
# and --pin, and prints the "<port> <address>" the service will answer on.
if ! WHERE="$(env -u PORT "$NODE" "$APP_DIR/server/index.js" ${START[@]+"${START[@]}"} ${SAVE[@]+"${SAVE[@]}"} --setup)"; then
  echo "Nothing was changed. If OpenKaraoke is still running (bin/openkaraoke.sh), stop it first, or pick another --port." >&2
  if [ -n "$was_running" ]; then
    systemctl --user start "$NAME.service" || true
    echo "The service keeps running with its old options." >&2
  fi
  exit 1
fi
read -r PORT ADDRESS <<<"$WHERE"
for ((i = 0; i < ${#SAVE[@]}; i += 2)); do
  case "${SAVE[i]}" in
    --pin) echo "Host PIN saved in the settings (change it in Settings → Party)." ;;
    *) echo "Karaoke folder saved in the settings: ${SAVE[i + 1]}" ;;
  esac
done

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT_FILE
[Unit]
Description=OpenKaraoke — karaoke party server
Documentation=file://$APP_DIR/README.md
After=network-online.target
Wants=network-online.target
# A server that keeps crashing is given up after 5 starts in 2 minutes.
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(sd_quote "$NODE") $(sd_quote "$APP_DIR/server/index.js")$ARGS
Restart=on-failure
RestartSec=3
# 78: the port is taken or not allowed. Trying again won't help (the log says why).
RestartPreventExitStatus=78
Environment=LOG_LEVEL=info
# Give a running song's state time to be saved on shutdown.
TimeoutStopSec=10

[Install]
WantedBy=default.target
UNIT_FILE

systemctl --user daemon-reload
systemctl --user enable --quiet "$NAME.service"
systemctl --user reset-failed "$NAME.service" 2>/dev/null || true
# restart, not start: a copy that is somehow still running would keep its old options.
systemctl --user restart "$NAME.service"

# Wait until it answers: loading a big library index takes a few seconds. The port was
# free a moment ago, so whoever answers now is the service.
answers() {
  "$NODE" -e "require('net').connect(+process.argv[1], process.argv[2]).on('connect', () => process.exit(0)).on('error', () => process.exit(1))" "$PORT" "$ADDRESS"
}
ok=""
for _ in $(seq 1 120); do
  systemctl --user is-active --quiet "$NAME.service" || break
  if answers; then ok=1; break; fi
  sleep 0.5
done
if [ -n "$ok" ]; then
  echo "OpenKaraoke is running as a user service and starts again when you log in."
  echo "  Host:   http://localhost:$PORT/host"
  echo "  Logs:   journalctl --user -u $NAME -f"
  echo "  Remove: bin/install-service.sh --uninstall"
  echo "Tip: 'sudo loginctl enable-linger ${USER:-$(id -un)}' starts it at boot, before anyone logs in."
else
  echo "The service was installed but is not running (or not answering on port $PORT). Its last messages:" >&2
  journalctl --user -u "$NAME" -n 20 --no-pager >&2 || true
  exit 1
fi
