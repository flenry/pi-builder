# The Stack — Master Reference

> *"The scholars of Ohara stored all the world's knowledge in one place."*

This document is the single source of truth for your agentic productivity stack. Every component, every path, every fix procedure.

---

## Architecture Overview

```
YOU (Chief / Pirate King Ced)
│
├── pi (the harness)
│   ├── extensions — UI, safety, orchestration
│   ├── skills — loaded at startup, used on-demand
│   └── agents — specialist subprocesses
│
├── Ohara (the library)
│   ├── ohara.yaml — catalog of references
│   └── SKILL.md — the meta-skill that manages everything
│
├── pi-builder (the crew toolkit)
│   ├── extensions/ — all custom pi extensions
│   ├── .pi/agents/straw-hats/ — 12 specialist agents
│   ├── .pi/agents/agent-chain.yaml — 7 workflow pipelines
│   └── .pi/agents/teams.yaml — team groupings
│
└── Standalone skills
    ├── autoexperiment — autonomous optimization loop
    └── crew — orchestration reference skill
```

---

## Component Map

### Ohara — The Catalog
| Item | Path |
|---|---|
| **Source repo** | `~/code/ohara/` |
| **Installed (pi reads this)** | `~/.pi/agent/skills/ohara/` |
| **Catalog file** | `~/.pi/agent/skills/ohara/ohara.yaml` |
| **GitHub remote** | `git@github.com:flenry/ohara.git` |
| **Skill file** | `~/.pi/agent/skills/ohara/SKILL.md` |
| **Cookbooks** | `~/.pi/agent/skills/ohara/cookbook/` |

### pi-builder — Extensions & Launcher
| Item | Path |
|---|---|
| **Repo** | `~/code/pi-builder/` |
| **GitHub** | `https://github.com/flenry/pi-builder` |
| **Extensions** | `~/code/pi-builder/extensions/` |
| **Extension library manifest** | `~/code/pi-builder/pi-library.json` |
| **Damage control rules** | `~/code/pi-builder/.pi/damage-control-rules.yaml` |
| **Themes** | `~/code/pi-builder/.pi/themes/` |
| **Launch recipes** | `~/code/pi-builder/justfile` |
| **Prime command** | `~/code/pi-builder/.claude/commands/prime.md` |
| **Agent session files** | `~/code/pi-builder/.pi/agent-sessions/` *(gitignored)* |
| **Telemetry** | `~/code/pi-builder/.pi/agent-telemetry.json` *(gitignored)* |

> **Note:** Agent definitions and workflows have moved to the `crew` repo. pi-builder only keeps local copies in `.pi/agents/straw-hats/` for the chain/team extensions to load at runtime.

### crew — Agents & Workflows
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
| **Global settings** | `~/.pi/agent/settings.json` |
| **Global skills dir** | `~/.pi/agent/skills/` |
| **Global themes dir** | `~/.pi/agent/themes/` |
| **Global prompts dir** | `~/.pi/agent/prompts/` |

### Installed Global Skills
| Skill | Path | GitHub |
|---|---|---|
| **ohara** | `~/.pi/agent/skills/ohara/` | `github.com/flenry/ohara` |
| **crew** | `~/.pi/agent/skills/crew/` | `github.com/flenry/crew` |
| **autoexperiment** | `~/.pi/agent/skills/autoexperiment/` | local only |

### Skill / Agent Source Repos
| Repo | Path | Purpose | Registered in Ohara |
|---|---|---|---|
| **ohara** | `~/code/ohara/` | catalog manager | self |
| **crew** | `~/code/crew/` | agents + workflows | ✅ GitHub URLs |
| **autoexperiment** | `~/code/autoexperiment/` | optimization loop | ✅ local path |
| **pi-builder** | `~/code/pi-builder/` | extensions + launcher | not needed |

---

## The Straw Hat Crew

**Source of truth:** `~/code/crew/agents/` (GitHub: `flenry/crew`)
**Runtime copies** (loaded by pi-builder extensions): `~/code/pi-builder/.pi/agents/straw-hats/`

Each agent is a `.md` file with YAML frontmatter defining name, model, and tools, followed by the system prompt.

