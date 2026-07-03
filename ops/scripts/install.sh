#!/usr/bin/env bash
# Install Companion Planning: build, register launchd services, install pre-commit hook.
# Run once from the repo root: bash ops/scripts/install.sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "→ Repo root: $REPO_ROOT"

# Detect node
if ! command -v node &>/dev/null; then
  echo "Error: node not found. Install Node.js 26+ first." >&2
  exit 1
fi

# Detect pnpm — this is a pnpm workspace (see packageManager in package.json).
if ! command -v pnpm &>/dev/null; then
  echo "Error: pnpm not found. Enable it with 'corepack enable' (Node ships corepack) or install pnpm 11+." >&2
  exit 1
fi

# Install workspace deps (client + server)
echo "→ Installing dependencies…"
pnpm -C "$REPO_ROOT" install --frozen-lockfile

# Build the SolidJS client (vite → server/public). The server itself has no build
# step — it runs via tsx (see the launchd plist / Dockerfile).
echo "→ Building client…"
pnpm -C "$REPO_ROOT" build

# Create logs dir
mkdir -p "$REPO_ROOT/logs"

# Make scripts executable
chmod +x "$REPO_ROOT/ops/scripts/autocommit.sh"
chmod +x "$REPO_ROOT/ops/scripts/install-hooks.sh"
chmod +x "$REPO_ROOT/ops/scripts/summary.sh"
chmod +x "$REPO_ROOT/ops/scripts/install-hermes-routines.sh"

# Install pre-commit hook
bash "$REPO_ROOT/ops/scripts/install-hooks.sh"

# Install launchd services (macOS only)
if [[ "$(uname)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"

  for plist in "$REPO_ROOT/ops/launchd/"*.plist; do
    name="$(basename "$plist")"
    dest="$PLIST_DIR/$name"

    # Substitute REPO_PATH placeholder
    sed "s|REPO_PATH|$REPO_ROOT|g" "$plist" > "$dest"

    # Unload if already loaded (ignore error if not loaded)
    launchctl unload "$dest" 2>/dev/null || true
    launchctl load -w "$dest"
    echo "  ✓ Registered $name"
  done
  echo ""
  echo "✓ launchd services installed. Server will auto-start on login."
else
  echo "  ⚠  Non-macOS: skipping launchd registration. Start manually:"
  echo "     cd $REPO_ROOT && pnpm --filter server start"
fi

echo ""
echo "✓ Companion Planning installed."
echo "  App: http://127.0.0.1:${PORT:-3848}"
