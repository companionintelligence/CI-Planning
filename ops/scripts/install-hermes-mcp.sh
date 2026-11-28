#!/usr/bin/env bash
# Register this checkout's local Companion Planning stdio MCP server with Hermes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
TSX="$SERVER_DIR/node_modules/.bin/tsx"
MCP_SCRIPT="$SERVER_DIR/src/scripts/mcp-app-server.ts"
ENV_FILE="$SERVER_DIR/mcp.local.env"
SKILLS_SOURCE="$REPO_ROOT/skills"
SKILLS_DEST="${HOME:?HOME must be set}/.hermes/skills/companion-planning"

if ! command -v hermes >/dev/null 2>&1; then
  echo "hermes not found on PATH" >&2
  exit 1
fi
if [[ ! -x "$TSX" ]]; then
  echo "Server dependencies are missing; run pnpm install from $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SERVER_DIR/mcp.local.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE. Add local app credentials there before using write tools."
fi

# Install a private copy of this app's skill pack where Hermes discovers skills.
# Keeping this namespaced prevents collisions with the user's other skills.
mkdir -p "$SKILLS_DEST"
for skill in "$SKILLS_SOURCE"/*; do
  [[ -d "$skill" ]] || continue
  name="$(basename "$skill")"
  rm -rf "$SKILLS_DEST/$name"
  cp -R "$skill" "$SKILLS_DEST/$name"
done

# Registration only; credentials stay in the ignored env file on the MCP host.
# Replaces an existing Hermes entry with this name so the paths stay in sync.
hermes mcp remove companion-planning >/dev/null 2>&1 || true
printf 'y\n' | hermes mcp add companion-planning \
  --command "$TSX" \
  --args "$MCP_SCRIPT"

echo "Registered the local stdio server as companion-planning."
echo "Check it with: hermes mcp test companion-planning"
echo "Installed Companion Planning skills under $SKILLS_DEST."
echo "Check skill discovery with: hermes skills list"
