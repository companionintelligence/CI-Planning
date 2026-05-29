#!/usr/bin/env bash
# Scheduled summary runner. Hits the local companion-planning API to generate a
# period summary and reconcile past calendar blocks. Driven by launchd plists
# (see ops/launchd/com.companion-planning.summary.*.plist).
#
# Usage: summary.sh <daily|weekly|monthly>
# Env:   PORT (default 3847), HOST (default 127.0.0.1)
set -euo pipefail

PERIOD="${1:-daily}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3847}"
BASE="http://${HOST}:${PORT}"

case "$PERIOD" in
  daily|weekly|monthly) ;;
  *) echo "usage: summary.sh <daily|weekly|monthly>" >&2; exit 2 ;;
esac

# Wait for the server to be reachable (it may be starting at login)
for i in $(seq 1 30); do
  if curl -fsS "${BASE}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

# For monthly runs (fired on the 1st), anchor on the prior day so we summarize
# the month that just ended, not the empty new one.
ANCHOR_JSON='{}'
if [ "$PERIOD" = "monthly" ]; then
  YESTERDAY="$(date -v-1d '+%Y-%m-%d' 2>/dev/null || date -d 'yesterday' '+%Y-%m-%d')"
  ANCHOR_JSON="{\"date\":\"${YESTERDAY}\"}"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Generating ${PERIOD} summary (anchor=${ANCHOR_JSON})…"
curl -fsS -X POST "${BASE}/api/summary/${PERIOD}" \
  -H 'Content-Type: application/json' -d "${ANCHOR_JSON}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"  → {d.get(\"file\")} (model={d.get(\"model\")}, counts={d.get(\"counts\")})")' \
  || echo "  summary request failed"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Reconciling past calendar blocks…"
curl -fsS -X POST "${BASE}/api/reconcile" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"  → closed {d.get(\"events_completed\")} blocks, {d.get(\"overdue_now\")} overdue")' \
  || echo "  reconcile request failed"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${PERIOD} routine done."
