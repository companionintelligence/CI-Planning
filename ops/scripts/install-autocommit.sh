#!/bin/bash
# One-time install of the hourly auto-commit job. Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/scripts/plan-autocommit.sh"
PLIST_SRC="$DIR/launchd/com.liam.plan-autocommit.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.liam.plan-autocommit.plist"
PLAN_DIR="${PLAN_DIR:-$HOME/Documents/Owner_Plan}"

chmod +x "$SCRIPT"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__SCRIPT_PATH__|$SCRIPT|g" -e "s|__PLAN_DIR__|$PLAN_DIR|g" "$PLIST_SRC" > "$PLIST_DEST"

# Unload prior version if present, then load
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "Installed: $PLIST_DEST"
echo "Logs: /tmp/plan-autocommit.log /tmp/plan-autocommit.err"
echo "To uninstall: launchctl unload \"$PLIST_DEST\" && rm \"$PLIST_DEST\""
