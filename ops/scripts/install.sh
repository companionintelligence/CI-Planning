#!/usr/bin/env bash
# Install Companion Planning: build, register launchd services, install pre-commit hook.
# Run once from the repo root: bash ops/scripts/install.sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "→ Repo root: $REPO_ROOT"

# Detect node
if ! command -v node &>/dev/null; then
  echo "Error: node not found. Install Node.js 22+ first." >&2
  exit 1
fi

# Install npm deps
echo "→ Installing dependencies…"
npm ci --prefix "$REPO_ROOT"

# Build TypeScript server
echo "→ Building TypeScript server…"
npm run build --prefix "$REPO_ROOT"

# Build Svelte UI
if [ -f "$REPO_ROOT/ui/package.json" ]; then
  echo "→ Building Svelte UI…"
  npm run build --prefix "$REPO_ROOT/ui"
fi

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
echo "  App: http://127.0.0.1:$(node -e "const c=require('$REPO_ROOT/config.json');console.log(c.port||3847)")"
