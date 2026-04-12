#!/usr/bin/env bash
# braintrust-lite installer
#
# Usage — three ways:
#
#   1. One-liner (new machine, no clone needed):
#      curl -fsSL https://raw.githubusercontent.com/HongjieRen/braintrust-lite/main/install.sh | bash
#
#   2. After git clone (local dev):
#      bash install.sh
#
#   3. Via npm (after publishing):
#      npx -y braintrust-lite@~0.1 setup

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
fail() { echo -e "  ${RED}✗${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!${NC}  $1"; }

SKILL_URL="https://raw.githubusercontent.com/HongjieRen/braintrust-lite/main/skills/consult/SKILL.md"
SKILL_DIR="$HOME/.claude/skills/consult"
SKILL_PATH="$SKILL_DIR/SKILL.md"

echo ""
echo "braintrust-lite installer"
echo ""

# ── Detect install mode ────────────────────────────────────────────────────────

# SCRIPT_DIR is only meaningful when run from a local clone, not via curl pipe
if [ -n "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
else
  SCRIPT_DIR=""
fi

LOCAL_INSTALL=false
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/server.js" ]; then
  LOCAL_INSTALL=true
fi

# ── Step 1: Install consult SKILL.md ──────────────────────────────────────────

echo "Installing consult skill:"
mkdir -p "$SKILL_DIR"

# Backup if exists
if [ -f "$SKILL_PATH" ]; then
  cp "$SKILL_PATH" "${SKILL_PATH}.bak" 2>/dev/null || true
fi

# Copy from local repo if available, otherwise fetch from GitHub
if [ "$LOCAL_INSTALL" = true ] && [ -f "$SCRIPT_DIR/skills/consult/SKILL.md" ]; then
  cp "$SCRIPT_DIR/skills/consult/SKILL.md" "$SKILL_PATH"
  VER=$(awk '/^version:/ {print $2; exit}' "$SKILL_PATH")
  ok "SKILL.md installed from local repo  (v$VER)"
else
  if curl -fsSL --max-time 15 "$SKILL_URL" -o "$SKILL_PATH"; then
    VER=$(awk '/^version:/ {print $2; exit}' "$SKILL_PATH")
    ok "SKILL.md downloaded from GitHub  (v$VER)"
  else
    fail "SKILL.md download failed"
    warn "Manual install: curl -fsSL $SKILL_URL -o $SKILL_PATH"
  fi
fi

# ── Step 2: Register MCP server ───────────────────────────────────────────────

echo ""
echo "Registering MCP server:"

if ! command -v claude &>/dev/null; then
  fail "claude CLI not found — install Claude Code first"
  warn "Then run: claude mcp add braintrust-lite -- npx -y braintrust-lite@~0.1"
else
  # Check if already registered
  if claude mcp list 2>/dev/null | grep -q "braintrust-lite"; then
    ok "MCP server already registered"
  else
    if [ "$LOCAL_INSTALL" = true ]; then
      # Dev install: use local path
      MCP_CMD="node $SCRIPT_DIR/src/server.js"
      if claude mcp add braintrust-lite -- node "$SCRIPT_DIR/src/server.js" 2>/dev/null; then
        ok "MCP server registered  (local: $SCRIPT_DIR/src/server.js)"
      else
        fail "MCP registration failed"
        warn "Manual: claude mcp add braintrust-lite -- node $SCRIPT_DIR/src/server.js"
      fi
    else
      # npm/curl install: use npx with pinned minor version
      if claude mcp add braintrust-lite -- npx -y braintrust-lite@~0.1 2>/dev/null; then
        ok "MCP server registered  (npx braintrust-lite@~0.1)"
      else
        fail "MCP registration failed"
        warn "Manual: claude mcp add braintrust-lite -- npx -y braintrust-lite@~0.1"
      fi
    fi
  fi
fi

# ── Step 3: Local npm dependencies (dev install only) ─────────────────────────

if [ "$LOCAL_INSTALL" = true ]; then
  echo ""
  echo "Installing npm dependencies:"
  cd "$SCRIPT_DIR" && npm install --silent && ok "npm install done"
fi

# ── Step 4: Check prerequisites ───────────────────────────────────────────────

echo ""
echo "Checking CLI prerequisites:"
for cmd in claude codex gemini; do
  if command -v "$cmd" &>/dev/null; then
    VER=$("$cmd" --version 2>&1 | head -1 | cut -c1-40)
    ok "$cmd  ($VER)"
  else
    fail "$cmd not found — install separately"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "  ${GREEN}Done! Restart Claude Code, then use /consult in any conversation.${NC}"
echo ""
