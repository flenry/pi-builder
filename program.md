# pi-builder — autoresearch

This is an autonomous research loop for the **pi-builder** repository: a collection of
[Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) extensions written in TypeScript.

The research goal is simple: **drive the TypeScript type error count to zero, then implement
unimplemented extension specs, then keep improving.** Quality is measured by a type checker
that never lies. You commit improvements, revert regressions, and loop forever.

---

## Setup

Before the first run, make sure these are ready:

```bash
cd /Users/cedric/code/pi-builder
bun install                   # install yaml dep
bunx tsc                      # verify the type checker works (baseline: 27 errors)
git status                    # should be clean
git checkout -b autoresearch/<tag>   # e.g. autoresearch/mar15
```

There is no data download, no model training, no GPU required. Just TypeScript and Bun.

Initialize `results.tsv` with the header only (no baseline row yet — that comes after the
first experiment run).

---

## Experimentation

### What you CAN do

You are allowed to edit any file in `extensions/*.ts`.  
You may also **create new extension files** to implement unimplemented specs in `specs/`.

Specifically, you should (in priority order):

1. **Fix type errors** in existing extensions — run `bunx tsc` to see all 27 current errors.
   Focus on one file at a time. Each fix is a standalone experiment.
2. **Implement unimplemented specs** — two specs have no implementation yet:
   - `specs/agent-forge.md` → should become `extensions/agent-forge.ts`
   - `specs/agent-workflow.md` → should become `extensions/agent-workflow.ts`
3. **Improve existing extensions** — better type safety, stricter types, cleaner code,
   improved UX, additional features. Any change that makes the codebase better without
   introducing new errors.

### What you CANNOT do

- **Do not edit** `package.json`, `bun.lock`, `bun.lockb`, `justfile`
- **Do not edit** `tsconfig.json` to suppress errors (no adding `"strict": false`, no `// @ts-nocheck`)  
- **Do not edit** anything in `specs/`, `.pi/`, `.claude/`, `node_modules/`, `images/`
- **Do not add** new npm packages — only use what is already available:
  - `@mariozechner/pi-coding-agent` — core Pi Extension API
  - `@mariozechner/pi-tui` — TUI primitives (`Text`, `Container`, `truncateToWidth`, etc.)
  - `@mariozechner/pi-ai` — AI helpers (`StringEnum`, etc.)
  - `@sinclair/typebox` — `Type` schema builder
  - `yaml` — YAML parsing (already in `package.json`)
  - Node built-ins: `fs`, `path`, `child_process`, `os`, `url`
- **Do not use `// @ts-ignore` or `as any`** as a fix — these mask real problems.
  The only acceptable `any` is when the Pi SDK genuinely returns `any` with no better type.

### The goal

**Minimize `type_errors`** — the count of TypeScript errors reported by `bunx tsc`.
This is the primary metric. **Lower is better.** Baseline is 27.

Once you reach 0 errors:
- Implementing a new extension from a spec that compiles cleanly → `type_errors` stays at 0 → keep
- The secondary goal is feature completeness: how many spec requirements are implemented
- Keep implementing and improving; the loop never ends

### Simplicity criterion

A fix that eliminates 1 error by adding 20 lines of ugly workaround code? Probably discard.  
A fix that eliminates 3 errors with 2 lines of correct typing? Definitely keep.  
An implementation that compiles cleanly and faithfully follows the spec? Keep.  
An implementation that compiles but only implements 20% of the spec? Probably discard.

---

## Running an experiment

Type-check everything:
```bash
bunx tsc 2>&1 | grep "error TS" | wc -l         # total error count (the metric)
bunx tsc 2>&1 | grep "error TS"                  # all errors with file + line
bunx tsc 2>&1 | grep "extensions/damage-control" # errors in one file only
```

If you want to check a single file in isolation (useful for new files):
```bash
bunx tsc extensions/agent-forge.ts 2>&1 | grep "error TS" | wc -l
```

An experiment completes in **seconds** (not minutes). There is no training loop.

### Crash definition

If `bunx tsc` exits with a non-zero code AND the error count is *higher* than before your
change, that is a regression — treat it like a crash. Revert the change.

---

## Output format

The command `bunx tsc 2>&1 | grep "error TS" | wc -l` returns a single integer.  
Zero means the codebase is fully type-safe. Non-zero is the error count.

