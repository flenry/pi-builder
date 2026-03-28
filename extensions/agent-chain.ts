/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in
 * .pi/agents/agent-chain.yaml — each chain is a sequence of agent steps
 * with prompt templates. The user's original prompt flows into step 1,
 * the output becomes $INPUT for step 2's prompt template, and so on.
 * $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent has NO codebase tools — it can ONLY kick off the
 * pipeline via the `run_chain` tool. On boot you select a chain; the
 * agent decides when to run it based on the user's prompt.
 *
 * Agents maintain session context within a Pi session — re-running the
 * chain lets each agent resume where it left off.
 *
 * Commands:
 *   /chain             — switch active chain
 *   /chain-list        — list all available chains
 *   /chain-stats       — show token/time telemetry for this session
 *
 * Usage: pi -e extensions/agent-chain.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	AuthStorage,
	ModelRegistry,
	DefaultResourceLoader,
	createReadOnlyTools,
	readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool,
} from "@mariozechner/pi-coding-agent";
import { readFileSync as readFileSyncNode } from "fs";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Constants ────────────────────────────────────

/** If a resolved prompt exceeds this char count, write it to a file and pass a reference instead */
const INPUT_SIZE_THRESHOLD = 3000;

/** If an agent session file exceeds this size, archive it and start fresh next run */
const SESSION_COMPACT_THRESHOLD_BYTES = 50 * 1024; // 50KB

// ── Types ────────────────────────────────────────

interface ChainStep {
	agent: string;
	prompt: string;
	optional?: boolean;
	role?: "planner"; // pre-chain spec expansion step
}

interface LoopStep {
	type: "loop";
	generator: string;
	evaluator: string;
	generatorPrompt: string;
	evaluatorPrompt: string;
	maxIterations: number;
	passThreshold: number; // 0-10
	optional?: boolean;
}

type AnyStep = ChainStep | LoopStep;

interface ChainDef {
	name: string;
	description: string;
	steps: AnyStep[];
}

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	systemPrompt: string;
}

interface StepState {
	agent: string;
	status: "pending" | "running" | "done" | "error" | "skipped";
	elapsed: number;
	lastWork: string;
	merged?: boolean;
	iteration?: number;   // current loop iteration (loop steps only)
	score?: number;       // evaluator score (loop steps only)
}

interface TelemetryEntry {
	timestamp: string;
	chain: string;
	agent: string;
	model: string;
	promptChars: number;
	outputChars: number;
	elapsedMs: number;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function stepLabel(s: AnyStep): string {
	if ("type" in s && s.type === "loop") {
		return `${(s as LoopStep).generator} ⟳ ${(s as LoopStep).evaluator}`;
	}
	return (s as ChainStep).agent;
}

function isLoop(s: AnyStep): s is LoopStep {
	return "type" in s && (s as any).type === "loop";
}

// ── Chain YAML Parser ────────────────────────────

function unquote(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
		return t.slice(1, -1);
	return t;
}

function parseChainYaml(raw: string): ChainDef[] {
	// Use yaml parser for reliability
	const { parse } = require("yaml") as typeof import("yaml");
	const parsed = parse(raw) as Record<string, any>;
	if (!parsed || typeof parsed !== "object") return [];

	const chains: ChainDef[] = [];

	for (const [name, def] of Object.entries(parsed)) {
		if (!def || typeof def !== "object") continue;
		const chain: ChainDef = {
			name,
			description: def.description ?? "",
			steps: [],
		};

		for (const rawStep of (def.steps ?? [])) {
			if (!rawStep) continue;

			// Loop step: has generator + evaluator keys
			if (rawStep.loop !== undefined || (rawStep.generator && rawStep.evaluator)) {
				const s = rawStep.loop ?? rawStep;
				chain.steps.push({
					type: "loop",
					generator: s.generator ?? "",
					evaluator: s.evaluator ?? "",
					generatorPrompt: (s.generator_prompt ?? s.generatorPrompt ?? "").replace(/\\n/g, "\n"),
					evaluatorPrompt: (s.evaluator_prompt ?? s.evaluatorPrompt ?? "").replace(/\\n/g, "\n"),
					maxIterations: s.max_iterations ?? s.maxIterations ?? 3,
					passThreshold: s.pass_threshold ?? s.passThreshold ?? 7,
					optional: s.optional ?? false,
				} as LoopStep);
				continue;
			}

			// Regular step
			if (rawStep.agent) {
				chain.steps.push({
					agent: rawStep.agent,
					prompt: (rawStep.prompt ?? "").replace(/\\n/g, "\n"),
					optional: rawStep.optional ?? false,
					role: rawStep.role,
				} as ChainStep);
			}
		}

		chains.push(chain);
	}

	return chains;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			model: frontmatter.model || undefined,
			systemPrompt: match[2].trim(),
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): Map<string, AgentDef> {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		join(homedir(), ".pi", "agent", "agents"),
	];

	const agents = new Map<string, AgentDef>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			const scanDir = (d: string) => {
				for (const entry of readdirSync(d)) {
					const fullPath = resolve(d, entry);
					try {
						if (statSync(fullPath).isDirectory()) {
							scanDir(fullPath);
							continue;
						}
					} catch { continue; }
					if (!entry.endsWith(".md")) continue;
					const def = parseAgentFile(fullPath);
					if (def && !agents.has(def.name.toLowerCase())) {
						agents.set(def.name.toLowerCase(), def);
					}
				}
			};
			scanDir(dir);
		} catch {}
	}

	return agents;
}

