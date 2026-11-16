#!/usr/bin/env bash
# Smoke-test a Linux AppImage of Companion Planning: start it on a virtual X display, wait for its
# window, then check that the app is still running and still showing that window after a settle
# period. Used by the smoke-linux job in .github/workflows/desktop-build.yml.
#
#   scripts/smoke-linux-appimage.sh <path-to.AppImage> [window-title]
#
# Needs xvfb-run, xdotool and pgrep. The AppImage runs with --appimage-extract-and-run, so FUSE is
# not needed. SMOKE_WINDOW_TIMEOUT (default 120 seconds) and SMOKE_SETTLE_SECONDS (default 15) set
# the two waits. SMOKE_PROCESS (default companion-planning-desktop) names the process to look for.
# It is read from the environment on purpose: a name passed as an argument would appear in this
# script's own command line, and pgrep -f matches command lines, so the check could pass with the
# app gone.
set -euo pipefail

appimage="${1:?usage: smoke-linux-appimage.sh <path-to.AppImage> [window-title]}"
title="${2:-Companion Planning}"
process="${SMOKE_PROCESS:-companion-planning-desktop}"
window_timeout="${SMOKE_WINDOW_TIMEOUT:-120}"
settle_seconds="${SMOKE_SETTLE_SECONDS:-15}"

if [ ! -f "$appimage" ]; then
  echo "AppImage not found: $appimage" >&2
  exit 1
fi

# Without a display, run this same script under a virtual one.
if [ -z "${DISPLAY:-}" ]; then
  exec xvfb-run -a -s "-screen 0 1280x800x24" bash "$0" "$@"
fi

chmod +x "$appimage"
export GDK_BACKEND=x11 NO_AT_BRIDGE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
log="$(mktemp)"

"$appimage" --appimage-extract-and-run >"$log" 2>&1 &
pid=$!

stop_app() {
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  sleep 2
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
trap stop_app EXIT

fail() {
  echo "$1" >&2
  echo "--- app output ---" >&2
  cat "$log" >&2
  exit 1
}

window_visible() {
  xdotool search --onlyvisible --name "$title" >/dev/null 2>&1
}

deadline=$((SECONDS + window_timeout))
until window_visible; do
  [ "$SECONDS" -lt "$deadline" ] || fail "No window titled '$title' appeared within ${window_timeout}s."
  sleep 1
done

sleep "$settle_seconds"
pgrep -f "$process" >/dev/null 2>&1 || fail "No '$process' process is running ${settle_seconds}s after its window appeared."
window_visible || fail "The window titled '$title' closed within ${settle_seconds}s of appearing."
echo "OK: a window titled '$title' appeared, and '$process' was still running and showing it ${settle_seconds}s later."
