# Run — The Experiment Loop

## Context
Execute the autonomous experiment loop. Runs indefinitely until the user interrupts, a target metric is hit, or max iterations are reached. Read `experiment.yaml` for all configuration.

## Pre-flight

### 1. Load Config
- Read `experiment.yaml` from cwd
- If it doesn't exist, tell the user to run `/skill:autoexperiment setup` first — stop.

### 2. Verify Git State
- Confirm we're on an `autoexperiment/*` branch:
  ```bash
  git branch --show-current
  ```
- If not, warn: **"Not on an autoexperiment branch. Run setup first or checkout the right branch."** — stop.

### 3. Resume or Start Fresh
- Check if `results.tsv` exists and has data rows (beyond the header)
- If rows exist → this is a **resume**. Show the user a summary of experiments so far, then continue the loop.
- If empty → this is a **fresh start**. The first experiment must always be a **baseline** (no changes to any files).

### 4. Read the In-Scope Files
Before the first experiment (or on resume, as a refresh):
- Read all files listed in `search_space.files` for full context
- Understand the current state of the code being optimized

---

## The Experiment Loop

**LOOP FOREVER** (or until stopping criteria met):

### Step 1 — Decide What to Try

- Look at `results.tsv` to see what has been tried
- Look at git log for kept commits: `git log --oneline`
- If this is the very first experiment → **baseline**: make zero changes, just run as-is
- Otherwise → propose a concrete change based on:
  - What has worked (kept commits)
  - What hasn't (discarded entries in results.tsv)
  - The constraints in `search_space.constraints`
  - Patterns in near-misses (things that almost worked)
  - If stuck for ideas: try combining previous near-misses, try more radical changes, re-read the in-scope files

### Step 2 — Apply the Change

- Directly edit the file(s) listed in `search_space.files`
- Only touch files explicitly listed — nothing else
- Keep changes focused: one idea per experiment

### Step 3 — Commit the Change

```bash
git add <modified files>
git commit -m "experiment: <short description of what was tried>"
```

Record the short commit hash:
```bash
git rev-parse --short HEAD
```

### Step 4 — Run the Experiment

```bash
<runner.command>
```

Use a timeout based on `runner.timeout_minutes`:
```bash
timeout $((runner.timeout_minutes * 60)) <runner.command>
```

- Redirect output as specified in the command (usually `> run.log 2>&1`)
- Do NOT let output flood your context
- If the command times out → treat as crash

### Step 5 — Extract the Metric

Run `metric.command` to get the score:
```bash
<metric.command>
```

- Parse the numeric value from the output
- If the output is empty or non-numeric → the run crashed

**If crashed:**
- Run `tail -n 50 <runner.log_file>` to read the stack trace
- If the fix is obvious (typo, missing import, off-by-one) → fix it, amend the commit, re-run
- If the idea itself is broken → log as `crash`, skip to Step 7 (revert)
- If you can't fix it after 2 attempts → log as `crash`, skip to Step 7

### Step 6 — Compare to Best

- Find the best metric so far from `results.tsv` (lowest or highest depending on `metric.direction`)
- If `results.tsv` is empty (baseline run) → this IS the best by definition
- **Improved** = new value is strictly better than current best (lower if `direction: lower`, higher if `direction: higher`)

### Step 7 — Keep or Discard

**If improved (or baseline):**
- Keep the commit — do nothing, stay on this commit
- Status: `keep`

**If equal or worse:**
- Revert the commit:
  ```bash
  git reset --hard HEAD~1
  ```
- Status: `discard`

**If crashed:**
- Revert the commit:
  ```bash
  git reset --hard HEAD~1
  ```
- Status: `crash`

### Step 8 — Log to results.tsv

Append a tab-separated row to `results.tsv`:

```
<7-char commit hash>	<metric value or "crash">	<keep|discard|crash>	<short description>
```

- Use `0.000000` as metric value for crashes
- Description should be brief but informative: what was tried, not just "experiment N"
- Do NOT `git add` or `git commit` results.tsv — it stays untracked

### Step 9 — Check Stopping Criteria

**If `stopping.mode` is `"threshold"`:**
- Check if `metric.target` is set and has been reached (best metric <= target if lower, >= target if higher)
- If yes → stop the loop, go to **Finish**

**If `stopping.mode` is `"iterations"`:**
- Count rows in `results.tsv` (excluding header)
- If count >= `stopping.max_iterations` → stop the loop, go to **Finish**

**If `stopping.mode` is `"indefinite"`:**
- Never stop. Continue to Step 1.

**DO NOT ask the user if you should continue. The human may be away. Keep running.**

---

## Finish

Only reached when stopping criteria are met (not on user interrupt — that's abrupt).

1. Run `/skill:autoexperiment status` to display the full results summary
2. Show the best result achieved and what change produced it:
   ```bash
   git log --oneline autoexperiment/<tag>
   ```
3. Tell the user:
   - Total experiments run
   - Best metric achieved
   - Which commit to inspect for the winning configuration
