#!/usr/bin/env bash
# crew-sync — sync agents, chains, and teams from crew repo → global + pi-builder
# Usage: crew-sync [--check]
#   --check   dry run, show what's out of sync without copying

set -euo pipefail

CREW="$HOME/code/crew"
PI_BUILDER="$HOME/code/pi-builder"
GLOBAL_AGENTS="$HOME/.pi/agent/agents"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

# ── Verify crew repo exists ───────────────────────
if [[ ! -d "$CREW" ]]; then
  echo -e "${RED}error:${RESET} crew repo not found at $CREW"
  exit 1
fi

echo -e "${DIM}crew-sync — syncing from $CREW${RESET}"
echo ""

CHANGES=0

sync_file() {
  local src="$1"
  local dst="$2"
  local label="$3"

  if [[ ! -f "$src" ]]; then
    echo -e "  ${RED}missing${RESET}  $label  ${DIM}(src: $src)${RESET}"
    return
  fi

  if [[ ! -f "$dst" ]] || ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    CHANGES=$((CHANGES + 1))
    if $CHECK_ONLY; then
      echo -e "  ${YELLOW}outdated${RESET}  $label"
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      echo -e "  ${GREEN}synced${RESET}    $label"
    fi
  else
    echo -e "  ${DIM}ok${RESET}        $label"
  fi
}

# ── Pull latest from GitHub first ────────────────
if ! $CHECK_ONLY; then
  echo "Pulling latest crew from GitHub..."
  cd "$CREW" && git pull --rebase --quiet origin main 2>/dev/null || echo -e "  ${YELLOW}warning:${RESET} git pull failed — syncing from local"
  echo ""
fi

# ── Sync agents ───────────────────────────────────
echo "Agents:"
for src in "$CREW/agents/"*.md; do
  name=$(basename "$src")
  sync_file "$src" "$GLOBAL_AGENTS/straw-hats/$name"    "~/.pi/agent/agents/straw-hats/$name"
  sync_file "$src" "$PI_BUILDER/.pi/agents/straw-hats/$name" "pi-builder/.pi/agents/straw-hats/$name"
done

echo ""
echo "Workflows:"
sync_file "$CREW/workflows/agent-chain.yaml" "$GLOBAL_AGENTS/agent-chain.yaml"          "~/.pi/agent/agents/agent-chain.yaml"
sync_file "$CREW/workflows/agent-chain.yaml" "$PI_BUILDER/.pi/agents/agent-chain.yaml"  "pi-builder/.pi/agents/agent-chain.yaml"
sync_file "$CREW/workflows/teams.yaml"       "$GLOBAL_AGENTS/teams.yaml"                "~/.pi/agent/agents/teams.yaml"
sync_file "$CREW/workflows/teams.yaml"       "$PI_BUILDER/.pi/agents/teams.yaml"        "pi-builder/.pi/agents/teams.yaml"

echo ""

if $CHECK_ONLY; then
  if [[ $CHANGES -eq 0 ]]; then
    echo -e "${GREEN}✓ everything in sync${RESET}"
  else
    echo -e "${YELLOW}$CHANGES file(s) out of sync — run crew-sync to update${RESET}"
    exit 1
  fi
else
  if [[ $CHANGES -eq 0 ]]; then
    echo -e "${GREEN}✓ already in sync — nothing to do${RESET}"
  else
    echo -e "${GREEN}✓ synced $CHANGES file(s)${RESET}"

    # Commit pi-builder changes if any
    cd "$PI_BUILDER"
    if ! git diff --quiet .pi/agents/; then
      git add .pi/agents/
      git commit -m "sync: crew agents + workflows from flenry/crew"
      git push origin main
      echo -e "${DIM}pi-builder pushed to GitHub${RESET}"
    fi
  fi
fi