| Agent | File | Model | Role |
|---|---|---|---|
| Luffy | `luffy.md` | claude-sonnet-4-6 | Captain, orchestrator, dispatcher |
| Robin | `robin.md` | claude-sonnet-4-6 | Research, planning, PLAN.md |
| Zoro | `zoro.md` | claude-sonnet-4-6 | Backend, API, database |
| Sanji | `sanji.md` | claude-sonnet-4-6 | Frontend, React, CSS |
| Usopp | `usopp.md` | gpt-5-mini | QA, tests-first, edge cases |
| Law | `law.md` | gpt-5.4 | Code review, quality gates |
| Jinbe | `jinbe.md` | gpt-5-mini | Security, OWASP, access control |
| Franky | `franky.md` | claude-sonnet-4-6 | DevOps, Docker, CI/CD |
| Vegapunk | `vegapunk.md` | gemini-preview | Architecture, web research |
| Chopper | `chopper.md` | claude-haiku | Monitoring, health, diagnosis |
| Nami | `nami.md` | claude-haiku | Cost tracking, finance |
| Benn Beckman | `benn-beckman.md` | gpt-5.4 | Quant, trading strategy |

### Workflow Pipelines

**Source of truth:** `~/code/crew/workflows/agent-chain.yaml`
**Runtime copy** (used by agent-chain extension): `~/code/pi-builder/.pi/agents/agent-chain.yaml`

Select at runtime with `/chain`.

| Workflow | Pipeline | Best For |
|---|---|---|
| `build` | Robin → Usopp → Zoro → Law* | Backend TDD |
| `frontend` | Robin → Usopp → Sanji → Law* | Frontend TDD |
| `research` | Robin → Benn Beckman → Vegapunk* | Deep research |
| `audit` | Jinbe → Law → Robin | Security review |
| `recon` | Robin | Codebase exploration |
| `plan` | Robin → Law* | Planning only |
| `autoresearch` | Zoro | TypeScript fix loop |

*optional steps skipped with `fast: true`

---

## The Ohara Catalog

Current contents of `ohara.yaml` (at `~/.pi/agent/skills/ohara/ohara.yaml`):

**Skills**
- `autoexperiment` — local path `~/code/autoexperiment/SKILL.md`
- `crew` — `github.com/flenry/crew/blob/main/SKILL.md`

**Agents** (all from `github.com/flenry/crew/blob/main/agents/`)
- benn-beckman, chopper, franky, jinbe, law, luffy, nami, robin, sanji, usopp, vegapunk, zoro

**Prompts** — empty (add as needed)

---

## How Agents Know Where to Get Skills

On any session, run `/skill:ohara prime` or the `prime` command:

```
/prime
```

This tells the agent to:
1. Read the project context
2. Run `/skill:ohara list` — see everything available
3. Run `/skill:ohara search <keyword>` — find what's relevant
4. Install anything useful with `/skill:ohara use <name>`

This is the **discovery protocol** — agents don't have hardcoded knowledge of what's available. They query Ohara at the start of a session and equip themselves.

---

## Common Operations

### Start a workflow session
```bash
cd ~/code/pi-builder
just chain          # sequential pipeline — /chain to select workflow
just crew           # Luffy dispatches dynamically
```

### Add a new skill to Ohara
```
/skill:ohara add <name> from <path-or-github-url>
```
This registers it in `ohara.yaml`, auto-installs to `~/.pi/agent/skills/`, commits and pushes to GitHub.

### Pull latest Ohara catalog on a new device
```bash
git clone git@github.com:flenry/ohara.git ~/.pi/agent/skills/ohara
# Then update SKILL.md variables:
# OHARA_REPO_URL = git@github.com:flenry/ohara.git
# OHARA_YAML_PATH = ~/.pi/agent/skills/ohara/ohara.yaml
# OHARA_SKILL_DIR = ~/.pi/agent/skills/ohara/
```

### Install a catalogued skill to a project
```
/skill:ohara use crew          # install crew skill to .pi/skills/crew
/skill:ohara use robin         # install robin agent to .pi/agents/robin.md
/skill:ohara use robin globally  # install to ~/.pi/agent/agents/
```

### Sync all installed skills to latest
```
/skill:ohara sync
```

### Push a local edit back to source
```
/skill:ohara push <name>
```

### Update an agent's model or system prompt
The crew repo is the source of truth. Edit there, push, then sync the runtime copy:
```bash
# 1. Edit source
nano ~/code/crew/agents/<name>.md

# 2. Push to GitHub
cd ~/code/crew && git add agents/<name>.md && git commit -m "crew: <name> — <change>" && git push

# 3. Sync runtime copy into pi-builder (so chain/team extensions see it)
cp ~/code/crew/agents/<name>.md ~/code/pi-builder/.pi/agents/straw-hats/<name>.md
```

