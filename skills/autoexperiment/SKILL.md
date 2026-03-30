---
name: autoexperiment
description: Autonomous experiment loop that optimizes any measurable system. Use when the user wants to run iterative experiments, tune parameters, or find optimal configurations for any project. Asks setup questions on first run, then loops autonomously — modifying, running, measuring, keeping or discarding — until a target is hit or the user stops it.
---

# Autoexperiment

An autonomous research loop inspired by Karpathy's autoresearch. Give it a metric, a search space, and a runner — it experiments indefinitely until you stop it or a target is reached.

## How It Works

1. **Setup** — answer 4 questions once. Saved to `experiment.yaml` in the working directory.
2. **Run** — the agent loops forever: propose a change → apply it → run the experiment → measure → keep if better, revert if worse → log → repeat.
3. **Stop** — interrupt the agent at any time. Results are always in `results.tsv`.

## Commands

| Command | Purpose |
|---|---|
| `/skill:autoexperiment setup` | Ask the 4 questions and initialize `experiment.yaml` |
| `/skill:autoexperiment run` | Start (or resume) the experiment loop |
| `/skill:autoexperiment status` | Show results so far from `results.tsv` |

If the user just says `/skill:autoexperiment` with no subcommand, check for `experiment.yaml` in cwd:
- If it doesn't exist → run **setup**, then ask if they want to start **run**
- If it exists → show current config and ask if they want to **run** or reconfigure

## Cookbook

**Read the relevant cookbook file before executing.**

| Command | Cookbook | Use When |
|---|---|---|
| setup | [cookbook/setup.md](cookbook/setup.md) | No `experiment.yaml` exists yet, or user wants to reconfigure |
| run | [cookbook/run.md](cookbook/run.md) | Ready to start or resume the experiment loop |
| status | [cookbook/status.md](cookbook/status.md) | User wants to review results without running |

## The experiment.yaml Format

Created by setup, lives in the working directory of the project being optimized.

```yaml
metric:
  command: "uv run train.py > run.log 2>&1 && grep '^val_bpb:' run.log | awk '{print $2}'"
  direction: lower        # "lower" or "higher" — which direction is better
  target: null            # optional: stop when this value is reached (e.g. 0.95)

search_space:
  files:                  # files the agent is allowed to modify
    - train.py
  constraints: |          # free-text description of what's in/out of scope
    Modify architecture, optimizer, hyperparameters in train.py.
    Do not modify prepare.py or add new dependencies.

runner:
  command: "uv run train.py > run.log 2>&1"
  log_file: run.log
  timeout_minutes: 10

stopping:
  mode: indefinite        # "indefinite", "iterations", or "threshold"
  max_iterations: null    # used when mode is "iterations"

results_file: results.tsv
```

## Results Format

`results.tsv` (tab-separated, never comma — commas break in descriptions):

```
commit	metric	status	description
a1b2c3d	0.9979	keep	baseline
b2c3d4e	0.9932	keep	increased learning rate
c3d4e5f	1.0050	discard	switched optimizer
d4e5f6g	crash	crash	OOM — doubled model width
```

## Git Contract

- Each experiment is a git commit on a dedicated branch: `autoexperiment/<tag>`
- If the result improves → keep the commit, advance the branch
- If the result is equal or worse → `git reset --hard HEAD~1` (revert)
- `results.tsv` is **never committed** — it stays untracked
- The branch is the source of truth for what's been kept

## Agent Rules During Run

- **NEVER stop to ask the human if you should continue.** The human may be asleep. Run until interrupted.
- If a run crashes and the fix is obvious (typo, missing import) → fix and re-run
- If the idea is fundamentally broken → log as `crash`, revert, move on
- If stuck for ideas → re-read the search space constraints, look at the kept commits for patterns, try combining near-misses
- If a run exceeds `timeout_minutes` → kill it, treat as failure, revert
