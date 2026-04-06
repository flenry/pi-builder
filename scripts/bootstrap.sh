#!/usr/bin/env bash
# bootstrap.sh — set up the full pi agentic stack on a new machine
#
# Usage:
#   curl -s https://raw.githubusercontent.com/flenry/pi-builder/main/scripts/bootstrap.sh | bash
# or:
#   git clone https://github.com/flenry/pi-builder $CODE_DIR/pi-builder
#   bash $CODE_DIR/pi-builder/scripts/bootstrap.sh

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

log()  { echo -e "${GREEN}✓${RESET} $1"; }
info() { echo -e "${BLUE}→${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; exit 1; }
sep()  { echo -e "${DIM}────────────────────────────────────────${RESET}"; }

echo ""
echo -e "${BOLD}Pi Agentic Stack — Bootstrap${RESET}"
echo -e "${DIM}Sets up pi, crew, ohara, agents, skills, and shell functions${RESET}"
echo ""

# ── Code directory ────────────────────────────────
# Override with: CODE_DIR=~/projects bash bootstrap.sh
CODE_DIR="${CODE_DIR:-$HOME/code}"
echo -e "${BLUE}→${RESET} Code directory: ${BOLD}$CODE_DIR${RESET}"
echo -e "  ${DIM}Override with: CODE_DIR=~/projects bash bootstrap.sh${RESET}"
echo ""
mkdir -p "$CODE_DIR"
sep

# ── 1. Check prerequisites ────────────────────────
info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install via nvm: https://github.com/nvm-sh/nvm"
command -v git  >/dev/null 2>&1 || fail "git not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"

NODE_VER=$(node -e "process.stdout.write(process.version)")
log "Node.js $NODE_VER"

# ── 2. Install pi ─────────────────────────────────
sep
info "Installing pi..."

if command -v pi >/dev/null 2>&1; then
  log "pi already installed: $(pi --version 2>/dev/null || echo 'version unknown')"
else
  npm install -g @mariozechner/pi-coding-agent
  log "pi installed"
fi

# ── 3. Clone repos ────────────────────────────────
sep
info "Setting up repos..."

mkdir -p "$CODE_DIR"

# pi-builder (public)
if [[ -d $CODE_DIR/pi-builder ]]; then
  log "pi-builder already exists — pulling latest"
  cd $CODE_DIR/pi-builder && git pull --rebase origin main --quiet
else
  git clone https://github.com/flenry/pi-builder.git $CODE_DIR/pi-builder
  log "pi-builder cloned"
fi

# crew (private — SSH required)
if [[ -d $CODE_DIR/crew ]]; then
  log "crew already exists — pulling latest"
  cd $CODE_DIR/crew && git pull --rebase origin main --quiet
else
  info "Cloning crew (private repo — requires SSH key)..."
  if git clone git@github.com:flenry/crew.git $CODE_DIR/crew 2>/dev/null; then
    log "crew cloned"
  else
    warn "Could not clone crew — skipping (add SSH key and run: git clone git@github.com:flenry/crew.git $CODE_DIR/crew)"
  fi
fi

# ohara — clone to $CODE_DIR/ohara, then symlink to ~/.pi/agent/skills/ohara
if [[ -d $CODE_DIR/ohara ]]; then
  log "ohara already exists — pulling latest"
  cd $CODE_DIR/ohara && git pull --rebase origin main --quiet
else
  info "Cloning ohara (private repo — requires SSH key)..."
  if git clone git@github.com:flenry/ohara.git $CODE_DIR/ohara 2>/dev/null; then
    log "ohara cloned to $CODE_DIR/ohara"
  else
    warn "Could not clone ohara — skipping (add SSH key and run: git clone git@github.com:flenry/ohara.git $CODE_DIR/ohara)"
  fi
fi

# Symlink $CODE_DIR/ohara → ~/.pi/agent/skills/ohara so pi discovers it
if [[ -d $CODE_DIR/ohara ]] && [[ ! -e ~/.pi/agent/skills/ohara ]]; then
  mkdir -p ~/.pi/agent/skills
  ln -s $CODE_DIR/ohara ~/.pi/agent/skills/ohara
  log "ohara symlinked: ~/.pi/agent/skills/ohara → $CODE_DIR/ohara"
elif [[ -d $CODE_DIR/ohara ]]; then
  log "ohara skill link already exists"
fi

# ── 4. Install pi-builder deps ────────────────────
sep
info "Installing pi-builder dependencies..."
if command -v bun >/dev/null 2>&1; then
  cd $CODE_DIR/pi-builder && bun install --quiet
  log "bun install done"
elif command -v npm >/dev/null 2>&1; then
  cd $CODE_DIR/pi-builder && npm install --quiet
  log "npm install done"
else
  warn "Neither bun nor npm found — skipping (install deps manually in $CODE_DIR/pi-builder)"
fi

# ── 5. Set up global agents ───────────────────────
sep
info "Installing global agents..."
mkdir -p ~/.pi/agent/agents/straw-hats

if [[ -d $CODE_DIR/crew/agents ]]; then
  cp $CODE_DIR/crew/agents/*.md ~/.pi/agent/agents/straw-hats/
  cp $CODE_DIR/crew/workflows/agent-chain.yaml ~/.pi/agent/agents/
  cp $CODE_DIR/crew/workflows/teams.yaml ~/.pi/agent/agents/
  log "Straw hat agents + chains installed ($(ls ~/.pi/agent/agents/straw-hats/*.md | wc -l | tr -d ' ') agents)"
else
  # Fall back to pi-builder copies
  if [[ -d $CODE_DIR/pi-builder/.pi/agents/straw-hats ]]; then
    cp $CODE_DIR/pi-builder/.pi/agents/straw-hats/*.md ~/.pi/agent/agents/straw-hats/ 2>/dev/null || true
    cp $CODE_DIR/pi-builder/.pi/agents/agent-chain.yaml ~/.pi/agent/agents/ 2>/dev/null || true
    cp $CODE_DIR/pi-builder/.pi/agents/teams.yaml ~/.pi/agent/agents/ 2>/dev/null || true
    log "Agents installed from pi-builder (crew repo not available)"
  else
    warn "No agents found — skipping"
  fi
fi

# ── 6. Install global skills ──────────────────────
sep
info "Installing global skills..."
mkdir -p ~/.pi/agent/skills

# skill helper: copy from source if not already installed
install_skill() {
  local name="$1"
  local src="$2"
  local dst=~/.pi/agent/skills/$name

  if [[ -d "$dst" ]]; then
    log "$name already installed — skipping"
    return
  fi

  if [[ -d "$src" ]]; then
    cp -r "$src" "$dst"
    log "$name installed"
  else
    warn "$name source not found at $src — skipping"
  fi
}

# From pi-builder
install_skill "seed" $CODE_DIR/pi-builder/skills/seed
install_skill "paul" $CODE_DIR/pi-builder/skills/paul

# crew skill
if [[ -f $CODE_DIR/crew/SKILL.md ]]; then
  mkdir -p ~/.pi/agent/skills/crew
  cp $CODE_DIR/crew/SKILL.md ~/.pi/agent/skills/crew/
  log "crew skill installed"
fi

# autoexperiment — bundled in pi-builder/skills/
if [[ ! -d ~/.pi/agent/skills/autoexperiment ]]; then
  if [[ -d $CODE_DIR/pi-builder/skills/autoexperiment ]]; then
    cp -r $CODE_DIR/pi-builder/skills/autoexperiment ~/.pi/agent/skills/
    log "autoexperiment skill installed"
  else
    warn "autoexperiment skill not found in pi-builder/skills/"
  fi
else
  log "autoexperiment already installed"
fi

# ui-ux-pro-max — download from GitHub
if [[ ! -d ~/.pi/agent/skills/ui-ux-pro-max ]]; then
  info "Downloading ui-ux-pro-max skill..."
  mkdir -p ~/.pi/agent/skills/ui-ux-pro-max
  curl -s "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/.claude/skills/ui-ux-pro-max/SKILL.md" \
    -o ~/.pi/agent/skills/ui-ux-pro-max/SKILL.md \
    && log "ui-ux-pro-max skill installed" \
    || warn "Could not download ui-ux-pro-max skill"
else
  log "ui-ux-pro-max already installed"
fi

# frontend-design — bundled in pi-builder/skills/
if [[ ! -d ~/.pi/agent/skills/frontend-design ]]; then
  if [[ -d $CODE_DIR/pi-builder/skills/frontend-design ]]; then
    cp -r $CODE_DIR/pi-builder/skills/frontend-design ~/.pi/agent/skills/
    log "frontend-design skill installed"
  else
    warn "frontend-design skill not found in pi-builder/skills/"
  fi
else
  log "frontend-design already installed"
fi

# ── 6b. Global extensions ─────────────────────────
sep
info "Installing global extensions..."
mkdir -p ~/.pi/agent/extensions

if [[ -f $CODE_DIR/pi-builder/extensions/scheduler.ts ]]; then
  sed '/import.*themeMap/d; /applyExtensionDefaults/d' \
    $CODE_DIR/pi-builder/extensions/scheduler.ts \
    > ~/.pi/agent/extensions/scheduler.ts
  log "scheduler installed globally (~/.pi/agent/extensions/)"
else
  warn "scheduler.ts not found — skipping"
fi

# ── 6c. Global CLAUDE.md ─────────────────────────
sep
info "Writing global preferences to ~/.pi/agent/CLAUDE.md..."

if [[ -f ~/.pi/agent/CLAUDE.md ]]; then
  log "~/.pi/agent/CLAUDE.md already exists — skipping (edit manually to update)"
else
  mkdir -p ~/.pi/agent
  cat > ~/.pi/agent/CLAUDE.md << 'CLAUDE_EOF'
# Global Preferences

These apply to every project. Never deviate unless explicitly told otherwise.

## Tooling
- Package manager: pnpm — never npm or yarn
- ORM: Drizzle — never Prisma
- Testing: Vitest — never Jest (E2E: Playwright)
- TypeScript: strict mode always
- UI components: prefer shadcn/ui

## Code Style
- Commits: imperative mood, under 50 chars, no trailing period
- File naming: kebab-case
- Always dark mode in tools and generated UIs

## Running Tests (always use RAM-safe flags)
- Vitest: `npx vitest run --pool=forks --poolOptions.forks.maxForks=2`
- Jest:   `npx jest --runInBand --forceExit`
- pytest: `python -m pytest -x -q`
- Never run bare `vitest`, `vitest watch`, or `jest` — they spawn unlimited workers

## Always Do
- Read CLAUDE.md at project root before starting any work
- Check `progress/todo/` for existing tasks before creating new ones
CLAUDE_EOF
  log "~/.pi/agent/CLAUDE.md written"
fi

# ── 7. Pi settings ────────────────────────────────
sep
info "Configuring pi settings..."

SETTINGS=~/.pi/agent/settings.json
if [[ ! -f "$SETTINGS" ]] || ! grep -q '"defaultProvider"' "$SETTINGS" 2>/dev/null; then
  mkdir -p ~/.pi/agent
  cat > "$SETTINGS" << 'SETTINGS_EOF'
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "defaultThinkingLevel": "medium",
  "theme": "midnight-ocean",
  "enabledModels": [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5-20251001",
    "github-copilot/gemini-3.1-pro-preview",
    "github-copilot/gpt-5.4"
  ]
}
SETTINGS_EOF
  log "pi settings written"
else
  log "pi settings already configured"
fi

# ── 8. Shell functions ────────────────────────────
sep
info "Adding shell functions to ~/.zshrc..."

ZSHRC=~/.zshrc
MARKER="# ── Pi Crew/Chain commands (universal) ────────────"

if grep -q "$MARKER" "$ZSHRC" 2>/dev/null; then
  log "Shell functions already in ~/.zshrc"
else
  # Use printf to write with CODE_DIR expanded
  printf '\n# ── Pi Crew/Chain commands (universal) ────────────\n' >> "$ZSHRC"
  printf '_PI_EXT="%s/pi-builder/extensions"\n' "$CODE_DIR" >> "$ZSHRC"
  printf '\n' >> "$ZSHRC"
  printf 'pi-chain()    { pi -e "$_PI_EXT/project-context.ts" -e "$_PI_EXT/agent-chain.ts" -e "$_PI_EXT/theme-cycler.ts" "$@"; }\n' >> "$ZSHRC"
  printf 'pi-sync()     { cd "%s/pi-builder" && just sync; }\n' "$CODE_DIR" >> "$ZSHRC"
  log "Shell functions added to ~/.zshrc"
fi

# ── 9. API keys reminder ──────────────────────────
sep
echo ""
echo -e "${BOLD}Almost done!${RESET} Set your API keys:"
echo ""
echo -e "  ${BLUE}Anthropic${RESET}  (required)"
echo -e "  ${DIM}export ANTHROPIC_API_KEY=sk-ant-...${RESET}"
echo ""
echo -e "  ${BLUE}GitHub Copilot${RESET}  (for Law, Vegapunk, Usopp, Jinbe)"
echo -e "  ${DIM}Run: pi  then  /login  to authenticate via OAuth${RESET}"
echo ""
echo -e "  Add keys to ${DIM}~/.zshrc${RESET} or ${DIM}~/.pi/agent/.env${RESET}"
echo ""

# ── Done ──────────────────────────────────────────
sep
echo ""
echo -e "${GREEN}${BOLD}Bootstrap complete!${RESET}"
echo ""
echo -e "  ${DIM}Open a new terminal (or run: source ~/.zshrc)${RESET}"
echo ""
echo -e "  ${BOLD}Commands:${RESET}"
echo -e "  pi-chain      Open chain runner (workflow guide on startup)"
echo -e "  pi-chain      Open chain runner from any project directory"
echo -e "  pi-sync       Sync crew + ohara extensions to global ~/.pi/agent/"
echo ""
echo -e "  ${BOLD}Repos:${RESET}"
echo -e "  $CODE_DIR/pi-builder   Extensions + launch scripts"
echo -e "  $CODE_DIR/crew         Agents + workflows (source of truth)"
echo -e "  ~/.pi/agent/skills  Installed skills (seed, paul, ohara, ...)"
echo ""
