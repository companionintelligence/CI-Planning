#!/usr/bin/env bash
# Register the local Companion Planning MCP server and install its skills in OpenClaw.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
TSX="$SERVER_DIR/node_modules/.bin/tsx"
MCP_SCRIPT="$SERVER_DIR/src/scripts/mcp-app-server.ts"
SKILLS_SOURCE="$REPO_ROOT/skills"
SKILLS_DEST="${HOME:?HOME must be set}/.openclaw/skills/companion-planning"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw not found on PATH" >&2
  exit 1
fi
if [[ ! -x "$TSX" ]]; then
  echo "Server dependencies are missing; run pnpm install from $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SERVER_DIR/mcp.local.env" ]]; then
  cp "$SERVER_DIR/mcp.local.env.example" "$SERVER_DIR/mcp.local.env"
  chmod 600 "$SERVER_DIR/mcp.local.env"
  echo "Created $SERVER_DIR/mcp.local.env. Add local app credentials there before using write tools."
fi

# OpenClaw discovers SKILL.md files in its user skills directory. Install only this
# namespaced pack; leave unrelated skill folders untouched.
mkdir -p "$SKILLS_DEST"
for skill in "$SKILLS_SOURCE"/*; do
  [[ -d "$skill" ]] || continue
  name="$(basename "$skill")"
  rm -rf "$SKILLS_DEST/$name"
  cp -R "$skill" "$SKILLS_DEST/$name"
done

# JSON encode paths so spaces or quotes in the checkout path remain valid.
config="$(python3 - "$TSX" "$MCP_SCRIPT" <<'PY'
import json, sys
print(json.dumps({"command": sys.argv[1], "args": [sys.argv[2]]}))
PY
)"
openclaw mcp set companion-planning "$config"

echo "Registered companion-planning with OpenClaw."
echo "Installed Companion Planning skills under $SKILLS_DEST."
echo "Check discovery with: openclaw mcp doctor companion-planning --probe"
echo "Check skills from the OpenClaw workspace with: openclaw skills list"
