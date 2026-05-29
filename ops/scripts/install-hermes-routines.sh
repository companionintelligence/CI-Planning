#!/usr/bin/env bash
# Register companion-planning summary routines with hermes cron.
#
# This is the LLM-AUTHORED alternative to the launchd routines: instead of a
# templated summary, hermes runs a full agent turn that reads the planning state
# (via the companion-planning MCP) and writes a narrative review.
#
# Prereq: hermes is installed and its gateway is running (it already is on this
# machine as the ai.hermes.gateway launchd daemon). This script:
#   1. registers the companion-planning MCP server with hermes (HTTP transport)
#   2. creates daily / weekly / monthly cron jobs
#
# Usage: bash ops/scripts/install-hermes-routines.sh [host:port]
set -euo pipefail

ENDPOINT="${1:-127.0.0.1:3847}"
MCP_URL="http://${ENDPOINT}/mcp"

if ! command -v hermes >/dev/null 2>&1; then
  echo "hermes not found on PATH — skipping. (Use the launchd routines instead.)" >&2
  exit 0
fi

echo "→ Registering companion-planning MCP with hermes ($MCP_URL)…"
# Idempotent-ish: remove a prior registration, then add.
hermes mcp remove companion-planning 2>/dev/null || true
hermes mcp add companion-planning --url "$MCP_URL" 2>/dev/null \
  || hermes mcp add companion-planning "$MCP_URL" 2>/dev/null \
  || echo "  (could not auto-add MCP; add manually: hermes mcp add companion-planning --url $MCP_URL)"

DAILY_PROMPT='Using the companion-planning MCP tools, call generate_summary with period="daily", then reconcile_past. Read the returned review and deliver a 3-sentence highlight: what got done, what is slipping, the single most important thing for tomorrow.'
WEEKLY_PROMPT='Using the companion-planning MCP tools, call generate_summary with period="weekly", then reconcile_past. Deliver a short weekly review: what shipped, what slipped, and the top 5 priorities for next week.'
MONTHLY_PROMPT='Using the companion-planning MCP tools, call generate_summary with period="monthly", then reconcile_past. Deliver a monthly retrospective: themes that advanced, what stalled, and goals to set for next month.'

echo "→ Creating cron jobs…"
hermes cron create "0 21 * * *"  "$DAILY_PROMPT"   --name companion-daily   --deliver local || true
hermes cron create "0 19 * * 0"  "$WEEKLY_PROMPT"  --name companion-weekly  --deliver local || true
hermes cron create "0 8 1 * *"   "$MONTHLY_PROMPT" --name companion-monthly --deliver local || true

echo ""
echo "✓ hermes routines registered. Inspect with: hermes cron list"
echo "  Daily 21:00 · Weekly Sun 19:00 · Monthly 1st 08:00"
echo ""
echo "NOTE: these OVERLAP with the launchd summary routines if both are installed."
echo "      Pick one driver: launchd (templated, robust) OR hermes (LLM-authored)."