Or via Ohara on any device:
```
/skill:ohara use <name> globally
```

---

## Fix Procedures

### Ohara skill not appearing in pi (`/skill:ohara` missing)
1. Check the skill is installed: `ls ~/.pi/agent/skills/`
2. Check the SKILL.md is valid YAML: `head -6 ~/.pi/agent/skills/ohara/SKILL.md`
3. Run `/reload` in pi, or restart pi
4. If still missing: `cat ~/.pi/agent/skills/ohara/SKILL.md` — look for YAML errors in frontmatter (no `[` brackets in unquoted values)

### Ohara catalog out of sync between devices
```bash
cd ~/.pi/agent/skills/ohara && git pull
```
Or from within pi:
```
/skill:ohara sync
```

### Chain fails with "agent not found"
- The agent name in `agent-chain.yaml` must exactly match the `name:` field in the agent's `.md` frontmatter (lowercase, hyphen-separated)
- Check: `grep "^name:" ~/code/pi-builder/.pi/agents/straw-hats/*.md`

### Chain agent using wrong model
- Edit `~/code/pi-builder/.pi/agents/straw-hats/<name>.md`
- Change the `model:` field in frontmatter
- Available model IDs: check `~/.pi/agent/settings.json` or run `/model` in pi

### Agent session files growing large / context bloating
```bash
rm ~/code/pi-builder/.pi/agent-sessions/chain-*.json
```
Sessions auto-compact at 50KB but manual reset is clean for a fresh start.

### Telemetry data reset
```bash
rm ~/code/pi-builder/.pi/agent-telemetry.json
```

### pi-builder extension not loading
```bash
cd ~/code/pi-builder
bun install            # ensure dependencies are installed
bunx tsc --noEmit      # check for TypeScript errors
pi -e extensions/<name>.ts  # test loading manually
```

### New crew member not showing in `/chain`
- Restart pi or run `/new` — the chain extension reloads on session start
- Verify the agent file exists in `~/code/pi-builder/.pi/agents/straw-hats/` (the runtime copy)
- Source of truth is `~/code/crew/agents/` — sync with: `cp ~/code/crew/agents/<name>.md ~/code/pi-builder/.pi/agents/straw-hats/`

### crew repo and pi-builder out of sync
```bash
# Sync all agents from crew → pi-builder
cp ~/code/crew/agents/*.md ~/code/pi-builder/.pi/agents/straw-hats/
cp ~/code/crew/workflows/agent-chain.yaml ~/code/pi-builder/.pi/agents/
cp ~/code/crew/workflows/teams.yaml ~/code/pi-builder/.pi/agents/
```

### Ohara push fails (conflicts)
```bash
cd ~/.pi/agent/skills/ohara
git status             # see what's dirty
git stash              # stash local changes
git pull               # get latest
git stash pop          # reapply
# resolve any conflicts manually, then:
git add ohara.yaml && git commit -m "ohara: resolved conflict" && git push
```

---

## Extension Quick Reference

All extensions in `~/code/pi-builder/extensions/`. Load with `pi -e extensions/<name>.ts`.

| Extension | Launch | Use When |
|---|---|---|
| `tool-counter` | `just ext-tool-counter` | Always — best default footer |
| `damage-control` | `just ext-damage-control` | Working near production, infra, deploys |
| `agent-chain` | `just chain` | Structured TDD workflow |
| `agent-team` | `just crew` | Ad-hoc multi-agent dispatch via Luffy |
| `purpose-gate` | `just ext-purpose-gate` | When you need focus / single-purpose sessions |
| `tilldone` | `just ext-tilldone` | Task tracking across a session |
| `subagent-widget` | `just ext-subagent-widget` | Offload background tasks with `/sub` |
| `pi-pi` | `just ext-pi-pi` | Auto-configure pi for a new project |
| `theme-cycler` | `just ext-theme-cycler` | Theme switching (Ctrl+X/Ctrl+Q) |
| `scheduler` | `just ext-scheduler` | Recurring in-session tasks |
| `session-replay` | `just ext-session-replay` | Review session history |

Stack multiple: `pi -e extensions/tool-counter.ts -e extensions/theme-cycler.ts -e extensions/damage-control.ts`

---

## Updating This Document

This file lives at `~/code/pi-builder/STACK.md`.

After any structural change — new agent, new skill, new workflow, path changes — update the relevant section here. The rule: **if it took you more than 2 minutes to find something, it should be in this doc.**
