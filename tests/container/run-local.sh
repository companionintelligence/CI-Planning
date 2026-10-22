#!/usr/bin/env bash
# Run the container smoke gate LOCALLY, without Docker or GitHub Actions.
#
# Boots the three app shapes docker-publish.yml uses — standalone (screenshot +
# service-worker + security-header specs), password-only login, and Companion
# Portal login against the repo's fixture portal — from this checkout's source on
# private ports with throwaway databases, runs the Playwright specs against each,
# and tears everything down.
#
# Prerequisites (one-time):
#   pnpm install                                  # workspace deps
#   pnpm --filter client build                    # the server serves server/public
#   (cd tests/container && npm install && npx playwright install chromium)
#
# Usage:  tests/container/run-local.sh [--keep]
#   PORT_BASE   first of four consecutive ports (default 3950 → 3950..3953)
#   --keep      leave the apps running after the specs (for poking around)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SERVER="$ROOT/server"
PORT_BASE="${PORT_BASE:-3950}"
P_STANDALONE=$((PORT_BASE))     # phase 1
P_LOCAL=$((PORT_BASE + 1))      # phase 2a
P_PORTAL=$((PORT_BASE + 2))     # phase 2b
P_FIXTURE=$((PORT_BASE + 3))    # fixture portal
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

TMP="$(mktemp -d -t ci-planning-smoke.XXXXXX)"
PIDS=()
cleanup() {
  if [ "$KEEP" = 1 ]; then echo "--keep: apps left running (pids ${PIDS[*]}); data in $TMP"; return; fi
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  rm -rf "${TMP:?}"
}
trap cleanup EXIT

[ -x "$SERVER/node_modules/.bin/tsx" ] || { echo "run pnpm install first"; exit 1; }
[ -f "$SERVER/public/index.html" ] || { echo "build the client first: pnpm --filter client build"; exit 1; }
[ -x "$HERE/node_modules/.bin/playwright" ] || { echo "install the harness: (cd tests/container && npm install && npx playwright install chromium)"; exit 1; }
for p in $P_STANDALONE $P_LOCAL $P_PORTAL $P_FIXTURE; do
  if ss -ltn 2>/dev/null | grep -q ":${p} "; then echo "port $p is busy — set PORT_BASE to a free range"; exit 1; fi
done

COMMON=(LOG_LEVEL=warn CI_TELEMETRY=off OLLAMA_URL=http://127.0.0.1:1)
start_app() { # name port extra-env...
  local name="$1" port="$2"; shift 2
  (cd "$SERVER" && env "${COMMON[@]}" PORT="$port" DB_PATH="$TMP/$name.db" "$@" node_modules/.bin/tsx src/index.ts > "$TMP/$name.log" 2>&1 &
   echo $! > "$TMP/$name.pid")
  PIDS+=("$(cat "$TMP/$name.pid")")
}
wait_http() { # url
  for _ in $(seq 1 120); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "never came up: $1"; return 1
}

echo "▶ booting (ports $P_STANDALONE standalone · $P_LOCAL local · $P_PORTAL portal · $P_FIXTURE fixture) — data in $TMP"
start_app standalone "$P_STANDALONE" AUTH_MODE=standalone
start_app local "$P_LOCAL" AUTH_MODE=sso DISABLE_OIDC=true SESSION_SECRET=smoke-session-secret \
  AUTH_DEFAULT_USERNAME=smoke-admin AUTH_DEFAULT_PASSWORD=smoke-password-123
(cd "$SERVER" && FIXTURE_PORTAL_PORT="$P_FIXTURE" FIXTURE_PORTAL_ISSUER="http://localhost:$P_FIXTURE" \
   node_modules/.bin/tsx src/scripts/fixture-portal.ts > "$TMP/fixture.log" 2>&1 & echo $! > "$TMP/fixture.pid")
PIDS+=("$(cat "$TMP/fixture.pid")")
start_app portal "$P_PORTAL" AUTH_MODE=sso SESSION_SECRET=smoke-session-secret AUTH_AUTO_PROVISION=true \
  PUBLIC_BASE_URL="http://localhost:$P_PORTAL" CIPORTAL_CLIENT_ID=companion-planning-dev \
  CIPORTAL_ISSUER="http://localhost:$P_FIXTURE" CIPORTAL_AUTHORIZE_URI="http://localhost:$P_FIXTURE/authorize" \
  CIPORTAL_TOKEN_URI="http://localhost:$P_FIXTURE/token" CIPORTAL_JWKS_URI="http://localhost:$P_FIXTURE/jwks"
wait_http "http://localhost:$P_STANDALONE/api/health"
wait_http "http://localhost:$P_LOCAL/api/health"
wait_http "http://localhost:$P_PORTAL/api/health"
wait_http "http://localhost:$P_FIXTURE/jwks"

cd "$HERE"
status=0
echo "▶ phase 1 — standalone: screenshot, service worker, security headers"
APP_URL="http://localhost:$P_STANDALONE" SCREENSHOT_PATH="$TMP/screenshot.png" \
  node_modules/.bin/playwright test --reporter=line || status=1
echo "▶ phase 2a — local username/password login"
LOGIN_SPEC=local LOGIN_USER=smoke-admin LOGIN_PASS=smoke-password-123 APP_URL="http://localhost:$P_LOCAL" \
  node_modules/.bin/playwright test login.spec.ts --reporter=line || status=1
echo "▶ phase 2b — Companion Portal login against the fixture portal"
LOGIN_SPEC=portal APP_URL="http://localhost:$P_PORTAL" \
  node_modules/.bin/playwright test login.spec.ts --reporter=line || status=1

if [ "$status" = 0 ]; then echo "✔ container smoke gate passed"; else echo "✘ container smoke gate FAILED — logs in $TMP (kept)"; KEEP=1; fi
exit $status