// ── Step 1: Collapse Consecutive Same-Agent Steps ──
/**
 * Merge consecutive steps with the same agent into a single step.
 * Prompts are joined with labelled section headers (## Pass 1, ## Pass 2, ...)
 * so the agent still processes each sub-task in order.
 */
function collapseConsecutiveSteps(steps: AnyStep[]): AnyStep[] {
	const collapsed: AnyStep[] = [];
	let i = 0;
	while (i < steps.length) {
		const current = steps[i];
		// Loop steps are never collapsed
		if ("type" in current && current.type === "loop") {
			collapsed.push(current);
			i++;
			continue;
		}
		const cs = current as ChainStep;
		const group: ChainStep[] = [cs];
		let j = i + 1;
		while (
			j < steps.length &&
			!("type" in steps[j]) &&
			(steps[j] as ChainStep).agent === cs.agent
		) {
			group.push(steps[j] as ChainStep);
			j++;
		}
		if (group.length > 1) {
			const mergedPrompt = group
				.map((s, idx) => `## Pass ${idx + 1}\n${s.prompt}`)
				.join("\n\n---\n\n");
			collapsed.push({
				agent: cs.agent,
				prompt: mergedPrompt,
				optional: cs.optional,
			} as ChainStep);
		} else {
			collapsed.push(cs);
		}
		i = j;
	}
	return collapsed;
}

// ── Step 4: Externalize Large Prompts ────────────
/**
 * If content exceeds threshold chars, write to a file and return a short
 * reference prompt instead. The agent can read the file if it needs full context.
 */
function externalizeIfLarge(content: string, filePath: string, threshold = INPUT_SIZE_THRESHOLD): string {
	if (content.length <= threshold) return content;
	try {
		writeFileSync(filePath, content, "utf-8");
		const summary = content.slice(0, 400).replace(/\n+/g, " ").trim();
		return `Full task details are in FILE: ${filePath}\nUse the read tool to load it if you need the complete context.\n\nSummary: ${summary}...`;
	} catch {
		// If write fails, fall back to full content
		return content;
	}
}

// ── Step 7: Session Compaction ────────────────────
/**
 * After a chain run, check each agent session file. If it exceeds
 * SESSION_COMPACT_THRESHOLD_BYTES, archive it to .pi/agent-sessions/logs/
 * with a timestamp and delete the original so the next run starts with a
 * clean context window. Full history is preserved in logs/ for auditing.
 */
function compactSessions(sessionDir: string, agentSessions: Map<string, string | null>) {
	const logsDir = join(sessionDir, "logs");
	try {
		if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
	} catch { return; }

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

	for (const [agentKey, sessionFile] of agentSessions) {
		if (!sessionFile || !existsSync(sessionFile)) continue;
		try {
			const size = statSync(sessionFile).size;
			if (size > SESSION_COMPACT_THRESHOLD_BYTES) {
				// Archive with timestamp so full history is preserved
				const archiveName = `chain-${agentKey}-${timestamp}.json`;
				writeFileSync(join(logsDir, archiveName), readFileSync(sessionFile));
				// Delete original — next run starts fresh (smaller context)
				unlinkSync(sessionFile);
				agentSessions.set(agentKey, null);
			}
		} catch {}
	}
}

// ── Step 0: Token Telemetry ───────────────────────

function appendTelemetry(entry: TelemetryEntry, telemetryPath: string) {
	try {
		let entries: TelemetryEntry[] = [];
		if (existsSync(telemetryPath)) {
			try { entries = JSON.parse(readFileSync(telemetryPath, "utf-8")); } catch {}
		}
		entries.push(entry);
		writeFileSync(telemetryPath, JSON.stringify(entries, null, 2), "utf-8");
	} catch {}
}

// ── Progress Logging ─────────────────────────────
/**
 * Appends a progress entry to progress/YYYYMMDD.md in the project root.
 * Creates the file with a header if it doesn't exist yet today.
 * Format: ## HH:MM — chain: agent (status)
 */
