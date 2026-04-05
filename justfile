set dotenv-load := true

default:
    @just --list

# ── Core ──────────────────────────────────────────

# Plain pi — no extensions
pi:
    pi

# Minimal: model name + context meter
ext-minimal:
    pi -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Pure focus: strip footer and status line
ext-pure-focus:
    pi -e extensions/pure-focus.ts

# Tool counter: custom footer with cost, tokens, branch
ext-tool-counter:
    pi -e extensions/tool-counter.ts

# Tool counter widget
ext-tool-counter-widget:
    pi -e extensions/tool-counter-widget.ts -e extensions/minimal.ts

# Theme cycler: Ctrl+X forward, Ctrl+Q backward, /theme picker
ext-theme-cycler:
    pi -e extensions/theme-cycler.ts -e extensions/minimal.ts

# ── Workflow ──────────────────────────────────────

# Agent chain — sequential workflow pipelines (select with /chain)
chain: sync
    pi -e extensions/project-context.ts -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# ── Utilities ─────────────────────────────────────

# Subagent widget: /sub <task> with live streaming progress
ext-subagent-widget:
    pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts -e extensions/theme-cycler.ts

# TillDone: task-driven discipline — define tasks before working
ext-tilldone:
    pi -e extensions/tilldone.ts -e extensions/theme-cycler.ts

# Scheduler: recurring and one-shot task scheduling within a session
ext-scheduler:
    pi -e extensions/scheduler.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# System select: /system to pick an agent persona
ext-system-select:
    pi -e extensions/system-select.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Damage control: safety auditing
ext-damage-control:
    pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Pi Setup: analyze and configure pi for any project
ext-pi-setup:
    pi -e extensions/pi-setup.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Agent Builder: generate project-specific agent definitions
ext-agent-builder:
    pi -e extensions/agent-builder.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Project context: injects CLAUDE.md + stack into agents
ext-project-context:
    pi -e extensions/project-context.ts -e extensions/minimal.ts

# ── Sync ──────────────────────────────────────────

# Sync crew workflows + agents + ohara extensions to runtime locations
sync:
    #!/usr/bin/env bash
    set -e
    echo "syncing crew..."
    cp ~/code/crew/workflows/agent-chain.yaml ~/.pi/agent/agents/agent-chain.yaml
    cp ~/code/crew/agents/*.md ~/.pi/agent/agents/straw-hats/
    echo "syncing ohara extensions..."
    cp ~/code/ohara/extensions/*.ts ~/.pi/agent/extensions/
    echo "✓ sync complete"
