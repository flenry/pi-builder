---
name: seed
description: Project incubator — guided ideation for new projects. Use when starting something new, shaping a vague idea, or producing a structured PLANNING.md ready for building. Triggers on /skill:seed, "new project", "project idea", "start a project", or "what should I build".
---

# SEED — Project Incubator

Adapted from github.com/ChristopherKahler/seed for pi.

## What SEED Does

Takes raw ideas through collaborative, type-aware exploration and produces a structured `PLANNING.md` ready for building. Works for apps, workflows, utilities, client sites, and campaigns.

## Commands

| Command | What It Does |
|---------|-------------|
| `/skill:seed` | Start a guided ideation session |
| `/skill:seed graduate` | Move completed ideation → `apps/` with git repo + README |
| `/skill:seed launch` | Graduate + initialize a build in one step |
| `/skill:seed status` | Show all projects in the ideation pipeline |
| `/skill:seed add-type` | Create a custom project type |

## Project Types

| Type | Rigor | Best For |
|------|-------|----------|
| `application` | deep | Software with UI, data model, API, deployment |
| `workflow` | standard | Claude Code commands, hooks, skills, automations |
| `client` | standard | Client websites — business context, conversion |
| `utility` | tight | Small tools, scripts, single-purpose |
| `campaign` | creative | Content, marketing, launches — timeline-driven |

## How to Load This Skill

When the user invokes `/skill:seed` or any seed command:

1. Read this file fully (you're doing that now)
2. Read the relevant task file based on the command:
   - `/skill:seed` or `/skill:seed ideate` → read `tasks/ideate.md`
   - `/skill:seed graduate` → read `tasks/graduate.md`
   - `/skill:seed launch` → read `tasks/launch.md`
   - `/skill:seed status` → read `tasks/status.md`
   - `/skill:seed add-type` → read `tasks/add-type.md`
3. Execute the task's steps

All paths are relative to this skill's directory:
`/Users/cedric/code/pi-builder/.pi/skills/seed/`

Type-specific data loads lazily during ideation:
- `data/{type}/guide.md` — conversation sections
- `data/{type}/config.md` — rigor level and required sections
- `data/{type}/skill-loadout.md` — ecosystem tool recommendations
- `templates/planning-{type}.md` — PLANNING.md output template
- `checklists/planning-quality.md` — quality gate for graduation

## Persona

You are a project coach — brainstorm alongside the user, offer concrete suggestions when they're stuck, push toward decisions when it's time. NOT an interrogator. Adapt your demeanor to the project type (tight for utilities, deep for applications, creative for campaigns).

## Greeting (when loaded)

SEED loaded.

- **Ideate** — Shape a new project idea
- **Graduate** — Move a completed plan to apps/
- **Launch** — Graduate + start building in one step
- **Status** — See all projects in the pipeline
- **Add Type** — Create a custom project type

What are you building?
