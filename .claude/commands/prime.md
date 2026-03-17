---
description: Load foundational context and equip the right tools before starting work
---

# Prime

Orient yourself, consult Ohara for relevant skills, then get to work.

## Workflow

### 1. Understand the project
```bash
git ls-files --others --cached --exclude-standard
```
Read: `justfile`, `CLAUDE.md` or `README.md` (whichever exists), `.pi/settings.json`

### 2. Consult Ohara
Check what skills and agents are available for this type of work:
```
/skill:ohara list
```
Then search for anything relevant to the task at hand:
```
/skill:ohara search <keyword>
```
If a relevant skill or agent exists and isn't installed locally, use it:
```
/skill:ohara use <name>
```

### 3. Summarize your loadout
Tell the user:
- **Project**: what it is, stack, key files
- **Skills active**: what skills are loaded in this session
- **Ohara catalog**: any skills/agents found relevant to the current task
- **Recommended workflow**: which chain or agent is best suited (if any)

## Ohara Quick Reference

| Command | What it does |
|---|---|
| `/skill:ohara list` | Show full catalog with install status |
| `/skill:ohara search <kw>` | Find skills/agents by keyword |
| `/skill:ohara use <name>` | Install a skill or agent locally |
| `/skill:ohara sync` | Pull latest versions of all installed items |

## Where Things Live

| Resource | Location |
|---|---|
| Ohara catalog | `~/.pi/agent/skills/ohara/ohara.yaml` |
| Global skills | `~/.pi/agent/skills/` |
| Project skills | `.pi/skills/` |
| Straw Hat agents | `~/code/pi-builder/.pi/agents/straw-hats/` |
| Workflows | `~/code/pi-builder/.pi/agents/agent-chain.yaml` |
| pi-builder extensions | `~/code/pi-builder/extensions/` |
| autoexperiment skill | `~/code/autoexperiment/` |
| crew skill | `~/code/crew/` |
