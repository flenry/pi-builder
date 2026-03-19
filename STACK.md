# The Stack — Master Reference

> *"The scholars of Ohara stored all the world's knowledge in one place."*

This document is the single source of truth for your agentic productivity stack. Every component, every path, every fix procedure.

Last updated: 2026-03-18

---

## Architecture Overview

```
YOU (Chief / Pirate King Ced)
│
├── pi (the harness — ~/.nvm/.../bin/pi)
│   ├── extensions — UI, safety, orchestration (auto-discovered or explicit -e)
│   ├── skills     — injected into system prompt, invoked via /skill:name
│   └── agents     — specialist subprocesses spawned by chain/team extensions
│
├── Ohara (the library — flenry/ohara)
│   ├── ohara.yaml — catalog of skills, agents, prompts, MCPs
│   └── SKILL.md   — the meta-skill that manages everything
│
├── crew (source of truth — flenry/crew, private)
│   ├── agents/    — 12 straw hat agent definitions
│   └── workflows/ — agent-chain.yaml + teams.yaml
│
├── pi-builder (extensions + runtime copies — flenry/pi-builder)
│   ├── extensions/                    — all custom pi extensions
│   ├── .pi/agents/straw-hats/         — runtime copies of crew agents
│   ├── .pi/agents/agent-chain.yaml    — runtime copy of crew workflows
│   ├── .pi/agents/teams.yaml          — runtime copy of crew teams
│   └── scripts/crew-sync.sh           — sync crew → global + pi-builder
│
└── Global pi config (~/.pi/agent/)
    ├── skills/        — autoexperiment, crew, ohara (+ bowser in projects)
    ├── agents/        — straw-hats/ + agent-chain.yaml + teams.yaml (global runtime)
    ├── settings.json  — default model, theme, provider
    └── sessions/      — session history
```

---

## Universal Commands (any repo, any terminal)

These shell functions are in `~/.zshrc` — work from any directory:

| Command | What it launches |
|---|---|
| `pi-crew` | Luffy dispatcher — routes to 12 specialists dynamically |
| `pi-chain` | Chain mode — `/chain` to pick a workflow at runtime |
| `pi-full` | Full TDD: Robin → Vegapunk → Usopp → Zoro → Usopp → Law → Jinbe → Brook |
| `pi-fast` | Fast TDD: Robin → Usopp → Zoro → Law → Brook |
| `pi-frontend` | Frontend TDD: Robin → Usopp → Sanji → Usopp → Law → Brook |
| `pi-research` | Deep research: Robin → Benn Beckman → Vegapunk |
| `pi-security` | Security audit: Jinbe → Law → Robin → Brook |
| `pi-quant` | Quant analysis: Benn Beckman → Robin → Nami |
| `crew-sync` | Sync agents + workflows from crew repo → global + pi-builder |

Extensions are loaded from `~/code/pi-builder/extensions/` via absolute paths.

---

## Component Map

### Ohara — The Catalog
| Item | Path |
|---|---|
| **Source repo** | `~/code/ohara/` |
| **Installed (pi reads this)** | `~/.pi/agent/skills/ohara/` |
| **Catalog file** | `~/.pi/agent/skills/ohara/ohara.yaml` |
| **GitHub remote** | `git@github.com:flenry/ohara.git` |

### pi-builder — Extensions & Launcher
| Item | Path |
|---|---|
| **Repo** | `~/code/pi-builder/` |
| **GitHub** | `https://github.com/flenry/pi-builder` |
| **Extensions** | `~/code/pi-builder/extensions/` |
| **Runtime agents** | `~/code/pi-builder/.pi/agents/straw-hats/` |
| **Runtime chains** | `~/code/pi-builder/.pi/agents/agent-chain.yaml` |
| **Runtime teams** | `~/code/pi-builder/.pi/agents/teams.yaml` |
| **Sync script** | `~/code/pi-builder/scripts/crew-sync.sh` |
| **Damage control rules** | `~/code/pi-builder/.pi/damage-control-rules.yaml` |
| **Launch recipes** | `~/code/pi-builder/justfile` |
| **Prime command** | `~/code/pi-builder/.claude/commands/prime.md` |

