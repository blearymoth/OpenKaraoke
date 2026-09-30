#!/usr/bin/env bash
# Opens the OpenKaraoke TV display full screen on the second monitor (Chrome/Chromium kiosk
# mode) with sound allowed straight away — no click needed.
#
#   bin/open-tv.sh                      # TV on the first non-primary screen
#   bin/open-tv.sh --screen 2           # pick a screen (1 = first in `xrandr` order)
#   bin/open-tv.sh --port 9000          # server on another port
#   bin/open-tv.sh --url http://192.168.1.20:8080/tv
#   bin/open-tv.sh --browser chromium   # force a browser
#
# Close the TV window with Alt+F4.
#
# The window also gets microphone access without a permission prompt
# (--use-fake-ui-for-media-stream auto-accepts it; the browser profile is used only for the
# TV): the applause meter game listens with the PC's microphone.
set -euo pipefail

URL="http://localhost:${PORT:-8080}/tv"
SCREEN=""
BROWSER=""

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --port) URL="http://localhost:$2/tv"; shift 2 ;;
    --screen) SCREEN="$2"; shift 2 ;;
    --browser) BROWSER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if [ -z "$BROWSER" ]; then
  for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
    if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
  done
fi
if [ -z "$BROWSER" ]; then
  echo "Chrome or Chromium was not found. Install one (e.g. 'sudo dnf install chromium')," >&2
  echo "or open $URL in any browser and click the page once." >&2
  exit 1
fi

# Find where the TV screen is. Default: the first connected screen that isn't primary.
POS="0,0"
SIZE=""
if command -v xrandr >/dev/null 2>&1; then
  mapfile -t SCREENS < <(xrandr --query 2>/dev/null | awk '/ connected/ {
      primary = ($3 == "primary") ? 1 : 0
      for (i = 3; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) { print primary " " $1 " " $i; break }
    }')
  pick=""
  if [ -n "$SCREEN" ]; then
    pick="${SCREENS[$((SCREEN - 1))]:-}"
    [ -z "$pick" ] && { echo "There is no screen $SCREEN (found ${#SCREENS[@]})." >&2; exit 1; }
  else
    for s in "${SCREENS[@]}"; do
      if [ "${s%% *}" = "0" ]; then pick="$s"; break; fi
    done
    if [ -z "$pick" ] && [ ${#SCREENS[@]} -gt 0 ]; then
      pick="${SCREENS[0]}"
      echo "Only one screen found — opening the TV display on it."
    fi
  fi
  if [ -n "$pick" ]; then
    geom="${pick##* }"                        # 1920x1080+1920+0
    SIZE="${geom%%+*}"; SIZE="${SIZE/x/,}"    # 1920,1080
    rest="${geom#*+}"; POS="${rest/+/,}"      # 1920,0
    echo "TV screen: ${pick#* } → position $POS"
  fi
else
  echo "xrandr not found: the window opens on the current screen; drag it to the TV."
fi

# Wait up to 30 s for the server (handy when both start at login).
if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$URL" 2>/dev/null && break
    sleep 0.5
  done
fi

EXTRA=()
# On Wayland, Chrome ignores window positions unless it runs through XWayland.
[ -n "${WAYLAND_DISPLAY:-}" ] && EXTRA+=(--ozone-platform=x11)
[ -n "$SIZE" ] && EXTRA+=(--window-size="$SIZE")

exec "$BROWSER" \
  --kiosk "$URL" \
  --window-position="$POS" \
  "${EXTRA[@]}" \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --user-data-dir="$HOME/.config/openkaraoke-tv" \
  --no-first-run --no-default-browser-check --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-features=Translate --password-store=basic \
  >/dev/null 2>&1
