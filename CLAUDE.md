# pi-builder — CLAUDE.md

Quick-reference context for returning sessions. Read this first on every visit.

---

## What this repo is

A collection of Pi Coding Agent extensions (TypeScript). The autoresearch loop fixes type
errors and implements new extensions autonomously, driving `type_errors` from 27 → 0 → beyond.

---

## Key files

| File | Role | Editable? |
|---|---|---|
| `extensions/*.ts` | Pi extension source files | ✅ Agent edits these |
| `specs/agent-forge.md` | Spec for unimplemented Agent Forge extension | ❌ Read-only |
| `specs/agent-workflow.md` | Spec for unimplemented Chronicle extension | ❌ Read-only |
| `specs/pi-pi.md` | Spec for pi-pi (already implemented) | ❌ Read-only |
| `specs/damage-control.md` | Spec for damage-control (already implemented) | ❌ Read-only |
| `tsconfig.json` | TypeScript config (paths wired to global pi packages) | ❌ Do not relax strictness |
| `program.md` | Autoresearch agent instructions | ✅ Human iterates |
| `justfile` | just task runner | ❌ Read-only |
| `package.json` | Bun deps (yaml only) | ❌ No new packages |
| `results.tsv` | Experiment log (untracked) | Written by agent |

---

## The metric

**`type_errors`** — total TypeScript errors from `bunx tsc`. **Lower is better.** Baseline: **27**.

```bash
bunx tsc 2>&1 | grep "error TS" | wc -l          # → integer, the metric
bunx tsc 2>&1 | grep "error TS"                   # → full error list
bunx tsc 2>&1 | grep "error TS" | \
  sed 's/(.*$//' | sort | uniq -c | sort -rn       # → errors per file
```

---

## Baseline state (27 errors across 11 files)

| File | Errors | Notes |
|---|---|---|
| `subagent-widget.ts` | 7 | implicit `any` params |
| `scheduler.ts` | 4 | invalid `"success"` notify type |
| `damage-control.ts` | 3 | `notify()` wrong arg count |
| `tool-counter.ts` | 2 | |
| `system-select.ts` | 2 | |
| `pi-pi.ts` | 2 | `pct` possibly null |
| `agent-team.ts` | 2 | `pct` possibly null |
| `agent-chain.ts` | 2 | `pct` possibly null |
| `theme-cycler.ts` | 1 | |
| `session-replay.ts` | 1 | `getMarkdownTheme` not exported |
| `pi-setup.ts` | 1 | `undefined` as index |

---

## Unimplemented specs (top priority after errors reach 0)

| Spec | Target file | Key features |
|---|---|---|
| `specs/agent-forge.md` | `extensions/agent-forge.ts` | `forge_tool`, `use_forge_tool`, `list_forge`, forge widget, registry JSON |
| `specs/agent-workflow.md` | `extensions/agent-workflow.ts` | `workflow_transition`, `workflow_update_snapshot`, timeline widget, ledger persistence |

---

## Allowed imports

```typescript
import type { ExtensionAPI, ExtensionContext, Theme, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType, DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Text, Container, truncateToWidth, visibleWidth, matchesKey } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { applyExtensionDefaults } from "./themeMap.ts";
```

---

## Extension structure

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    applyExtensionDefaults(import.meta.url, ctx);  // apply theme defaults
    // ... setup
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType(event, "bash")) return;
    // intercept bash calls
  });
}
```

---

## Events reference

| Event | Trigger |
|---|---|
| `session_start` | Pi session starts |
| `session_shutdown` | Pi session ends |
| `before_agent_start` | Before agent LLM call — inject system prompt additions here |
| `agent_start` / `agent_end` | Agent turn begins/ends |
| `input` | User types a message |
| `tool_call` | Agent about to call a tool |
| `tool_result` | Tool returned a result |
| `turn_start` / `turn_end` | LLM turn start/end |

---

## UI API

```typescript
// Footer (replaces default)
ctx.ui.setFooter((_tui, theme, _footerData) => ({
  dispose: () => {},
  invalidate() {},
  render(width: number): string[] { return [line1, line2]; }
}));

// Above-editor widget
ctx.ui.setWidget("my-widget", (_tui, theme) => ({
  dispose: () => {},
  invalidate() {},
  render(width: number): string[] { return [line1]; }
}));
ctx.ui.removeWidget("my-widget");

// Notifications — type must be "info" | "error" | "warning" | undefined
ctx.ui.notify("message", "info");
ctx.ui.notify("message", "error");
ctx.ui.notify("message");           // no type = default