### crew — Source of Truth for Agents & Workflows
| Item | Path |
|---|---|
| **Repo** | `~/code/crew/` |
| **GitHub** | `https://github.com/flenry/crew` *(private)* |
| **Agent definitions** | `~/code/crew/agents/` |
| **Workflow pipelines** | `~/code/crew/workflows/agent-chain.yaml` |
| **Team definitions** | `~/code/crew/workflows/teams.yaml` |
| **Crew skill** | `~/code/crew/SKILL.md` |

### Global pi Config
| Item | Path |
|---|---|
| **Settings** | `~/.pi/agent/settings.json` |
| **Skills** | `~/.pi/agent/skills/` |
| **Global agents** | `~/.pi/agent/agents/` |
| **Sessions** | `~/.pi/agent/sessions/` |

---

## The Straw Hat Crew

**Source of truth:** `~/code/crew/agents/`
**Runtime copies:** `~/code/pi-builder/.pi/agents/straw-hats/` and `~/.pi/agent/agents/straw-hats/`

Keep in sync with: `crew-sync`

| Agent | Model | Role |
|---|---|---|
| Luffy | claude-sonnet-4-6 | Captain, orchestrator, dispatcher |
| Robin | claude-sonnet-4-6 | Research, planning, PLAN.md |
| Zoro | claude-sonnet-4-6 | Backend, API, database |
| Sanji | claude-sonnet-4-6 | Frontend, React, CSS |
| Brook | claude-sonnet-4-6 | Documentation — CLAUDE.md, README, INFRA.md |
| Franky | claude-sonnet-4-6 | DevOps, Docker, CI/CD |
| Usopp | gpt-5-mini | QA, tests-first, edge cases |
| Jinbe | gpt-5-mini | Security, OWASP, access control |
| Law | gpt-5.4 | Code review, quality gates |
| Benn Beckman | gpt-5.4 | Quant, trading strategy, MiroFish ensemble |
| Vegapunk | gemini-3.1-pro-preview | Architecture review, web research |
| Chopper | claude-haiku-4-5 | Monitoring, health, diagnosis |
| Nami | claude-haiku-4-5 | Cost tracking, finance |

---

## Workflow Pipelines

**Source of truth:** `~/code/crew/workflows/agent-chain.yaml`
**Runtime copy:** `~/code/pi-builder/.pi/agents/agent-chain.yaml` and `~/.pi/agent/agents/agent-chain.yaml`

Select at runtime with `/chain`. `*` = optional step (skipped in fast mode).

| Workflow | Pipeline |
|---|---|
| `full-implementation` | Robin → Vegapunk\* → Usopp → Zoro → Usopp\* → Law\* → Jinbe\* → Brook |
| `fast-implementation` | Robin → Usopp → Zoro → Law\* → Brook |
| `frontend-implementation` | Robin → Usopp → Sanji → Usopp\* → Law\* → Brook |
| `deep-research` | Robin → Benn Beckman → Vegapunk\* |
| `security-audit` | Jinbe → Law → Robin → Brook |
| `quant-analysis` | Benn Beckman → Robin → Nami |
| `plan-build-review` | Planner → Builder → Reviewer |
| `plan-build` | Planner → Builder |
| `plan-review-plan` | Planner → Plan-Reviewer → Planner |
| `scout-flow` | Scout × 3 (explore → validate → verify) |

---

## Installed Global Skills

Skills are auto-injected into the system prompt. Agents read them on-demand when the task matches.

| Skill | Path | Trigger |
|---|---|---|
| `ohara` | `~/.pi/agent/skills/ohara/` | `/skill:ohara` or mentions of ohara, skills, catalog |
| `crew` | `~/.pi/agent/skills/crew/` | `/skill:crew` or mentions of crew, straw hats, workflows |
| `autoexperiment` | `~/.pi/agent/skills/autoexperiment/` | `/skill:autoexperiment` or iterative optimization tasks |
| `bowser` | project `.pi/skills/bowser.md` | headless browser, playwright, visual QA tasks |

---

## The Ohara Catalog

Current contents of `~/.pi/agent/skills/ohara/ohara.yaml`:

**Skills:** autoexperiment, crew
**Agents (all from flenry/crew):** benn-beckman, chopper, franky, jinbe, law, luffy, nami, robin, sanji, usopp, vegapunk, zoro
**MCPs (configured but not yet wired into pi):** memory, github, postgres

---

## Common Operations

### Launch from any repo
```bash
pi-crew        # Luffy dispatches dynamically
pi-chain       # pick workflow with /chain
pi-fast        # fast TDD directly
pi-research    # deep research directly
```

