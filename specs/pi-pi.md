# Pi Pi — One-Command Pi Builder

## Purpose

Run one command → Pi Pi auto-analyzes the repo → queries domain experts in parallel → builds a complete, tailored Pi configuration (extensions, skills, agents, themes, settings, justfile).

## Usage

```bash
pi -e extensions/pi-pi.ts
```

That's it. On session start, Pi Pi:
1. Scans the repo (languages, frameworks, build tools, infra, CI, existing `.pi/` config)
2. Matches against the extension library (`pi-library.json`)
3. Sends the analysis as an auto-prompt to the orchestrator
4. The orchestrator reads key project files, queries experts in parallel, then builds everything

## Architecture

```
Session Start
    │
    ▼
┌──────────────────────────────────┐
│  analyzeProject()                │
│  Scan: package.json, go.mod,    │
│  Dockerfile, CI, README, etc.   │
│  Match: pi-library.json scores  │
└──────┬───────────────────────────┘
       │ auto-inject via pi.sendUserMessage()
       ▼
┌──────────────────────────────────┐
│  Orchestrator ("Pi Pi")          │
│  Tools: read,write,edit,bash,    │
│         grep,find,ls,            │
│         query_experts            │
│                                  │
│  1. Reads key project files      │
│  2. Queries experts in parallel  │
│  3. Copies library extensions    │
│  4. Creates custom extensions    │
│  5. Writes justfile, settings    │
└──────┬───────────────────────────┘
       │ query_experts (parallel)
       ▼
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ext-     │theme-   │skill-   │config-  │tui-     │prompt-  │agent-   │keybind- │cli-     │
│expert   │expert   │expert   │expert   │expert   │expert   │expert   │expert   │expert   │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

## What It Builds

### From the Library (copy)
- Extensions: minimal, tool-counter, theme-cycler, damage-control, tilldone, etc.
- Skills: bowser (for frontend projects)
- Agent templates: scout, planner, builder, reviewer, documenter, red-team
- Themes: 11 pre-built themes
- themeMap.ts (dependency of most extensions)

### Custom (generated per-repo)
- **Project-specific extensions** with tools tailored to the codebase
  - e.g., `run-tests` that knows the exact test command and interprets output
  - e.g., `deploy` with the right flags for this project
  - e.g., `before_agent_start` hook injecting project context
- **Custom skills** for the project's domain
- **Custom agent definitions** that know the architecture
- **Justfile** with recipes for all extension combos
- **CLAUDE.md** with Pi usage instructions
- **.pi/settings.json** with sensible defaults

## Auto-Analysis

The `analyzeProject()` function detects:
- **Languages**: JS/TS, Python, Go, Rust, Java/Kotlin
- **Frameworks**: React, Vue, Angular, Next.js, Express, Django, Flask, FastAPI, NestJS, etc.
- **Build tools**: Make, just, Task, Gradle, CMake
- **Infrastructure**: Docker, Kubernetes, Terraform, AWS CDK, Serverless
- **CI/CD**: GitHub Actions, GitLab CI
- **Databases**: PostgreSQL, MongoDB, Redis
- **Testing**: Playwright, Cypress, Vitest, Jest, pytest
- **Existing config**: `.pi/`, `.claude/`, `.gemini/`, `.cursor/`
- **Monorepo detection**: multiple package.json/go.mod files

## Key Files

- `extensions/pi-pi.ts` — Main extension
- `.pi/agents/pi-pi/pi-orchestrator.md` — Orchestrator system prompt
- `.pi/agents/pi-pi/*.md` — 9 domain expert definitions
- `pi-library.json` — Extension/skill/agent library registry

## Commands

- `/experts` — list experts and their status
- `/experts-grid N` — set dashboard columns (1-5)
- `/analyze` — re-run project analysis