// Commands
ctx.ui.registerCommand("mycommand", async (args, ctx) => { ... });
```

---

## Tool registration

```typescript
pi.registerTool(
  {
    name: "my_tool",
    description: "What this tool does",
    parameters: Type.Object({
      input: Type.String({ description: "The input" }),
      count: Type.Optional(Type.Number()),
    }),
  },
  async (params, ctx) => {
    return { result: "value", display: "Human-readable output" };
  }
);
```

---

## Theme colors

```typescript
theme.fg("dim", text)      // muted/secondary text
theme.fg("muted", text)    // even more muted
theme.fg("accent", text)   // highlight color
theme.fg("success", text)  // green-ish
theme.fg("warning", text)  // yellow-ish
theme.fg("error", text)    // red-ish
```

---

## Context usage

```typescript
const usage = ctx.getContextUsage();
// usage?.percent: number | null  — 0-100, can be null before first turn
const pct = usage?.percent ?? 0;  // always use ?? 0 not || 0
```

---

## Workflow commands

```bash
# Start new research branch
git checkout -b autoresearch/mar15

# Run type check (THE metric)
bunx tsc 2>&1 | grep "error TS" | wc -l

# Per-file breakdown
bunx tsc 2>&1 | grep "error TS" | sed 's/(.*$//' | sort | uniq -c | sort -rn

# One file in isolation
bunx tsc extensions/agent-forge.ts 2>&1 | grep "error TS"

# Standard git workflow
git diff extensions/damage-control.ts    # review change
git commit -m "fix: damage-control notify() arg count"
git reset --soft HEAD~1                  # undo last commit (keep changes)
git checkout extensions/scheduler.ts    # revert file to last commit
```

---

## `results.tsv` format

Tab-separated, never committed.

```
commit	type_errors	target	status	description
a1b2c3d	27	—	keep	baseline
b2c3d4e	24	damage-control.ts	keep	fix 3 notify() arg count errors
c3d4e5f	28	agent-chain.ts	discard	attempted fix made things worse
d4e5f6g	0	subagent-widget.ts	keep	fix last errors — codebase clean!
e5f6g7h	0	NEW:agent-forge.ts	keep	implement agent-forge spec
```

Status: `keep` | `discard` | `crash`

---

## SOP: Slash command autocomplete

**Every user-facing feature MUST register a slash command.** Pi's `/` autocomplete is built
dynamically from `pi.registerCommand()` calls. If you add a new feature, capability, or
toggle to an extension, it must be discoverable via autocomplete.

### Checklist (run on every PR / commit that touches extensions)

1. **New extension?** → Must have at least one `pi.registerCommand()` with a clear `description`
2. **New feature in existing extension?** → Add a command if the user needs to invoke or configure it
3. **Verify coverage** — run this to find extensions with no commands:
   ```bash
   for ext in extensions/*.ts; do
     name=$(basename "$ext" .ts)
     cmds=$(grep -c 'registerCommand' "$ext" 2>/dev/null)
     if [ "$cmds" = "0" ]; then echo "⚠️  $name: no slash commands"; fi
   done
   ```
4. **Passive extensions are OK** — `minimal.ts`, `pure-focus.ts`, `themeMap.ts`, `project-context.ts`
   don't need commands (they're wiring/theming). But if a passive extension grows a user-facing
   toggle or config, add a command for it.

### Current command registry

| Extension | Commands |
|---|---|
| `agent-builder` | `/agents-build`, `/agents-build-status` |
| `agent-chain` | `/chain`, `/chain-list`, `/chain-stats` |
| `agent-team` | `/agents-team`, `/agents-list`, `/agents-grid` |
| `cross-agent` | _(dynamic — registers from .claude/ dirs at runtime)_ |
| `pi-pi` | `/experts`, `/experts-grid`, `/analyze` |
| `pi-setup` | `/setup`, `/setup-status` |
| `scheduler` | `/schedule`, `/schedule-once`, `/schedule-list`, `/schedule-cancel`, `/schedule-clear` |
| `session-replay` | `/replay` |
| `subagent-widget` | `/sub`, `/subcont`, `/subrm`, `/subclear` |
| `system-select` | `/system` |
| `theme-cycler` | `/theme` |
| `tilldone` | `/tilldone` |
| Passive (no cmds) | `minimal`, `pure-focus`, `themeMap`, `project-context`, `tool-counter`, `tool-counter-widget`, `purpose-gate`, `damage-control` |

**Update this table whenever commands change.**

---

## Simplicity principle

Fixes that use `// @ts-ignore` or cast to `any` → discard (mask, don't fix).  
A correct 1-line fix > a workaround 10-line fix.  
New extension that compiles + implements spec faithfully → keep.  
New extension that compiles but ignores the spec → probably discard.
