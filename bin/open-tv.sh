#!/usr/bin/env bash
# Opens the OpenKaraoke TV display full-screen (kiosk) on the second screen, with
# autoplay allowed so no click is needed. Works with Chromium or Google Chrome.
#
#   bin/open-tv.sh                      # http://localhost:8080/tv on the 2nd monitor
#   bin/open-tv.sh --port 8081
#   bin/open-tv.sh --screen 1           # pick a monitor by index (0 = first)
#   bin/open-tv.sh --url http://192.168.1.20:8080/tv
set -euo pipefail

PORT=8080
URL=""
SCREEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --screen) SCREEN="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
URL="${URL:-http://localhost:$PORT/tv}"

BROWSER=""
for b in chromium chromium-browser google-chrome google-chrome-stable brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
if [ -z "$BROWSER" ] && command -v flatpak >/dev/null 2>&1 && flatpak info org.chromium.Chromium >/dev/null 2>&1; then
  BROWSER="flatpak run org.chromium.Chromium"
fi
if [ -z "$BROWSER" ]; then
  echo "Chromium or Google Chrome is needed for the TV display (e.g. 'sudo dnf install chromium')." >&2
  exit 1
fi

# Monitor geometry from xrandr: lines like "1920x1080+1920+0". Default = the first
# monitor that is not primary; otherwise the first one.
X=0
Y=0
if command -v xrandr >/dev/null 2>&1; then
  mapfile -t MONS < <(xrandr --query 2>/dev/null | awk '/ connected/ { p = ($3 == "primary"); for (i = 3; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) { print p " " $i; break } }')
  if [ "${#MONS[@]}" -gt 0 ]; then
    PICK=""
    if [ -n "$SCREEN" ] && [ "$SCREEN" -lt "${#MONS[@]}" ]; then
      PICK="${MONS[$SCREEN]}"
    else
      for m in "${MONS[@]}"; do
        if [ "${m%% *}" = "0" ]; then PICK="$m"; break; fi
      done
      [ -z "$PICK" ] && PICK="${MONS[0]}"
    fi
    GEO="${PICK#* }"
    X="$(echo "$GEO" | cut -d+ -f2)"
    Y="$(echo "$GEO" | cut -d+ -f3)"
    echo "TV display on monitor at ${X},${Y} (${#MONS[@]} monitor(s) found)"
  fi
fi

PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/openkaraoke-tv"
mkdir -p "$PROFILE"

# shellcheck disable=SC2086
exec $BROWSER \
  --user-data-dir="$PROFILE" \
  --kiosk \
  --window-position="$X,$Y" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter \
  --password-store=basic \
  "$URL"
