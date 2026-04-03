# pi-builder — CLAUDE.md

Quick-reference context for returning sessions. Read this first on every visit.

---

## What this repo is

The pi extension library — TypeScript source for all custom pi extensions, plus
bootstrap and sync scripts for setting up the full agentic stack on any machine.

---

## Key files

| File | Role | Editable? |
|---|---|---|
| `extensions/*.ts` | Pi extension source files | ✅ |
| `scripts/bootstrap.sh` | One-command setup on a new machine | ✅ |
| `scripts/crew-sync.sh` | Sync agents + chains from crew repo → global | ✅ |
| `justfile` | Launch recipes for every extension | ✅ |
| `tsconfig.json` | TypeScript config (paths wired to global pi packages) | ❌ Do not relax strictness |
| `package.json` | Bun deps (yaml only) | ❌ No new packages |
| `STACK.md` | Master reference for the full agentic stack | ✅ Keep updated |
| `.pi/skills/bowser.md` | Playwright skill (project-local) | ✅ |
| `.pi/themes/` | Custom pi themes | ✅ |
| `.pi/damage-control-rules.yaml` | Rules for the damage-control extension | ✅ |

---

## What lives elsewhere

| Thing | Where |
|---|---|
| Straw hat agents | `~/code/crew/agents/` → synced to `~/.pi/agent/agents/` via `crew-sync` |
| Chain workflows | `~/code/crew/workflows/` → synced to `~/.pi/agent/agents/` via `crew-sync` |
| Skills (seed, paul, ohara, etc.) | `~/.pi/agent/skills/` (global) |
| Bootstrap installs to | `~/.pi/agent/agents/`, `~/.pi/agent/skills/`, `~/.zshrc` |

---

## Extensions

All extensions in `extensions/`. Load with `pi -e extensions/<name>.ts` or via `justfile`.

Active (used in daily workflow):
- `agent-chain.ts` — sequential pipeline orchestrator (`pi-chain`)
- `agent-team.ts` — Luffy dispatcher (`pi-crew`)
- `project-context.ts` — injects CLAUDE.md + stack into agents
- `theme-cycler.ts` — Ctrl+X/Q theme switching

Available for ad-hoc use (via `justfile`):
- `damage-control.ts`, `tilldone.ts`, `subagent-widget.ts`, `scheduler.ts`
- `session-replay.ts`, `pi-pi.ts`, `pi-setup.ts`, `agent-builder.ts`
- `minimal.ts`, `tool-counter.ts`, `system-select.ts`, and others

---

## Type checking

```bash
cd ~/code/pi-builder
bunx tsc 2>&1 | grep "error TS"   # should show only project-context.ts pre-existing error
```

---

## SOP: Slash command autocomplete

Every user-facing feature MUST register a slash command via `pi.registerCommand()`.
See the command registry table in STACK.md.

---

## Simplicity principle

Fixes that use `// @ts-ignore` or cast to `any` → discard.
A correct 1-line fix > a workaround 10-line fix.

---

## Projects built via pi crew pipeline

| Project | Repo | Status | Notes |
|---|---|---|---|
| `polymarket-alpha` | `git@github.com:flenry/polymarket-alpha.git` | ✅ Phase 1 complete | 256 tests passing, pushed to main. Drizzle migration chain complete (`0000` + `0002_partition_trades`), `db:migrate:partitions` fallback script added. See `~/code/polymarket-alpha/CLAUDE.md` for full context. |

---

Last updated: 2026-04-03
