# pi-builder

The extension library and launcher for the agentic workflow stack — built on [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent).

---

## New Machine Setup

Everything you need to get the full stack running on a fresh machine.

### One-command setup

```bash
bash <(curl -s https://raw.githubusercontent.com/flenry/pi-builder/main/scripts/bootstrap.sh)
```

This installs pi, clones all repos, deploys agents + chains + skills + extensions, writes `~/.pi/agent/CLAUDE.md` with global prefs, and adds shell functions to `~/.zshrc`.

After running, add your API keys to `~/.zshrc` and you're done.

> **Requires:** Node.js ≥ 24, SSH key for GitHub (for private `crew` + `ohara` repos)

---

### Manual setup (step by step)

### 1. Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| **Node.js** ≥ 24 | Runtime | [nvm](https://github.com/nvm-sh/nvm): `nvm install 24` |
| **pnpm** | Package manager | `npm install -g pnpm` |
| **just** | Task runner | `brew install just` |
| **pi** | Pi Coding Agent CLI | `npm install -g @mariozechner/pi-coding-agent` |
| **gh** | GitHub CLI (for PRs) | `brew install gh` |

### 2. Clone the repos

```bash
mkdir ~/code && cd ~/code
git clone git@github.com:flenry/pi-builder.git
git clone git@github.com:flenry/crew.git
git clone git@github.com:flenry/ohara.git
```

### 3. API Keys

Pi does not auto-load `.env` files — keys must be in your shell environment before launching.

```bash
cd ~/code/pi-builder
cp .env.sample .env
# fill in your keys, then:
echo 'source ~/code/pi-builder/.env' >> ~/.zshrc
source ~/.zshrc
```

| Provider | Variable | Get key |
|----------|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google | `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai/keys) |

### 4. Install dependencies

```bash
cd ~/code/pi-builder && bun install
```

### 5. Create global directories

```bash
mkdir -p ~/.pi/agent/{extensions,agents/straw-hats,skills}
```

### 6. Sync everything to global

```bash
cd ~/code/pi-builder && just sync
```

This copies:
- `~/code/crew/workflows/agent-chain.yaml` → `~/.pi/agent/agents/`
- `~/code/crew/agents/*.md` → `~/.pi/agent/agents/straw-hats/`
- `~/code/ohara/extensions/*.ts` → `~/.pi/agent/extensions/`

### 7. Global preferences

Create `~/.pi/agent/CLAUDE.md` with your personal preferences (loaded by every pi session):

```bash
cat > ~/.pi/agent/CLAUDE.md << 'EOF'
# Global Preferences

## Tooling
- Package manager: pnpm — never npm or yarn
- ORM: Drizzle — never Prisma
- Testing: Vitest — never Jest (E2E: Playwright)
- TypeScript: strict mode always

## Code Style
- Commits: imperative mood, under 50 chars, no trailing period
- File naming: kebab-case

## Running Tests (always use RAM-safe flags)
- Vitest: `npx vitest run --pool=forks --poolOptions.forks.maxForks=2`
- Jest:   `npx jest --runInBand --forceExit`
- pytest: `python -m pytest -x -q`

## Always Do
- Read CLAUDE.md at project root before starting any work
- Check `progress/todo/` for existing tasks before creating new ones
EOF
```

### 8. Launch your first chain

```bash
cd ~/code/your-project
cd ~/code/pi-builder && just chain
# then in pi: /chain to pick a workflow
```

---

## Workflow

The main workflow is chain-based. Run `just chain` from pi-builder, then `/chain` inside pi to select:

| Chain | What it does |
|-------|-------------|
| `research` | Multi-pass research — Robin explores, Benn validates, Vegapunk synthesises |
| `board-prd` | Write or update PRD.md via board process |
| `build` | Full TDD build — plan, tests, implement, docs |
| `do-todo` | Clear `progress/todo/` backlog — no planning phase |
| `full-test` | PRD-driven QA — runs app, tests, screenshots, writes verdict |
| `cr` | Change request — new feature or deliberate fix, ends with PR |
| `build-qwen` | Full TDD build — cheaper Qwen models |
| `cr-qwen` | Change request — cheaper Qwen models |
| `chat` | Brainstorm and discuss — no implementation |
| `recon` | Deep codebase recon — explore, validate, generate SYSTEM-MAP.html |
| `audit` | Security audit — Jinbe finds, Law validates, Robin mitigates |

**Standard flow for a new feature:**
```
research → build → full-test → [cr if adding more]
                ↑
           do-todo (when build stops mid-way or backlog has items)
```

Each chain reads `context/<stage>.md` and `handover/<prev-stage>.md` from your project. Run `/setup` in a new project to scaffold these files.

---

## Extensions

| Extension | Description |
|-----------|-------------|
| `agent-chain.ts` | Sequential pipeline orchestrator — powers `/chain` |
| `project-context.ts` | Injects `CLAUDE.md` + stack context into every agent |
| `theme-cycler.ts` | Ctrl+X/Q to cycle themes, `/theme` picker |
| `minimal.ts` | Compact footer: model name + context meter |
| `pure-focus.ts` | Removes footer and status line entirely |
| `tool-counter.ts` | Rich footer: model, tokens, cost, branch, tool tally |
| `tool-counter-widget.ts` | Per-tool call counts in a live widget |
| `subagent-widget.ts` | `/sub <task>` spawns background agents with live progress |
| `tilldone.ts` | Task discipline — define tasks before working |
| `scheduler.ts` | In-session recurring/one-shot scheduling |
| `system-select.ts` | `/system` to switch agent personas |
| `damage-control.ts` | Real-time safety auditing from `.pi/damage-control-rules.yaml` |
| `pi-setup.ts` | Analyse and configure pi for any project |
| `agent-builder.ts` | Generate project-specific agent `.md` files (`/agents-build`) |

### Ohara extensions (auto-loaded via `~/.pi/agent/extensions/`)

These live in `~/code/ohara/extensions/` and are synced by `just sync`:

| Extension | Commands | Description |
|-----------|----------|-------------|
| `new-project.ts` | `/setup` | 11-question interview → scaffolds full project structure |
| `progress.ts` | `/todo`, `/tasks`, `/done` | Task board — todo / for-review / completed |
| `memory.ts` | 10 knowledge graph tools | SQLite entity store (explicit use only) |

---

## Project Structure

```
pi-builder/
├── extensions/          # Pi extension source files
├── scripts/
│   └── bootstrap.sh     # One-command setup on a new machine
├── skills/              # Skill files (autoexperiment, frontend-design)
├── .pi/
│   ├── themes/          # Custom themes for theme-cycler
│   ├── skills/          # Project-local skills (bowser.md)
│   └── damage-control-rules.yaml
├── justfile             # Launch recipes
├── CLAUDE.md            # Project conventions (read by agents)
└── STACK.md             # Master reference for the full stack
```

---

## Just Recipes

```bash
just          # list all recipes
just chain    # sync + launch chain orchestrator (main workflow)
just sync     # sync crew + ohara to global ~/.pi/agent/

# Individual extensions
just ext-minimal
just ext-pure-focus
just ext-tool-counter
just ext-subagent-widget
just ext-tilldone
just ext-scheduler
just ext-damage-control
just ext-system-select
just ext-pi-setup
just ext-agent-builder
just ext-project-context
```

---

## The Crew

12 specialized agents defined in `~/code/crew/agents/`:

| Agent | Model | Role |
|-------|-------|------|
| Robin | Sonnet | Research, planning, PLAN.md |
| Zoro | Sonnet | Backend, API, database |
| Sanji | Sonnet | Frontend, React, CSS |
| Usopp | Sonnet | QA, tests-first, edge cases |
| Law | GPT-4 | Code review, severity-rated |
| Vegapunk | Gemini Pro | Architecture review, web research |
| Benn Beckman | GPT-4 | Quant, trading strategy |
| Jinbe | GPT-4 mini | Security, OWASP |
| Brook | Sonnet | Docs, README, git finalisation |
| Franky | Sonnet | DevOps, Docker, CI/CD |
| Chopper | Haiku | Monitoring, health, diagnosis |
| Nami | Haiku | Cost tracking |

---

## Resources

| Doc | Description |
|-----|-------------|
| [Pi README](https://github.com/mariozechner/pi-coding-agent) | Overview and getting started |
| [Extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Extension API |
| [Providers docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) | API keys and providers |
| [Pi TUI docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/tui.md) | TUI component reference |
