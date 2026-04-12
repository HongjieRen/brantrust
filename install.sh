#!/usr/bin/env bash
set -e

# braintrust installer — run once on a new machine
# Usage: bash install.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_TARGET="$HOME/.local/bin/braintrust"

echo "[braintrust] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

echo "[braintrust] Linking CLI command..."
mkdir -p "$HOME/.local/bin"
ln -sf "$SCRIPT_DIR/bin/braintrust" "$BIN_TARGET"
echo "  → $BIN_TARGET"

echo ""
echo "[braintrust] Registering MCP server with Claude Code..."
if command -v claude &>/dev/null; then
  # Register using the local server path (dev install).
  # For npm-based installs, pin to minor: npx -y braintrust-lite@~0.1
  claude mcp add braintrust-lite -- node "$SCRIPT_DIR/src/server.js" \
    && echo "  ✓ MCP server registered as 'braintrust-lite'" \
    || echo "  ✗ MCP registration failed (run manually: claude mcp add braintrust-lite -- node $SCRIPT_DIR/src/server.js)"
else
  echo "  ✗ claude CLI not found — install Claude Code first, then run:"
  echo "      claude mcp add braintrust-lite -- node $SCRIPT_DIR/src/server.js"
fi

echo ""
echo "[braintrust] Done. Verify prerequisites are installed:"
for cmd in claude codex gemini; do
  if command -v "$cmd" &>/dev/null; then
    echo "  ✓ $cmd"
  else
    echo "  ✗ $cmd  (not found — install separately)"
  fi
done

echo ""
echo "Run: braintrust \"your question\""
echo "     braintrust-doctor          (check all prerequisites)"
