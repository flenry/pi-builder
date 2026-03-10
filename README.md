# pi-vs-cc

A collection of [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) customized instances. _Why?_ To showcase what it looks like to hedge against the leader in the agentic coding market, Claude Code. Here we showcase how you can customize the UI, agent orchestration tools, safety auditing, and cross-agent integrations. 

<div align="center">
  <img src="./images/pi-logo.png" alt="pi-vs-cc" width="700">
</div>

---

## Prerequisites

All three are required:

| Tool            | Purpose                   | Install                                                    |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| **Bun** ≥ 1.3.2 | Runtime & package manager | [bun.sh](https://bun.sh)                                   |
| **just**        | Task runner               | `brew install just`                                        |
| **pi**          | Pi Coding Agent CLI       | [Pi docs](https://github.com/mariozechner/pi-coding-agent) |

---

## API Keys

Pi does **not** auto-load `.env` files — API keys must be present in your shell's environment **before** you launch Pi. A sample file is provided:

```bash
cp .env.sample .env   # copy the template
# open .env and fill in your keys
```

`.env.sample` covers the four most popular providers:

| Provider         | Variable             | Get your key                                                                                               |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| OpenAI           | `OPENAI_API_KEY`     | [platform.openai.com](https://platform.openai.com/api-keys)                                                |
| Anthropic        | `ANTHROPIC_API_KEY`  | [console.anthropic.com](https://console.anthropic.com/settings/keys)                                       |
| Google           | `GEMINI_API_KEY`     | [aistudio.google.com](https://aistudio.google.com/app/apikey)                                              |
| OpenRouter       | `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai/keys)                                                                |
| Many Many Others | `***`                | [Pi Providers docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) |

### Sourcing your keys

Pick whichever approach fits your workflow:

**Option A — Source manually each session:**
```bash
source .env && pi
```

**Option B — One-liner alias (add to `~/.zshrc` or `~/.bashrc`):**
```bash
alias pi='source $(pwd)/.env && pi'
```

**Option C — Use the `just` task runner (auto-wired via `set dotenv-load`):**
```bash
just pi           # .env is loaded automatically for every just recipe
just ext-minimal  # works for all recipes, not just `pi`
```

---

## Installation

```bash
bun install
```

---

## Extensions

| Extension               | File                                | Description                                                                                                                                                |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pure-focus**          | `extensions/pure-focus.ts`          | Removes the footer bar and status line entirely — pure distraction-free mode                                                                               |
| **minimal**             | `extensions/minimal.ts`             | Compact footer showing model name and a 10-block context usage meter `[###-------] 30%`                                                                    |
| **cross-agent**         | `extensions/cross-agent.ts`         | Scans `.claude/`, `.gemini/`, `.codex/` dirs for commands, skills, and agents and registers them in Pi                                                     |
| **purpose-gate**        | `extensions/purpose-gate.ts`        | Prompts you to declare session intent on startup; shows a persistent purpose widget and blocks prompts until answered                                      |
| **tool-counter**        | `extensions/tool-counter.ts`        | Rich two-line footer: model + context meter + token/cost stats on line 1, cwd/branch + per-tool call tally on line 2                                       |
| **tool-counter-widget** | `extensions/tool-counter-widget.ts` | Live-updating above-editor widget showing per-tool call counts with background colors                                                                      |
| **subagent-widget**     | `extensions/subagent-widget.ts`     | `/sub <task>` command that spawns background Pi subagents; each gets its own streaming live-progress widget                                                |
| **tilldone**            | `extensions/tilldone.ts`            | Task discipline system — define tasks before starting work; tracks completion state across steps; shows persistent task list in footer with live progress  |
| **agent-team**          | `extensions/agent-team.ts`          | Dispatcher-only orchestrator: the primary agent delegates all work to named specialist agents via `dispatch_agent`; shows a grid dashboard                 |
| **system-select**       | `extensions/system-select.ts`       | `/system` command to interactively switch between agent personas/system prompts from `.pi/agents/`, `.claude/agents/`, `.gemini/agents/`, `.codex/agents/` |
| **damage-control**      | `extensions/damage-control.ts`      | Real-time safety auditing — intercepts dangerous bash patterns and enforces path-based access controls from `.pi/damage-control-rules.yaml`                |
| **agent-chain**         | `extensions/agent-chain.ts`         | Sequential pipeline orchestrator — chains multiple agents where each step's output feeds into the next step's prompt; use `/chain` to select and run       |
| **pi-pi**               | `extensions/pi-pi.ts`               | **One-command Pi builder** — auto-analyzes any repo and configures a complete Pi setup (extensions, skills, agents, themes, settings, justfile)             |
| **scheduler**           | `extensions/scheduler.ts`           | In-session recurring and one-shot task scheduling — `/schedule 30m run tests` fires automatically while you work                                           |
| **session-replay**      | `extensions/session-replay.ts`      | Scrollable timeline overlay of session history - showcasing customizable dialog UI                                                                         |
| **theme-cycler**        | `extensions/theme-cycler.ts`        | Keyboard shortcuts (Ctrl+X/Ctrl+Q) and `/theme` command to cycle/switch between custom themes                                                              |

---

## Pi Builder (pi-pi)

The **star of this repo**. Run one command to automatically configure Pi for any project:

```bash
just ext-pi-pi
```

Pi Pi will:
1. **Ask for the target project path** (the repo you want to configure)
2. **Auto-analyze** the project — languages, frameworks, build tools, infra, CI, existing config
3. **Query 9 domain experts in parallel** — extensions, themes, skills, config, TUI, prompts, agents, keybindings, CLI
4. **Copy relevant library extensions** from this repo's curated collection
5. **Create custom extensions** with project-specific tools, hooks, and commands
6. **Recommend marketplace packages** from the [Pi package registry](https://shittycodingagent.ai/packages)
7. **Generate a justfile** with recipes for launching Pi with different extension combos
8. **Write project instructions** (CLAUDE.md) with architecture context

### Why Extensions Matter

Pi's core is intentionally minimal — **extensions are the entire point**. They can:
- Register custom tools with structured parameters and rendered output
- Hook into every lifecycle event (session, input, tool calls, agent turns, compaction)
- Override the system prompt with project-specific context via `before_agent_start`
- Add commands (`/deploy`, `/test`, `/lint`), keyboard shortcuts, widgets, and custom footers
- Intercept and block dangerous operations
- Spawn sub-agents for parallel work

Pi Pi creates **both** generic utility extensions (from the library) **and** project-specific extensions that understand your codebase's architecture, conventions, and workflows.

### Documentation & Marketplace

- [Pi docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — Full reference
- [Extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — Extension API
- [Marketplace](https://shittycodingagent.ai/packages) — Community packages (`pi install <name>`)

---

## Usage

### Run a single extension

```bash
pi -e extensions/<name>.ts
```

### Stack multiple extensions

Extensions compose — pass multiple `-e` flags:

```bash
pi -e extensions/minimal.ts -e extensions/cross-agent.ts
```

### Use `just` recipes

`just` wraps the most useful combinations. Run `just` with no arguments to list all available recipes:

```bash
just
```

Common recipes:

```bash
just pi                     # Plain Pi, no extensions
just ext-pure-focus         # Distraction-free mode
just ext-minimal            # Minimal context meter footer
just ext-cross-agent        # Cross-agent command loading + minimal footer
just ext-purpose-gate       # Purpose gate + minimal footer
just ext-tool-counter       # Rich two-line footer with tool tally
just ext-tool-counter-widget # Per-tool widget above the editor
just ext-subagent-widget    # Subagent spawner with live progress widgets
just ext-tilldone           # Task discipline system with live progress tracking
just ext-agent-team         # Multi-agent orchestration grid dashboard
just ext-system-select      # Agent persona switcher via /system command
just ext-damage-control     # Safety auditing + minimal footer
just ext-agent-chain        # Sequential pipeline orchestrator with step chaining
just ext-pi-pi              # Meta-agent that builds Pi agents using parallel experts
just ext-session-replay     # Scrollable timeline overlay of session history
just ext-theme-cycler       # Theme cycler + minimal footer
just all                    # Open every extension in its own terminal window
```

The `open` recipe allows you to spin up a new terminal window with any combination of stacked extensions (omit `.ts`):

```bash
just open purpose-gate minimal tool-counter-widget
```

---

## Project Structure

```
pi-vs-cc/
├── extensions/          # Pi extension source files (.ts) — one file per extension
├── specs/               # Feature specifications for extensions
├── .pi/
│   ├── agent-sessions/  # Ephemeral session files (gitignored)
│   ├── agents/          # Agent definitions for team and chain extensions
│   │   ├── pi-pi/       # Expert agents for the pi-pi meta-agent
│   │   ├── agent-chain.yaml # Pipeline definition for agent-chain
│   │   ├── teams.yaml   # Team definition for agent-team
│   │   └── *.md         # Individual agent persona/system prompts
│   ├── skills/          # Custom skills
│   ├── themes/          # Custom themes (.json) used by theme-cycler
│   ├── damage-control-rules.yaml # Path/command rules for safety auditing
│   └── settings.json    # Pi workspace settings
├── justfile             # just task definitions
├── CLAUDE.md            # Conventions and tooling reference (for agents)
├── THEME.md             # Color token conventions for extension authors
└── TOOLS.md             # Built-in tool function signatures available in extensions
```

---


## Orchestrating Multi-Agent Workflows

Pi's architecture makes it easy to coordinate multiple autonomous agents. This playground includes several powerful multi-agent extensions:

### Subagent Widget (`/sub`)
The `subagent-widget` extension allows you to offload isolated tasks to background Pi agents while you continue working in the main terminal. Typing `/sub <task>` spawns a headless subagent that reports its streaming progress via a persistent, live-updating UI widget above your editor.

### Agent Teams (`/team`)
The `agent-team` orchestrator operates as a dispatcher. Instead of answering prompts directly, the primary agent reviews your request, selects a specialist from a defined roster, and delegates the work via a `dispatch_agent` tool.
- Teams are configured in `.pi/agents/teams.yaml` where each top-level key is a team name containing a list of agent names (e.g., `frontend: [planner, builder, bowser]`).
- Individual agent personas (e.g., `builder.md`, `reviewer.md`) live in `.pi/agents/`.
- **pi-pi Builder**: The `pi-pi` extension is a one-command Pi configurator. It auto-analyzes any target repo, dispatches 9 parallel expert subagents (extensions, themes, skills, config, TUI, prompts, agents, keybindings, CLI) to research Pi documentation, and then builds a complete setup — copying library extensions, creating custom project-specific extensions, recommending marketplace packages, and generating justfile recipes. See [Pi Builder](#pi-builder-pi-pi) above.

### Agent Chains (`/chain`)
Unlike the dynamic dispatcher, `agent-chain` acts as a sequential pipeline orchestrator. Workflows are defined in `.pi/agents/agent-chain.yaml` where the output of one agent becomes the input (`$INPUT`) to the next.
- Workflows are defined as a list of `steps`, where each step specifies an `agent` and a `prompt`. 
- The `$INPUT` variable injects the previous step's output (or the user's initial prompt for the first step), and `$ORIGINAL` always contains the user's initial prompt.
- Example: The `plan-build-review` pipeline feeds your prompt to the `planner`, passes the plan to the `builder`, and finally sends the code to the `reviewer`.

### Straw Hat Crews (One Piece themed)

Ported from the [Thousand Sunny](~/.openclaw/workspace/projects/thousand-sunny/) multi-agent orchestration system. 12 specialized agents with role-based routing and per-agent model selection:

| Agent | Role | Model | Specialty |
|-------|------|-------|-----------|
| **Luffy** | Captain | Opus | Orchestration, strategy, delegation |
| **Zoro** | Coder | Sonnet | Backend, API, database |
| **Sanji** | Cook | Sonnet | Frontend, UI/UX, React |
| **Robin** | Archaeologist | Sonnet | Deep research, knowledge synthesis |
| **Usopp** | Sniper | Haiku | QA, testing, edge cases |
| **Franky** | Shipwright | Sonnet | DevOps, Docker, CI/CD |
| **Jinbe** | Helmsman | Sonnet | Security audits, access control |
| **Law** | Surgeon | Sonnet | Code review, quality gates |
| **Vegapunk** | Scientist | Sonnet | Architecture, plan review |
| **Chopper** | Doctor | Haiku | Monitoring, error diagnosis |
| **Nami** | Navigator | Haiku | Cost tracking, finance |
| **Benn Beckman** | Quant | Opus | Trading strategy, market analysis |

**Teams** (in `teams.yaml`): `straw-hats` (all 12), `dev-crew`, `research-crew`, `ops-crew`, `quant-crew`

**Workflows** (in `agent-chain.yaml`) — all TDD-first, no orchestrator overhead:

| Workflow | Pipeline | Use case |
|----------|----------|----------|
| `full-implementation` | Robin → Vegapunk → Usopp (tests) → Zoro (build) → Usopp (QA) → Law → Jinbe | Complete dev cycle with plan review + security |
| `fast-implementation` | Robin → Usopp (tests) → Zoro (build) → Law | Quick TDD build |
| `frontend-implementation` | Robin → Usopp (tests) → Sanji (build) → Usopp (QA) → Law | Frontend with visual QA |
| `deep-research` | Robin → Benn Beckman → Vegapunk | Multi-pass validated research |
| `security-audit` | Jinbe → Law → Robin | Full security review with mitigations |
| `quant-analysis` | Benn Beckman → Robin → Nami | Trading strategy + cost analysis |

**Engineering approach**: Robin decomposes every task into chunks → atomic subtasks → each with a test assertion. Usopp writes failing tests for ALL subtasks before any code is written. Builder makes the tests pass. This enforces TDD at the workflow level.

**Luffy** is only used in team dispatcher mode (`just crew`) for ad-hoc routing — chains don't need an orchestrator.

```bash
just crew                    # Luffy dispatches dynamically to 12 specialists
just full-impl               # 7-step TDD pipeline
just fast-impl               # 4-step quick TDD
just frontend-impl           # Frontend TDD
just research                # Deep multi-pass research
just quant                   # Trading strategy analysis
```

---

## Safety Auditing & Damage Control

The `damage-control` extension provides real-time security hooks to prevent catastrophic mistakes when agents execute bash commands or modify files. It uses Pi's `tool_call` event to intercept and evaluate every action against `.pi/damage-control-rules.yaml`.

- **Dangerous Commands**: Uses regex (`bashToolPatterns`) to block destructive commands like `rm -rf`, `git reset --hard`, `aws s3 rm --recursive`, or `DROP DATABASE`. Some rules strictly block execution, while others (`ask: true`) pause execution to prompt you for confirmation.
- **Zero Access Paths**: Prevents the agent from reading or writing sensitive files (e.g., `.env`, `~/.ssh/`, `*.pem`).
- **Read-Only Paths**: Allows reading but blocks modifying system files or lockfiles (`package-lock.json`, `/etc/`).
- **No-Delete Paths**: Allows modifying but prevents deleting critical project configuration (`.git/`, `Dockerfile`, `README.md`).

---

## Extension Author Reference

Companion docs cover the conventions used across all extensions in this repo:

- **[COMPARISON.md](COMPARISON.md)** — Feature-by-feature comparison of Claude Code vs Pi Agent across 12 categories (design philosophy, tools, hooks, SDK, enterprise, and more).
- **[PI_VS_OPEN_CODE.md](PI_VS_OPEN_CODE.md)** — Architectural comparison of Pi Agent vs OpenCode (open-source Claude Code alternative) focusing on extension capabilities, event lifecycle, and UI customization.
- **[RESERVED_KEYS.md](RESERVED_KEYS.md)** — Pi reserved keybindings, overridable keys, and safe keys for extension authors.
- **[THEME.md](THEME.md)** — Color language: which Pi theme tokens (`success`, `accent`, `warning`, `dim`, `muted`) map to which UI roles, with examples.
- **[TOOLS.md](TOOLS.md)** — Function signatures for the built-in tools available inside extensions (`read`, `bash`, `edit`, `write`).

---

## Hooks & Events

Side-by-side comparison of lifecycle hooks in [Claude Code](https://docs.anthropic.com/en/docs/claude-code/hooks) vs [Pi Agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#events).

| Category            | Claude Code                                                      | Pi Agent                                                                                                                | Available In |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Session**         | `SessionStart`, `SessionEnd`                                     | `session_start`, `session_shutdown`                                                                                     | Both         |
| **Input**           | `UserPromptSubmit`                                               | `input`                                                                                                                 | Both         |
| **Tool**            | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`                | `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`                       | Both         |
| **Bash**            | —                                                                | `BashSpawnHook`, `user_bash`                                                                                            | Pi           |
| **Permission**      | `PermissionRequest`                                              | —                                                                                                                       | CC           |
| **Compact**         | `PreCompact`                                                     | `session_before_compact`, `session_compact`                                                                             | Both         |
| **Branching**       | —                                                                | `session_before_fork`, `session_fork`, `session_before_switch`, `session_switch`, `session_before_tree`, `session_tree` | Pi           |
| **Agent / Turn**    | —                                                                | `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`                                              | Pi           |
| **Message**         | —                                                                | `message_start`, `message_update`, `message_end`                                                                        | Pi           |
| **Model / Context** | —                                                                | `model_select`, `context`                                                                                               | Pi           |
| **Sub-agents**      | `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted` | —                                                                                                                       | CC           |
| **Config**          | `ConfigChange`                                                   | —                                                                                                                       | CC           |
| **Worktree**        | `WorktreeCreate`, `WorktreeRemove`                               | —                                                                                                                       | CC           |
| **System**          | `Stop`, `Notification`                                           | —                                                                                                                       | CC           |



## Resources

## Pi Documentation

| Doc                                                                                                     | Description                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [Mario's Twitter](https://x.com/badlogicgames)                                                          | Creator of Pi Coding Agent         |
| [README.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)              | Overview and getting started       |
| [sdk.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)               | TypeScript SDK reference           |
| [rpc.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)               | RPC protocol specification         |
| [json.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md)             | JSON event stream format           |
| [providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)   | API keys and provider setup        |
| [models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)         | Custom models (Ollama, vLLM, etc.) |
| [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) | Extension system                   |
| [skills.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)         | Skills (Agent Skills standard)     |
| [settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)     | Configuration                      |
| [compaction.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) | Context compaction                 |


## Master Agentic Coding
> Prepare for the future of software engineering

Learn tactical agentic coding patterns with [Tactical Agentic Coding](https://agenticengineer.com/tactical-agentic-coding?y=pivscc)

Follow the [IndyDevDan YouTube channel](https://www.youtube.com/@indydevdan) to improve your agentic coding advantage.
