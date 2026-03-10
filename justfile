set dotenv-load := true

default:
    @just --list

# g1

# 1. default pi
pi:
    pi

# 2. Pure focus pi: strip footer and status line entirely
ext-pure-focus:
    pi -e extensions/pure-focus.ts

# 3. Minimal pi: model name + 10-block context meter
ext-minimal:
    pi -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 4. Cross-agent pi: load commands from .claude/, .gemini/, .codex/ dirs
ext-cross-agent:
    pi -e extensions/cross-agent.ts -e extensions/minimal.ts

# 5. Purpose gate pi: declare intent before working, persistent widget, focus the system prompt on the ONE PURPOSE for this agent
ext-purpose-gate:
    pi -e extensions/purpose-gate.ts -e extensions/minimal.ts

# 6. Customized footer pi: Tool counter, model, branch, cwd, cost, etc.
ext-tool-counter:
    pi -e extensions/tool-counter.ts

# 7. Tool counter widget: tool call counts in a below-editor widget
ext-tool-counter-widget:
    pi -e extensions/tool-counter-widget.ts -e extensions/minimal.ts

# 8. Subagent widget: /sub <task> with live streaming progress
ext-subagent-widget:
    pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts -e extensions/theme-cycler.ts

# 9. TillDone: task-driven discipline — define tasks before working
ext-tilldone:
    pi -e extensions/tilldone.ts -e extensions/theme-cycler.ts

#g2

# 10. Agent team: dispatcher orchestrator with team select and grid dashboard
ext-agent-team:
    pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts

# 11. System select: /system to pick an agent persona as system prompt
ext-system-select:
    pi -e extensions/system-select.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 12. Launch with Damage-Control safety auditing
ext-damage-control:
    pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 13. Agent chain: sequential pipeline orchestrator
ext-agent-chain:
    pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

#g3

# 14. Pi Pi: meta-agent that builds Pi agents with parallel expert research
ext-pi-pi:
    pi -e extensions/pi-pi.ts -e extensions/theme-cycler.ts

#ext

# 15. Scheduler: recurring and one-shot task scheduling within a session
ext-scheduler:
    pi -e extensions/scheduler.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 16. Session Replay: scrollable timeline overlay of session history (legit)
ext-session-replay:
    pi -e extensions/session-replay.ts -e extensions/minimal.ts

# 17. Theme cycler: Ctrl+X forward, Ctrl+Q backward, /theme picker
ext-theme-cycler:
    pi -e extensions/theme-cycler.ts -e extensions/minimal.ts

#g4

# 18. Pi Setup: analyze and configure Pi for any project
ext-pi-setup:
    pi -e extensions/pi-setup.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 19. Agent Builder: generate project-specific agent definitions
ext-agent-builder:
    pi -e extensions/agent-builder.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 20. Full configurator: setup + agent builder together
ext-configurator:
    pi -e extensions/pi-setup.ts -e extensions/agent-builder.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# utils

# Open pi with one or more stacked extensions in a new terminal: just open minimal tool-counter
open +exts:
    #!/usr/bin/env bash
    args=""
    for ext in {{exts}}; do
        args="$args -e extensions/$ext.ts"
    done
    cmd="cd '{{justfile_directory()}}' && pi$args"
    escaped="${cmd//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    osascript -e "tell application \"Terminal\" to do script \"$escaped\""

# Open every extension in its own terminal window
all:
    just open pi
    just open pure-focus 
    just open minimal theme-cycler
    just open cross-agent minimal
    just open purpose-gate minimal
    just open tool-counter
    just open tool-counter-widget minimal
    just open subagent-widget pure-focus theme-cycler
    just open tilldone theme-cycler
    just open agent-team theme-cycler
    just open system-select minimal theme-cycler
    just open damage-control minimal theme-cycler
    just open agent-chain theme-cycler
    just open pi-pi theme-cycler
    just open pi-setup minimal theme-cycler
    just open agent-builder minimal theme-cycler
# ── Crew Workflows ───────────────────────────────

# Full crew dispatcher — Luffy routes to 12 specialists dynamically
crew:
    pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts

# Full TDD pipeline — Robin → Vegapunk → Usopp (tests) → Zoro (build) → Usopp (QA) → Law → Jinbe
full-impl:
    PI_CHAIN=full-implementation pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# Fast TDD — Robin → Usopp (tests) → Zoro (build) → Law
fast-impl:
    PI_CHAIN=fast-implementation pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# Frontend TDD — Robin → Usopp (tests) → Sanji (build) → Usopp (QA) → Law
frontend-impl:
    PI_CHAIN=frontend-implementation pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# Deep multi-pass research — Robin → Benn Beckman → Vegapunk
research:
    PI_CHAIN=deep-research pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# Security audit — Jinbe → Law → Robin
security:
    PI_CHAIN=security-audit pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

# Quant analysis — Benn Beckman → Robin → Nami
quant:
    PI_CHAIN=quant-analysis pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts
