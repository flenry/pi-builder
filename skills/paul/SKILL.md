---
name: paul
description: Plan-Apply-Unify Loop — structured AI-assisted development. Use when starting a new project, planning a phase of work, executing a plan, or closing a work loop. Triggers on /skill:paul, "start building", "create a plan", "what should I build next", or after /skill:seed produces a PLANNING.md.
---

# PAUL — Plan-Apply-Unify Loop

Adapted from github.com/ChristopherKahler/paul for pi.

*"Quality over speed-for-speed's-sake. In-session context over subagent sprawl."*

## What PAUL Does

Structured AI-assisted development with three phases per unit of work:

```
PLAN ──▶ APPLY ──▶ UNIFY
Define    Execute    Reconcile & close
```

Every plan closes with UNIFY. No orphan plans. State persists across sessions.

## Commands

| Command | What It Does |
|---------|-------------|
| `/skill:paul init` | Initialize PAUL in a project (.paul/ structure) |
| `/skill:paul plan` | Create a PLAN.md for the next phase |
| `/skill:paul apply` | Execute an approved PLAN.md |
| `/skill:paul unify` | Reconcile plan vs actual, close the loop |
| `/skill:paul progress` | Show current state + ONE suggested next action |
| `/skill:paul resume` | Restore context after a session break |
| `/skill:paul handoff` | Generate a session handoff document |
| `/skill:paul pause` | Create handoff + update STATE.md before stopping |
| `/skill:paul discover` | Research technical options before planning |
| `/skill:paul research` | Research a topic using subagents |
| `/skill:paul discuss` | Explore phase vision before planning |
| `/skill:paul verify` | Guide manual acceptance testing |
| `/skill:paul audit` | Enterprise-grade architectural plan audit |
| `/skill:paul milestone` | Create a new milestone |
| `/skill:paul map-codebase` | Analyze and document the codebase |
| `/skill:paul help` | Show full command reference |

## The Loop

```
┌─────────────────────────────────────┐
│  PLAN ──▶ APPLY ──▶ UNIFY          │
│                                     │
│  Define    Execute    Reconcile     │
│  work      tasks      & close       │
└─────────────────────────────────────┘
```

**Never skip UNIFY.** Every plan needs a SUMMARY.

## Project Structure

```
.paul/
├── PROJECT.md          — what we're building and why
├── ROADMAP.md          — milestones and phases
├── STATE.md            — current position (read this first on resume)
├── config.md           — optional integrations (SonarQube, enterprise audit)
├── paul.json           — satellite manifest
├── phases/
│   └── 01-phase-name/
│       ├── 01-01-PLAN.md
│       ├── 01-01-SUMMARY.md
│       └── ...
└── HANDOFF-*.md        — session continuity docs
```

## How to Load This Skill

When the user invokes `/skill:paul` or any paul command:

1. Read this SKILL.md fully (you're doing that now)
2. Identify the command from the invocation
3. Read the corresponding command file from `commands/<cmd>.md`
4. The command file references workflow files — read those too
5. Execute the workflow steps

**Skill directory:** `/Users/cedric/.pi/agent/skills/paul/`

All `@path/` references in command and workflow files are absolute paths.

**Command routing:**
- `/skill:paul` or `/skill:paul init` → `commands/init.md`
- `/skill:paul plan` → `commands/plan.md`
- `/skill:paul apply` → `commands/apply.md`
- `/skill:paul unify` → `commands/unify.md`
- `/skill:paul progress` → `commands/progress.md`
- `/skill:paul resume` → `commands/resume.md`
- `/skill:paul handoff` → `commands/handoff.md`
- `/skill:paul pause` → `commands/pause.md`
- `/skill:paul discover` → `commands/discover.md`
- `/skill:paul research` → `commands/research.md`
- `/skill:paul discuss` → `commands/discuss.md`
- `/skill:paul verify` → `commands/verify.md`
- `/skill:paul audit` → `commands/audit.md`
- `/skill:paul milestone` → `commands/milestone.md`
- `/skill:paul map-codebase` → `commands/map-codebase.md`
- `/skill:paul help` → `commands/help.md`
- `/skill:paul flows` → `commands/flows.md`

## Integration with SEED

PAUL picks up where SEED leaves off:

```
/skill:seed    →  PLANNING.md
/skill:paul init  →  .paul/ structure from PLANNING.md
/skill:paul plan  →  first PLAN.md
```

After `/skill:seed graduate`, run `/skill:paul init` in the graduated `apps/<name>/` directory.
Pass the PLANNING.md as context — PAUL derives phases without re-asking questions.

## Greeting (when loaded with no subcommand)

PAUL loaded.

Quick start:
1. `/skill:paul init` — set up PAUL in this project
2. `/skill:paul plan` — create your first plan
3. `/skill:paul apply` — execute an approved plan
4. `/skill:paul unify` — close the loop

Resuming? `/skill:paul resume` — restores context and suggests ONE next action.
