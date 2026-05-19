#!/bin/bash
# Hourly auto-commit of the planning markdown directory.
# Run by launchd. Idempotent — exits cleanly when nothing changed.

set -u
PLAN_DIR="${PLAN_DIR:-$HOME/Documents/Owner_Plan}"
cd "$PLAN_DIR" || exit 0
[ -d .git ] || exit 0

# Stage everything except temp/lock files.
/usr/bin/git add -A .

# Bail if nothing staged.
if /usr/bin/git diff --cached --quiet; then
  exit 0
fi

TS=$(date -Iseconds)
/usr/bin/git -c user.email="REDACTED-DEV-EMAIL@example.invalid" -c user.name="Owner (autocommit)" \
  commit -q -m "auto: snapshot $TS" || exit 0
