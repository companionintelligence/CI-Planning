#!/usr/bin/env bash
# Hourly auto-commit of any changed markdown files.
# Registered via com.companion-planning.autocommit.plist
set -e
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Only commit if there are changes to tracked markdown files
if git diff --quiet -- '*.md' && git diff --cached --quiet -- '*.md'; then
  exit 0
fi

git add -- '*.md'
git commit -m "chore: auto-commit notes $(date '+%Y-%m-%d %H:%M')"