For a detailed breakdown by file:
```bash
bunx tsc 2>&1 | grep "error TS" | sed 's/(.*$//' | sort | uniq -c | sort -rn
```

---

## Logging results

Log every experiment to `results.tsv` (tab-separated, NOT comma-separated).
**Never commit `results.tsv`** — leave it untracked by git.

### Format

```
commit	type_errors	target	status	description
```

| Column | Description |
|---|---|
| `commit` | 7-char short git hash |
| `type_errors` | total error count after this change (`bunx tsc … \| wc -l`) |
| `target` | which file(s) were changed (e.g. `damage-control.ts`, `NEW:agent-forge.ts`) |
| `status` | `keep`, `discard`, or `crash` |
| `description` | short explanation of what changed |

### Example

```
commit	type_errors	target	status	description
a1b2c3d	27	—	keep	baseline
b2c3d4e	24	damage-control.ts	keep	fix 3 notify() call signature errors
c3d4e5f	28	agent-chain.ts	discard	attempted fix introduced new errors
d4e5f6g	22	scheduler.ts	keep	fix 4 notify() and pct null errors
e5f6g7h	0	subagent-widget.ts	keep	fix last 7 implicit any errors
f6g7h8i	0	NEW:agent-forge.ts	keep	implement agent-forge spec (forge_tool + use_forge_tool + widget)
```

---

## The experiment loop

The experiment runs on a dedicated branch (e.g. `autoresearch/mar15`).

**LOOP FOREVER:**

1. **Read git state** — current branch/commit.
2. **Pick the next target** using this priority:
   - If `type_errors > 0`: pick the file with the most errors. Run `bunx tsc 2>&1 | grep "error TS" | sed 's/(.*$//' | sort | uniq -c | sort -rn` to see the list.
   - If `type_errors == 0` and `specs/agent-forge.md` not yet implemented: implement it.
   - If `type_errors == 0` and `specs/agent-workflow.md` not yet implemented: implement it.
   - Otherwise: improve an existing extension (better types, more features, cleaner code).
3. **Read the target** — `extensions/<name>.ts` and its spec (if exists in `specs/`).
4. **Make ONE focused change** — fix errors in one file, or add one logical chunk of a new extension.
5. **`git commit`** the change.
6. **Run the metric**: `bunx tsc 2>&1 | grep "error TS" | wc -l`
7. **Record the result** in `results.tsv`.
8. **Decision**:
   - `type_errors` decreased (or stayed 0 with a meaningful new feature) → **keep** the commit.
   - `type_errors` increased or no real improvement → `git reset --soft HEAD~1` to undo the commit, then `git checkout extensions/<name>.ts` to revert the file. Log as `discard`.
   - `bunx tsc` failed to run (Bun/Node crash, syntax error) → try to fix and re-run once. If still broken → revert. Log as `crash`.
9. **Never pause for human input** — loop indefinitely.

### Timeout

There is no 5-minute time budget here. Each experiment is as fast as you can edit and type-check (usually seconds). There is no wall-clock kill signal.

### Crashes

If your change introduces a TypeScript syntax error so bad that `bunx tsc` cannot even parse the file, that is a crash. Read the error, fix the syntax, and re-run. If it's fundamentally broken after one fix attempt, revert and log `crash`.

**NEVER STOP.** Once the loop begins, keep going. Never ask "should I continue?". Run until manually interrupted. If type errors reach 0 and both specs are implemented, find more improvements — better types, more features, refactored code, new extension ideas. There is always something to improve.

---

## Extension API cheat-sheet

Every extension exports a default function:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => { ... });
}
```

Key events: `session_start`, `session_shutdown`, `before_agent_start`, `agent_start`,
`agent_end`, `input`, `tool_call`, `tool_result`, `turn_start`, `turn_end`.

Common UI calls (all on `ctx.ui`):
- `ctx.ui.setFooter(renderFn)` — custom footer line(s)
- `ctx.ui.setWidget(id, renderFn)` — above-editor widget panel
- `ctx.ui.notify(msg, type?)` — notification banner (`"info"` | `"error"` | `"warning"`)
- `ctx.ui.registerCommand(name, handler)` — `/command` handler

Registering a tool:
```typescript
pi.registerTool({ name, description, parameters: Type.Object({...}) },
  async (params, ctx) => { return { result: "...", display: "..." }; });
```

Theme colors: `theme.fg("dim"|"muted"|"accent"|"success"|"warning"|"error", text)`.