function logProgress(opts: {
	cwd: string;
	chain: string;
	agent: string;
	status: "done" | "error" | "skipped";
	output: string;
	elapsed: number;
	iteration?: number;
	score?: number;
}) {
	try {
		const now = new Date();
		const date = now.toISOString().slice(0, 10).replace(/-/g, "");
		const time = now.toTimeString().slice(0, 5);
		const progressDir = join(opts.cwd, "progress");
		if (!existsSync(progressDir)) mkdirSync(progressDir, { recursive: true });

		const filePath = join(progressDir, `${date}.md`);
		const isNew = !existsSync(filePath);

		const header = isNew
			? `# Progress — ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}\n\n`
			: "";

		const elapsedStr = opts.elapsed > 60000
			? `${Math.round(opts.elapsed / 60000)}m`
			: `${Math.round(opts.elapsed / 1000)}s`;

		const scoreStr = opts.score !== undefined ? ` score ${opts.score}/10` : "";
		const iterStr = opts.iteration !== undefined ? ` iter ${opts.iteration}` : "";
		const statusIcon = opts.status === "done" ? "✓" : opts.status === "error" ? "✗" : "⊘";

		// Summary: first non-empty line of output, max 120 chars
		const summary = opts.output
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean)
			.pop()
			?.slice(0, 120) ?? "(no output)";

		const entry = `## ${time} — ${opts.chain}: ${opts.agent} ${statusIcon} (${elapsedStr}${iterStr}${scoreStr})\n${summary}\n\n`;

		writeFileSync(filePath, header + (isNew ? "" : readFileSync(filePath, "utf-8")) + entry, "utf-8");
	} catch {}
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let allAgents: Map<string, AgentDef> = new Map();
	let chains: ChainDef[] = [];
	let activeChain: ChainDef | null = null;
	let widgetCtx: any;
	let sessionDir = "";
	let telemetryPath = "";
	const agentSessions: Map<string, string | null> = new Map();

	// Per-step state for the active chain
	let stepStates: StepState[] = [];

	// ── Step 3: Cached dispatcher system prompt ──
	let cachedDispatcherPrompt: string | null = null;

	function buildDispatcherPrompt(): string {
		if (!activeChain) return "";

		const flow = activeChain.steps.map(s => displayName(stepLabel(s))).join(" → ");
		const desc = activeChain.description ? `\n${activeChain.description}` : "";

		// Short step list — no full system prompt text, just name + description + optional flag
		const steps = activeChain.steps.map((s, i) => {
			const label = stepLabel(s);
			const agentDef = allAgents.get(label.toLowerCase());
			const agentDesc = agentDef?.description || (isLoop(s) ? `Generator-evaluator loop (${s.maxIterations} max iterations, threshold ${s.passThreshold}/10)` : "");
			const optionalTag = s.optional ? " *(optional — skipped in fast mode)*" : "";
			return `${i + 1}. **${displayName(label)}**${optionalTag} — ${agentDesc}`;
		}).join("\n");

		// Agent catalog: description + tools only — no full system prompt
		const seen = new Set<string>();
		const agentCatalog = activeChain.steps
			.filter(s => {
				const key = stepLabel(s).toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map(s => {
				const label = stepLabel(s);
				const agentDef = allAgents.get(label.toLowerCase());
				if (!agentDef) return `### ${displayName(label)}\nAgent not found.`;
				return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}`;
			})
			.join("\n\n");

		const isHarness = activeChain.name.startsWith("harness-");

		const isCR = activeChain.name === "harness-cr";

		const harnessInterview = !isHarness ? "" : `
## Interview Protocol — REQUIRED before calling run_chain

This is a harness chain. Before dispatching to the pipeline, you MUST conduct a structured interview. Do NOT call run_chain until the interview is complete.

${isCR ? `### CR Interview
This is a change request. Keep the interview focused:
1. What exactly needs to change? (be precise — file, function, behaviour)
2. Why? What problem does it solve?
3. What must NOT break?
4. Any specific approach in mind, or open to recommendation?

Once you have enough, compile a concise CR brief and call run_chain.` : `### Build Interview`}

### Your job as interviewer
You are a senior product engineer and tech lead. You think with the user, not at them. Offer concrete suggestions. Push back on vague answers. Tell them what you'd choose and why. You're opinionated — share your opinions.

### Interview flow

Work through these topics conversationally — don't fire all questions at once. Present 1-2 related topics, discuss them, then move on. Adapt based on what the user has already told you.

**Round 1 — The idea**
- What are you building? What problem does it solve, for whom?
- What's the ONE thing that must work perfectly for this to be worth using?
- What does success look like in 3 months?

**Round 2 — Scope and features**
- Walk through what features are must-have vs nice-to-have
- What's explicitly OUT of scope for this build?
- Where should the AI be embedded IN the product itself? (suggest 2-3 specific opportunities based on what they described)

**Round 3 — Stack and technical approach**
- Any existing codebase to build on, or greenfield?
- Stack preferences? (offer your recommendation with reasoning if they're unsure — be specific: "For this I'd use Next.js + Postgres on Railway because...")
- Any hard constraints? (deployment target, auth system, compliance, budget)

**Round 4 — Design and UX**
- What should it feel like? (share reference products or aesthetics you think fit)
- Any specific UI paradigm? (dashboard, canvas, document, CLI, mobile-first)
- What's the anti-pattern to avoid? (generic SaaS look, complex onboarding, etc.)

**Round 5 — Wrap up**
- What should be done in Phase 1 vs later?
- Anything else critical the builder needs to know?

### Producing the spec

Once you have enough (all required sections covered or user says they're done), compile everything into a structured spec to pass to run_chain:

\`\`\`
PROJECT SPEC: [Name]

## Overview
[What it is, who it's for, core value]

## Must-Have Features
[Numbered list, specific]

## AI Integration
[Where Claude is embedded IN the product — specific features]

## Design Language
[Visual identity, UI paradigm, explicit anti-patterns to avoid]

## Stack
[Specific: framework, DB, hosting, auth, etc. with rationale]

## Constraints
[Hard limits, out of scope items]

## Phase 1 Scope
[What must ship first]

## Phase 2+
[Later phases]
\`\`\`

Then call run_chain with this full spec as the task. Include the GitHub origin URL at the top if provided (format: "GitHub origin: <url>" or "GitHub origin: none").

${!isCR ? `**Important:** Always ask for a GitHub origin URL — "Do you have a GitHub repo URL for this project? (or skip if you'll set it up later)"` : ""}

### Rules for the interview
- Be conversational — this is a dialogue, not a form
- Offer your own opinions and recommendations freely ("I'd go with X because...")
- If they're vague, propose something concrete and ask if it fits
- Don't proceed to the next round until the current one has enough depth
- You can ask follow-up questions within a round
- When they say "ready" or "let's go" or similar, compile the spec and dispatch
`;

		const standardWorkflow = isHarness
			? `## Your Workflow
1. Conduct the interview (above) — gather everything the builders need
2. Compile the spec
3. Call run_chain with the full compiled spec
4. Summarize the chain's output for the user`
			: `## Your Workflow
1. User gives you a task
2. Optionally read relevant files to understand the scope
3. Call run_chain with a clear task description (and fast: true for quick iterations)
4. Summarize the chain's output for the user`;

		return `You are a pipeline dispatcher. Your ONLY job is to route tasks through the "${activeChain.name}" chain via the run_chain tool.${desc}
${harnessInterview}
## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agents in This Chain

${agentCatalog}

## Rules — READ CAREFULLY

1. **ALWAYS call run_chain for ANY task.** You are a dispatcher, not a doer.
2. **NEVER implement, code, test, or build anything yourself.** That's what the chain agents are for.
3. **NEVER skip the chain.** Even if the task seems simple, run it through the pipeline.
4. Your other tools (read, bash, grep, etc.) are ONLY for pre-chain investigation if needed.
5. After the chain completes, summarize what each agent did and report the final result.

## How run_chain Works
- Pass a clear, specific task description to run_chain
- Each step's output feeds into the next step as \$INPUT
- Use \`fast: true\` to skip optional steps for quick iterations

${standardWorkflow}`;
	}

	function loadChains(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		telemetryPath = join(cwd, ".pi", "agent-telemetry.json");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		allAgents = scanAgentDirs(cwd);

		agentSessions.clear();
		for (const [key] of allAgents) {
			const sessionFile = join(sessionDir, `chain-${key}.json`);
			agentSessions.set(key, existsSync(sessionFile) ? sessionFile : null);
		}

		// Check project-local first, fall back to global
		const chainPaths = [
			join(cwd, ".pi", "agents", "agent-chain.yaml"),
			join(homedir(), ".pi", "agent", "agents", "agent-chain.yaml"),
		];
		chains = [];
		for (const chainPath of chainPaths) {
			if (existsSync(chainPath)) {
				try {
					const parsed = parseChainYaml(readFileSync(chainPath, "utf-8"));
					// Merge: project-local chains override global ones with same name
					const existing = new Set(chains.map(c => c.name));
					for (const c of parsed) {
						if (!existing.has(c.name)) chains.push(c);
					}
				} catch {}
			}
		}
	}

	function activateChain(chain: ChainDef) {
		activeChain = chain;
		stepStates = chain.steps.map(s => ({
			agent: stepLabel(s),
			status: "pending" as const,
			elapsed: 0,
			lastWork: "",
		}));
		// Step 3: build and cache dispatcher prompt when chain changes
		cachedDispatcherPrompt = buildDispatcherPrompt();
		updateWidget();
	}

	// ── Compact Progress Rendering ───────────────

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-chain", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (!activeChain || stepStates.length === 0) {
						text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
						return text.render(width);
					}

					// ── Line 1: chain name + step count ──
					const done = stepStates.filter(s => s.status === "done" || s.status === "skipped").length;
					const total = stepStates.length;
					const running = stepStates.find(s => s.status === "running");
					const hasError = stepStates.some(s => s.status === "error");
					const chainStatus = hasError ? theme.fg("error", "✗ error")
						: running ? theme.fg("accent", "● running")
						: done === total ? theme.fg("success", "✓ done")
						: theme.fg("dim", "○ waiting");
					const line1 = theme.fg("accent", theme.bold(activeChain.name)) + "  " + chainStatus + theme.fg("dim", `  ${done}/${total}`);

					// ── Line 2: all steps as compact pills ──
					const pills = stepStates.map(s => {
						const icon = s.status === "pending" ? "○"
							: s.status === "running" ? "●"
							: s.status === "done" ? "✓"
							: s.status === "skipped" ? "⊘"
							: "✗";
						const color = s.status === "pending" ? "dim"
							: s.status === "running" ? "accent"
							: s.status === "done" ? "success"
							: s.status === "skipped" ? "muted"
							: "error";
						// Short name: first word only, or "X⟳Y" for loops
						const shortName = s.agent.includes("⟳")
							? s.agent.replace(/\s/g, "")
							: s.agent.split(" ")[0];
						const timeStr = (s.status === "done" || s.status === "running") && s.elapsed > 0
							? `(${Math.round(s.elapsed / 1000)}s)` : "";
						const scoreStr = s.score !== undefined ? ` ${s.score}/10` : "";
						const iterStr = s.iteration !== undefined && s.status === "running" ? ` i${s.iteration}` : "";
						const label = `${icon} ${shortName}${timeStr}${iterStr}${scoreStr}`;
						return theme.fg(color, label);
					});
					const sep = theme.fg("dim", " · ");
					const line2 = pills.join(sep);

					// ── Line 3: current agent's live output ──
					const activeState = running ?? stepStates.filter(s => s.status === "done").pop();
					const liveText = activeState?.lastWork ?? "";
					const maxLen = width - 2;
					const truncated = liveText.length > maxLen ? "…" + liveText.slice(-(maxLen - 1)) : liveText;
					const line3 = truncated ? theme.fg("dim", truncated) : "";

					const lines = [line1, line2];
					if (line3) lines.push(line3);
					text.setText(lines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Tool resolution ──────────────────────────

	function resolveTools(toolsStr: string, cwd: string) {
		const names = toolsStr.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
		const toolMap: Record<string, any> = { read: readTool, bash: bashTool, edit: editTool, write: writeTool, grep: grepTool, find: findTool, ls: lsTool };
		const resolved: any[] = [];
		for (const name of names) {
			if (toolMap[name]) resolved.push(toolMap[name]);
		}
		return resolved.length > 0 ? resolved : createReadOnlyTools(cwd);
	}

	// ── Run Agent (in-process SDK) ───────────────

	async function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: any,
		images?: Array<{ path: string }>,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const modelStr = agentDef.model
			? agentDef.model
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "openrouter/google/gemini-3-flash-preview";

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.jsonl`);
		const hasSession = agentSessions.get(agentKey);

		const startTime = Date.now();
		const state = stepStates[stepIndex];
		const textChunks: string[] = [];

		try {
			// Resolve model from "provider/model-id" string
			const authStorage = AuthStorage.create();
			const modelRegistry = new ModelRegistry(authStorage);
			// Parse "provider/model-id" — split on first slash
			const slashIdx = modelStr.indexOf("/");
			const provider = slashIdx !== -1 ? modelStr.slice(0, slashIdx) : "anthropic";
			const modelId  = slashIdx !== -1 ? modelStr.slice(slashIdx + 1) : modelStr;
			const model = modelRegistry.find(provider, modelId)
				?? modelRegistry.getAvailable()[0];
			if (!model) {
				return { output: `Model not found: ${modelStr}`, exitCode: 1, elapsed: Date.now() - startTime };
			}
			const thinkingLevel = "off";

			// Resolve tools
			const tools = resolveTools(agentDef.tools, ctx.cwd ?? process.cwd());

			// Session manager — continue existing or start fresh
			const cwd = ctx.cwd ?? process.cwd();
			const sessionManager = hasSession
				? SessionManager.open(agentSessionFile)
				: SessionManager.create(cwd);

			// Inject system prompt via resource loader on fresh sessions only
			const agentSystemPrompt = agentDef.systemPrompt;
			const loader = new DefaultResourceLoader({
				cwd,
				...(!hasSession && agentSystemPrompt
					? { appendSystemPromptOverride: () => [agentSystemPrompt] }
					: {}),
			});
			await loader.reload();

			const { session } = await createAgentSession({
				cwd,
				model,
				thinkingLevel: "off",
				tools,
				sessionManager,
				resourceLoader: loader,
			});

			// Timer for widget updates
			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			// Stream output
			const unsub = session.subscribe((event: any) => {
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta" && delta.delta) {
						textChunks.push(delta.delta);
						const full = textChunks.join("");
						const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
						state.lastWork = last;
						updateWidget();
					}
				}
			});

			// Attach screenshots if provided (visual evaluation)
			const imagePayloads = (images ?? []).flatMap(img => {
				try {
					const data = readFileSyncNode(img.path);
					const ext = img.path.split(".").pop()?.toLowerCase() ?? "png";
					const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
						: ext === "webp" ? "image/webp"
						: "image/png";
					return [{ type: "image" as const, mimeType, data: data.toString("base64") }];
				} catch { return []; }
			});

			await session.prompt(task, imagePayloads.length > 0 ? { images: imagePayloads as any } : undefined);
			await session.agent.waitForIdle();

			unsub();
			clearInterval(timer);

			const elapsed = Date.now() - startTime;
			state.elapsed = elapsed;
			const output = textChunks.join("");
			state.lastWork = output.split("\n").filter((l: string) => l.trim()).pop() || "";

			// Persist session file path for next run
			agentSessions.set(agentKey, session.sessionFile ?? agentSessionFile);

			session.dispose();

			// Telemetry
			appendTelemetry({
				timestamp: new Date().toISOString(),
				chain: activeChain?.name ?? "unknown",
				agent: agentDef.name,
				model: modelStr,
				promptChars: task.length,
				outputChars: output.length,
				elapsedMs: elapsed,
			}, telemetryPath);

			return { output, exitCode: 0, elapsed };

		} catch (err: any) {
			const elapsed = Date.now() - startTime;
			return {
				output: `Error running agent ${agentDef.name}: ${err?.message ?? String(err)}`,
				exitCode: 1,
				elapsed,
			};
		}
	}

	// ── Score Parser ────────────────────────────
	/**
	 * Extract a numeric score from evaluator output.
	 * Looks for patterns like "SCORE: 7/10", "Score: 8", "7/10", "7 out of 10"
	 */
	function parseScore(output: string): number | null {
		const patterns = [
			/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i,
			/SCORE:\s*(\d+(?:\.\d+)?)/i,
			/(\d+(?:\.\d+)?)\s*\/\s*10/,
			/(\d+(?:\.\d+)?)\s+out\s+of\s+10/i,
			/rating[:\s]+(\d+(?:\.\d+)?)/i,
		];
		for (const re of patterns) {
			const m = output.match(re);
			if (m) {
				const n = parseFloat(m[1]);
				if (n >= 0 && n <= 10) return n;
			}
		}
		return null;
	}

	// ── Screenshot Capture ───────────────────────
	/**
	 * Tries to capture screenshots of the running app using Playwright CLI.
	 * Detects the dev server URL from package.json scripts or common defaults.
	 * Returns paths of saved screenshots, or [] if capture failed.
	 */
	async function captureScreenshots(cwd: string, screenshotDir: string, iter: number): Promise<string[]> {
		try {
			if (!existsSync(join(cwd, "package.json"))) return [];

			// Check Playwright is available
			const { execSync } = require("child_process");
			try { execSync("npx playwright --version", { cwd, stdio: "pipe" }); }
			catch { return []; }

			mkdirSync(screenshotDir, { recursive: true });

			// Detect dev server port from package.json or common defaults
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
			const devScript = pkg.scripts?.dev ?? pkg.scripts?.start ?? "";
			const portMatch = devScript.match(/--port[= ](\d+)|PORT=(\d+)|-p (\d+)/);
			const port = portMatch ? (portMatch[1] ?? portMatch[2] ?? portMatch[3]) : "3000";
			const baseUrl = `http://localhost:${port}`;

			// Common routes to screenshot
			const routes = ["/", "/dashboard", "/login", "/home"].slice(0, 3);
			const saved: string[] = [];

			for (const route of routes) {
				const filename = join(screenshotDir, `iter${iter}-${route.replace(/\//g, "_") || "root"}.png`);
				try {
					execSync(
						`npx playwright screenshot --browser chromium "${baseUrl}${route}" "${filename}"`,
						{ cwd, stdio: "pipe", timeout: 10000 }
					);
					if (existsSync(filename)) saved.push(filename);
				} catch {}
			}

			return saved;
		} catch {
			return [];
		}
	}

	// ── Run Loop Step ────────────────────────────
	/**
	 * Generator-evaluator loop. The generator builds, the evaluator scores.
	 * If score < threshold: critique feeds back to generator for another iteration.
	 * Continues until score >= threshold OR maxIterations reached.
	 */
	async function runLoopStep(
		loop: LoopStep,
		input: string,
		originalPrompt: string,
		stepIndex: number,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const startTime = Date.now();
		const state = stepStates[stepIndex];

		const generatorDef = allAgents.get(loop.generator.toLowerCase());
		const evaluatorDef = allAgents.get(loop.evaluator.toLowerCase());

		if (!generatorDef) return { output: `Loop generator agent "${loop.generator}" not found`, exitCode: 1, elapsed: 0 };
		if (!evaluatorDef) return { output: `Loop evaluator agent "${loop.evaluator}" not found`, exitCode: 1, elapsed: 0 };

		let currentInput = input;
		let lastOutput = "";
		let critique = "";

		for (let iter = 1; iter <= loop.maxIterations; iter++) {
			state.iteration = iter;
			state.lastWork = `Iteration ${iter}/${loop.maxIterations} — generating...`;
			updateWidget();

			// Build generator prompt
			const genPrompt = loop.generatorPrompt
				.replace(/\$INPUT/g, currentInput)
				.replace(/\$ORIGINAL/g, originalPrompt)
				.replace(/\$CRITIQUE/g, critique || "(no critique yet — first iteration)")
				.replace(/\$ITERATION/g, String(iter));

			const genResult = await runAgent(generatorDef, genPrompt, stepIndex, ctx);
			if (genResult.exitCode !== 0) return genResult;
			lastOutput = genResult.output;

			state.lastWork = `Iteration ${iter}/${loop.maxIterations} — capturing screenshots...`;
			updateWidget();

			// Take screenshots before evaluation — save to progress/screenshots/
			const screenshotDir = join(ctx.cwd, "progress", "screenshots");
			const screenshots = await captureScreenshots(ctx.cwd, screenshotDir, iter);

			state.lastWork = `Iteration ${iter}/${loop.maxIterations} — evaluating...`;
			updateWidget();

			// Build evaluator prompt — include screenshot context if captured
			const screenshotNote = screenshots.length > 0
				? `\n\nScreenshots captured: ${screenshots.length} page(s) at progress/screenshots/ — attached for visual review.`
				: "\n\n(No screenshots captured — app may not be running or Playwright not installed)";

			const evalPrompt = (loop.evaluatorPrompt + screenshotNote)
				.replace(/\$INPUT/g, lastOutput)
				.replace(/\$ORIGINAL/g, originalPrompt)
				.replace(/\$ITERATION/g, String(iter));

			const evalResult = await runAgent(evaluatorDef, evalPrompt, stepIndex, ctx, screenshots.map(p => ({ path: p })));
			if (evalResult.exitCode !== 0) return evalResult;

			const score = parseScore(evalResult.output);
			state.score = score ?? undefined;
			const scoreStr = score !== null ? `${score}/10` : "?/10";

			if (score !== null && score >= loop.passThreshold) {
				state.lastWork = `✓ Score ${scoreStr} — passed threshold (${loop.passThreshold}/10) on iteration ${iter}`;
				updateWidget();
				return { output: lastOutput, exitCode: 0, elapsed: Date.now() - startTime };
			}

			critique = evalResult.output;
			state.lastWork = `Score ${scoreStr} — below threshold, iterating...`;
			updateWidget();
		}

		// Exhausted iterations — return best output with warning
		state.lastWork = `⚠ Max iterations (${loop.maxIterations}) reached. Score: ${state.score ?? "?"}/${loop.passThreshold} threshold`;
		updateWidget();
		return { output: lastOutput, exitCode: 0, elapsed: Date.now() - startTime };
	}

	// ── Run Chain (sequential pipeline) ─────────

	async function runChain(
		task: string,
		ctx: any,
		fast = false,
	): Promise<{ output: string; success: boolean; elapsed: number }> {
		if (!activeChain) {
			return { output: "No chain active", success: false, elapsed: 0 };
		}

		const chainStart = Date.now();

		// Step 1: collapse consecutive same-agent steps before running
		const effectiveSteps = collapseConsecutiveSteps(activeChain.steps);

		// Rebuild stepStates to match effective (possibly collapsed) steps
		stepStates = effectiveSteps.map((s) => {
			const isLoop = "type" in s && s.type === "loop";
			const label = isLoop
				? `${(s as LoopStep).generator} ⟳ ${(s as LoopStep).evaluator}`
				: (s as ChainStep).agent;
			const merged = !isLoop && (() => {
				const cs = s as ChainStep;
				return activeChain!.steps.filter(os => !("type" in os) && (os as ChainStep).agent === cs.agent).length > 1 &&
					effectiveSteps.filter(es => !("type" in es) && (es as ChainStep).agent === cs.agent).length <
					activeChain!.steps.filter(os => !("type" in os) && (os as ChainStep).agent === cs.agent).length;
			})();
			return {
				agent: label,
				status: "pending" as const,
				elapsed: 0,
				lastWork: "",
				merged: merged || false,
			};
		});
		updateWidget();

		let input = task;
		const originalPrompt = task;

		for (let i = 0; i < effectiveSteps.length; i++) {
			const step = effectiveSteps[i];

			// Skip optional steps in fast mode
			if (fast && step.optional) {
				stepStates[i].status = "skipped";
				stepStates[i].lastWork = "skipped (fast mode)";
				logProgress({ cwd: ctx.cwd, chain: activeChain.name, agent: stepLabel(step), status: "skipped", output: "skipped (fast mode)", elapsed: 0 });
				updateWidget();
				continue;
			}

			stepStates[i].status = "running";
			updateWidget();

			// ── Loop step ────────────────────────
			if ("type" in step && step.type === "loop") {
				const result = await runLoopStep(step as LoopStep, input, originalPrompt, i, ctx);
				if (result.exitCode !== 0) {
					stepStates[i].status = "error";
					logProgress({ cwd: ctx.cwd, chain: activeChain.name, agent: stepLabel(step), status: "error", output: result.output, elapsed: result.elapsed });
					updateWidget();
					return { output: `Error in loop step: ${result.output}`, success: false, elapsed: Date.now() - chainStart };
				}
				stepStates[i].status = "done";
				logProgress({ cwd: ctx.cwd, chain: activeChain.name, agent: stepLabel(step), status: "done", output: result.output, elapsed: result.elapsed, iteration: stepStates[i].iteration, score: stepStates[i].score });
				updateWidget();
				input = result.output;
				continue;
			}

			// ── Regular step ─────────────────────
			const cs = step as ChainStep;

			const externalOriginal = externalizeIfLarge(
				originalPrompt,
				join(sessionDir, `original-${i}.txt`),
			);

			let resolvedPrompt = cs.prompt
				.replace(/\$INPUT/g, input)
				.replace(/\$ORIGINAL/g, externalOriginal);

			resolvedPrompt = externalizeIfLarge(
				resolvedPrompt,
				join(sessionDir, `task-${cs.agent}-${i}.txt`),
			);

			const agentDef = allAgents.get(cs.agent.toLowerCase());
			if (!agentDef) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = `Agent "${cs.agent}" not found`;
				updateWidget();
				return {
					output: `Error at step ${i + 1}: Agent "${cs.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			// Planner role: inject ambition directive
			const plannerPrefix = cs.role === "planner"
				? "You are a project planner. Expand this raw prompt into a full, AMBITIOUS product spec. Include: feature list, AI integration opportunities, design language, and technical approach. Be specific. Do NOT over-specify implementation details.\n\n"
				: "";

			const result = await runAgent(agentDef, plannerPrefix + resolvedPrompt, i, ctx);

			if (result.exitCode !== 0) {
				stepStates[i].status = "error";
				logProgress({ cwd: ctx.cwd, chain: activeChain.name, agent: cs.agent, status: "error", output: result.output, elapsed: result.elapsed });
				updateWidget();
				return {
					output: `Error at step ${i + 1} (${cs.agent}): ${result.output}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			stepStates[i].status = "done";
			logProgress({ cwd: ctx.cwd, chain: activeChain.name, agent: cs.agent, status: "done", output: result.output, elapsed: result.elapsed });
			updateWidget();

			input = result.output;
		}

		// Step 7: compact bloated session files after a successful run
		compactSessions(sessionDir, agentSessions);

		return { output: input, success: true, elapsed: Date.now() - chainStart };
	}

	// ── run_chain Tool ──────────────────────────

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description: "Execute the active agent chain pipeline. Each step runs sequentially — output from one step feeds into the next. Agents maintain session context across runs. Use fast=true to skip optional steps.",
		parameters: Type.Object({
			task: Type.String({ description: "The task/prompt for the chain to process" }),
			fast: Type.Optional(Type.Boolean({ description: "Skip optional steps (reviews, security audit) for quick iterations. Default: false." })),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { task, fast = false } = params as { task: string; fast?: boolean };

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting chain: ${activeChain?.name}${fast ? " (fast mode)" : ""}...` }],
					details: { chain: activeChain?.name, task, status: "running", fast },
				});
			}

			const result = await runChain(task, ctx, fast);

			const truncated = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;

			const status = result.success ? "done" : "error";
			const summary = `[chain:${activeChain?.name}${fast ? ":fast" : ""}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

			return {
				content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
				details: {
					chain: activeChain?.name,
					task,
					status,
					fast,
					elapsed: result.elapsed,
					fullOutput: result.output,
				},
			};
		},

		renderCall(args, theme) {
			const task = (args as any).task || "";
			const fast = (args as any).fast;
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_chain ")) +
				theme.fg("accent", activeChain?.name || "?") +
				(fast ? theme.fg("muted", " [fast]") : "") +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "running") {
				return new Text(
					theme.fg("accent", `● ${details.chain || "chain"}`) +
					theme.fg("dim", " running..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.chain}`) +
				(details.fast ? theme.fg("muted", " [fast]") : "") +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("chain", {
		description: "Switch active chain",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const options = chains.map(c => {
				const steps = c.steps.map(s => displayName(stepLabel(s))).join(" → ");
				const desc = c.description ? ` — ${c.description}` : "";
				return `${c.name}${desc} (${steps})`;
			});

			const choice = await ctx.ui.select("Select Chain", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			activateChain(chains[idx]);
			const flow = chains[idx].steps.map(s => displayName(stepLabel(s))).join(" → ");
			ctx.ui.setStatus("agent-chain", `Chain: ${chains[idx].name} (${chains[idx].steps.length} steps)`);
			ctx.ui.notify(
				`Chain: ${chains[idx].name}\n${chains[idx].description}\n${flow}`,
				"info",
			);
		},
	});

	pi.registerCommand("chain-list", {
		description: "List all available chains",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const list = chains.map(c => {
				const desc = c.description ? `  ${c.description}` : "";
				const steps = c.steps.map((s, i) =>
					`  ${i + 1}. ${displayName(stepLabel(s))}${s.optional ? " (optional)" : ""}${isLoop(s) ? ` [loop ≤${s.maxIterations} iters, threshold ${s.passThreshold}/10]` : ""}`
				).join("\n");
				return `${c.name}:${desc ? "\n" + desc : ""}\n${steps}`;
			}).join("\n\n");

			ctx.ui.notify(list, "info");
		},
	});

	// Step 0: /chain-stats command — show telemetry summary
	pi.registerCommand("chain-stats", {
		description: "Show token/time telemetry for chain runs",
		handler: async (_args, ctx) => {
			if (!existsSync(telemetryPath)) {
				ctx.ui.notify("No telemetry data yet. Run a chain first.", "info");
				return;
			}
			try {
				const entries: TelemetryEntry[] = JSON.parse(readFileSync(telemetryPath, "utf-8"));
				if (entries.length === 0) {
					ctx.ui.notify("No telemetry entries found.", "info");
					return;
				}

				// Aggregate by agent
				const byAgent = new Map<string, { calls: number; promptChars: number; outputChars: number; elapsedMs: number }>();
				let totalPromptChars = 0;
				let totalOutputChars = 0;
				let totalElapsed = 0;

				for (const e of entries) {
					const key = `${e.agent} (${e.model.split("/").pop()})`;
					const agg = byAgent.get(key) ?? { calls: 0, promptChars: 0, outputChars: 0, elapsedMs: 0 };
					agg.calls++;
					agg.promptChars += e.promptChars;
					agg.outputChars += e.outputChars;
					agg.elapsedMs += e.elapsedMs;
					byAgent.set(key, agg);
					totalPromptChars += e.promptChars;
					totalOutputChars += e.outputChars;
					totalElapsed += e.elapsedMs;
				}

				const rows = Array.from(byAgent.entries())
					.sort((a, b) => b[1].promptChars - a[1].promptChars)
					.map(([name, s]) =>
						`${name}\n  calls: ${s.calls}  prompt: ${(s.promptChars / 1000).toFixed(1)}k chars  output: ${(s.outputChars / 1000).toFixed(1)}k chars  time: ${Math.round(s.elapsedMs / 1000)}s`
					).join("\n");

				const summary =
					`Chain Telemetry (${entries.length} runs)\n` +
					`Total prompt: ${(totalPromptChars / 1000).toFixed(1)}k chars  output: ${(totalOutputChars / 1000).toFixed(1)}k chars  time: ${Math.round(totalElapsed / 1000)}s\n\n` +
					rows;

				ctx.ui.notify(summary, "info");
			} catch {
				ctx.ui.notify("Failed to read telemetry file.", "error");
			}
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!activeChain) return {};

		// Step 3: return cached dispatcher prompt — built once in activateChain, not rebuilt every turn
		return { systemPrompt: cachedDispatcherPrompt ?? buildDispatcherPrompt() };
	});

	// ── Session Start ───────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		// Clear widget with both old and new ctx — one of them will be valid
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-chain", undefined);
		}
		_ctx.ui.setWidget("agent-chain", undefined);
		widgetCtx = _ctx;

		// Reset execution state
		stepStates = [];
		activeChain = null;
		cachedDispatcherPrompt = null;

		// Wipe chain session files — reset agent context on /new and launch
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("chain-") && f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Reload chains + clear agentSessions map (all agents start fresh)
		loadChains(_ctx.cwd);

		if (chains.length === 0) {
			_ctx.ui.notify("No chains found in .pi/agents/agent-chain.yaml", "warning");
			return;
		}

		// Check for --chain=<name> in process.argv (set via PI_CHAIN env var or direct arg)
		let targetChain: ChainDef | undefined;
		const chainEnv = process.env.PI_CHAIN;
		if (chainEnv) {
			targetChain = chains.find(c => c.name === chainEnv || c.name === chainEnv.replace(/-/g, "_"));
		}
		if (!targetChain) {
			for (const arg of process.argv) {
				const match = arg.match(/^--chain=(.+)$/);
				if (match) {
					const name = match[1].replace(/-/g, "_").replace(/^_+|_+$/g, "");
					targetChain = chains.find(c => c.name === name || c.name.replace(/_/g, "-") === match[1]);
					break;
				}
			}
		}

		// Auto-select if specified, otherwise default to first chain
		if (targetChain) {
			activateChain(targetChain);
		} else {
			activateChain(chains[0]);
		}

		// run_chain is registered as a tool — available alongside all default tools

		const flow = activeChain!.steps.map(s => displayName(stepLabel(s))).join(" → ");
		_ctx.ui.setStatus("agent-chain", `Chain: ${activeChain!.name} (${activeChain!.steps.length} steps)`);
		_ctx.ui.notify(
			`Chain: ${activeChain!.name}\n${activeChain!.description}\n${flow}\n\n` +
			`/chain             Switch chain\n` +
			`/chain-list        List all chains\n` +
			`/chain-stats       View token/time telemetry`,
			"info",
		);

		// Footer: model | chain name | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage?.percent ?? 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const chainLabel = activeChain
					? theme.fg("accent", activeChain.name)
					: theme.fg("dim", "no chain");

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					chainLabel;
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
