# Setup — Initialize an Experiment

## Context
Gather the 4 key questions from the user and write `experiment.yaml` to the current working directory. Run this once before the first experiment loop.

## Steps

### 1. Check for Existing Config
- Look for `experiment.yaml` in cwd
- If it exists, show the current config and ask: **"An experiment.yaml already exists. Reconfigure from scratch, or keep it and go straight to run?"**
- If keeping, exit setup and direct user to `/skill:autoexperiment run`

### 2. Check for Git
- Verify `git` is available: `git --version`
- Verify the current directory is a git repo: `git rev-parse --git-dir`
- If not a git repo, warn the user: **"Autoexperiment uses git to track experiments. Run `git init` first."** — stop.
- Check the working tree is clean: `git status --porcelain`
- If there are uncommitted changes, warn: **"Uncommitted changes detected. Commit or stash them before starting."** — stop.

### 3. Ask the 4 Questions

Ask these one at a time. Wait for a real answer before moving on.

---

**Question 1 — The Metric**

> *"What is the metric we're optimizing? Tell me:*
> *1. The command that runs one experiment (or how to extract the score from output)*
> *2. Whether lower or higher is better*
> *3. Optionally: a target value to stop at (e.g. stop when accuracy hits 95%)"*

Examples to offer if the user is unsure:
- `pytest --tb=no -q 2>&1 | tail -1` → parse pass rate, higher is better
- `grep '^val_bpb:' run.log | awk '{print $2}'` → lower is better
- A benchmark script that prints a score on the last line

Clarify until you have:
- `metric.command` — shell command that produces the numeric score
- `metric.direction` — `"lower"` or `"higher"`
- `metric.target` — numeric threshold or `null`

---

**Question 2 — The Search Space**

> *"What can be changed? Tell me:*
> *1. Which files the agent is allowed to modify*
> *2. Any hard constraints — what's off-limits, what must stay intact"*

Examples:
- "You can edit `config.json` and `src/model.py`, but not `src/data.py`"
- "Change any hyperparameter in `train.py`, but don't add new dependencies"
- "Only modify the prompt templates in `prompts/`, not the evaluation code"

Clarify until you have:
- `search_space.files` — list of modifiable files
- `search_space.constraints` — free-text constraints

---

**Question 3 — The Runner**

> *"How do I run one experiment? Give me:*
> *1. The shell command to execute a single trial*
> *2. Where the output/log goes (if any)*
> *3. How long a single run should take (for timeout purposes)"*

Examples:
- `uv run train.py > run.log 2>&1` — 5 minutes
- `npm run benchmark 2>&1 | tee run.log` — 2 minutes
- `python eval.py > run.log` — 30 seconds

Clarify until you have:
- `runner.command` — the shell command
- `runner.log_file` — where output is written (can be `null` if piped inline)
- `runner.timeout_minutes` — kill threshold

---

**Question 4 — Stopping Criteria**

> *"When should the loop stop?*
> - *Run indefinitely until you interrupt me*
> - *Stop after N experiments*
> - *Stop when the metric hits a target (you already told me this in Q1 — confirm or override)"*

Clarify until you have:
- `stopping.mode` — `"indefinite"`, `"iterations"`, or `"threshold"`
- `stopping.max_iterations` — number (only if mode is `"iterations"`)
- Note: if they gave a `metric.target` in Q1 and mode is `"threshold"`, they're consistent — confirm

---

### 4. Agree on a Run Tag

Propose a tag based on today's date (e.g. `mar17`). Check that `autoexperiment/<tag>` doesn't already exist:

```bash
git branch --list "autoexperiment/<tag>"
```

If it exists, append a suffix: `mar17-2`, `mar17-3`, etc.

### 5. Create the Branch

```bash
git checkout -b autoexperiment/<tag>
```

### 6. Write experiment.yaml

Write `experiment.yaml` to cwd with all collected answers. Use `null` for unset optional fields.

### 7. Initialize results.tsv

Create `results.tsv` with just the header row (tab-separated):

```
commit	metric	status	description
```

Do NOT git-add or commit `results.tsv` — it stays untracked.

### 8. Confirm

Show the user the written `experiment.yaml` and confirm:
- Branch created: `autoexperiment/<tag>`
- Config saved: `experiment.yaml`
- Results log ready: `results.tsv`

Ask: **"Setup complete. Start the experiment loop now?"**
- Yes → proceed to [cookbook/run.md](run.md)
- No → tell them to run `/skill:autoexperiment run` when ready
