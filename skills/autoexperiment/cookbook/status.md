# Status — Show Experiment Results

## Context
Display a summary of all experiments run so far without starting or modifying anything.

## Steps

### 1. Load Config
- Read `experiment.yaml` from cwd
- If not found, tell the user there's no active experiment here — stop.

### 2. Read results.tsv
- Read `results.tsv` from cwd
- If not found or only has a header row, tell the user: **"No experiments run yet."** — stop.

### 3. Display Results Table

Print the full results table:

```
## Experiment Results — autoexperiment/<tag>

| # | Commit | Metric | Status | Description |
|---|--------|--------|--------|-------------|
| 1 | a1b2c3d | 0.9979 | ✅ keep    | baseline |
| 2 | b2c3d4e | 0.9932 | ✅ keep    | increased learning rate |
| 3 | c3d4e5f | 1.0050 | ❌ discard | switched optimizer |
| 4 | d4e5f6g | crash  | 💥 crash   | doubled model width (OOM) |
```

### 4. Summary Stats

```
## Summary

Optimizing:   lower val_bpb
Target:       0.90 (not yet reached)  — or "no target set"

Total runs:   4
  ✅ kept:    2
  ❌ discarded: 1
  💥 crashed: 1

Best so far:  0.9932  (commit b2c3d4e — "increased learning rate")
Started at:   0.9979  (baseline)
Improvement:  0.0047 (0.47%)
```

### 5. Branch Info

```bash
git log --oneline autoexperiment/<tag>
```

Show the kept commits (the ones that are still on the branch).