### Sync agents + workflows after editing crew
```bash
crew-sync               # pull from GitHub, sync everywhere, auto-commit pi-builder
crew-sync --check       # dry run — show what's out of sync
```

### Add a new skill to Ohara
```
/skill:ohara add <name> from <path-or-github-url>
```

### Install a catalogued item to a project
```
/skill:ohara use crew            # install crew skill to .pi/skills/crew
/skill:ohara use robin           # install robin agent to .pi/agents/robin.md
/skill:ohara use robin globally  # install to ~/.pi/agent/agents/
```

### Sync Ohara across devices
```bash
cd ~/.pi/agent/skills/ohara && git pull
```

### Update an agent
1. Edit in `~/code/crew/agents/<name>.md`
2. `cd ~/code/crew && git add agents/<name>.md && git commit -m "..." && git push`
3. `crew-sync` — pulls latest and copies everywhere

### Reset agent sessions (context bloat)
```bash
rm ~/code/pi-builder/.pi/agent-sessions/chain-*.json
```

---

## Fix Procedures

### `pi-crew` or `pi-chain` not found
```bash
source ~/.zshrc
```
These are shell functions, not installed binaries.

### Chain fails with "agent not found"
Agent name in `agent-chain.yaml` must match `name:` frontmatter exactly (lowercase, hyphens).
```bash
grep "^name:" ~/.pi/agent/agents/straw-hats/*.md
```

### Agents out of sync between crew repo and runtime
```bash
crew-sync --check   # see what's different
crew-sync           # fix it
```

### Ohara skill not appearing (`/skill:ohara` missing)
```bash
ls ~/.pi/agent/skills/         # confirm it's installed
head -6 ~/.pi/agent/skills/ohara/SKILL.md   # check YAML frontmatter
# Then in pi: /reload
```

### Ohara push conflict
```bash
cd ~/.pi/agent/skills/ohara
git stash && git pull && git stash pop
git add ohara.yaml && git commit -m "ohara: resolved" && git push
```

### Chain agent on wrong model
Edit `~/code/crew/agents/<name>.md`, change `model:` frontmatter, then `crew-sync`.

### pi-builder extension not loading
```bash
cd ~/code/pi-builder && bunx tsc 2>&1 | grep "error TS"
pi -e extensions/<name>.ts   # test manually
```

---

## Extension Quick Reference

All extensions in `~/code/pi-builder/extensions/`. Load with `pi -e <path>` or via `just`.

| Extension | `just` recipe | Use When |
|---|---|---|
| `project-context` | *(included in pi-crew/pi-chain)* | Always — injects CLAUDE.md + stack into agents |
| `agent-team` | `just crew` | Ad-hoc dispatch — Luffy routes to right specialist |
| `agent-chain` | `just chain` | Structured TDD/research pipelines |
| `theme-cycler` | `just ext-theme-cycler` | Ctrl+X / Ctrl+Q theme cycling, `/theme` picker |
| `damage-control` | `just ext-damage-control` | Near production/infra — block dangerous ops |
| `tilldone` | `just ext-tilldone` | Task tracking across a session |
| `subagent-widget` | `just ext-subagent-widget` | Background tasks with `/sub` |
| `pi-setup` | `just ext-pi-setup` | Configure pi for a new project |
| `agent-builder` | `just ext-agent-builder` | Generate project-specific agent definitions |
| `pi-pi` | `just ext-pi-pi` | Build pi extensions via parallel expert research |
| `scheduler` | `just ext-scheduler` | Recurring in-session tasks |
| `session-replay` | `just ext-session-replay` | Review full session history |
| `tool-counter` | `just ext-tool-counter` | Footer with tool call counts |

---

## SOP: After Any Structural Change

| Change | Action |
|---|---|
| Edit an agent prompt | `crew-sync` |
| Add a new agent | Add to `~/code/crew/agents/`, add to `workflows/teams.yaml`, run `crew-sync` |
| Edit a workflow | Edit `~/code/crew/workflows/agent-chain.yaml`, run `crew-sync` |
| Add a new pi extension | Add `pi.registerCommand()`, update CLAUDE.md command registry table |
| Add a skill to Ohara | `/skill:ohara add <name> from <source>` |
| Change a model | Edit agent `.md` frontmatter in crew repo, `crew-sync` |

The rule: **if it took you more than 2 minutes to find something, it should be in this doc.**
