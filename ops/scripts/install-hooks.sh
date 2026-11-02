#!/usr/bin/env bash
# Install pre-commit hook: typecheck + vitest unit tests
set -e
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.git/hooks/pre-commit"
cat > "$HOOK" << 'HOOK_EOF'
#!/usr/bin/env bash
set -e
echo "→ typecheck…"
pnpm run typecheck
echo "→ unit tests…"
pnpm --filter client exec vitest run --reporter=dot --project=unit
HOOK_EOF
chmod +x "$HOOK"
echo "✓ pre-commit hook installed at $HOOK"
