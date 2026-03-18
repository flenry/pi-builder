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
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
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
}

interface ChainDef {
	name: string;
	description: string;
	steps: ChainStep[];
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
	merged?: boolean; // true if this step was collapsed from multiple consecutive steps
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

// ── Chain YAML Parser ────────────────────────────

function parseChainYaml(raw: string): ChainDef[] {
	const chains: ChainDef[] = [];
	let current: ChainDef | null = null;
	let currentStep: ChainStep | null = null;

	for (const line of raw.split("\n")) {
		// Chain name: top-level key
		const chainMatch = line.match(/^(\S[^:]*):$/);
		if (chainMatch) {
			if (current && currentStep) {
				current.steps.push(currentStep);
				currentStep = null;
			}
			current = { name: chainMatch[1].trim(), description: "", steps: [] };
			chains.push(current);
			continue;
		}

		// Chain description
		const descMatch = line.match(/^\s+description:\s+(.+)$/);
		if (descMatch && current && !currentStep) {
			let desc = descMatch[1].trim();
			if ((desc.startsWith('"') && desc.endsWith('"')) ||
				(desc.startsWith("'") && desc.endsWith("'"))) {
				desc = desc.slice(1, -1);
			}
			current.description = desc;
			continue;
		}

		// "steps:" label — skip
		if (line.match(/^\s+steps:\s*$/) && current) {
			continue;
		}

		// Step agent line
		const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
		if (agentMatch && current) {
			if (currentStep) {
				current.steps.push(currentStep);
			}
			currentStep = { agent: agentMatch[1].trim(), prompt: "" };
			continue;
		}

		// Step optional flag
		const optionalMatch = line.match(/^\s+optional:\s+(true|false)$/);
		if (optionalMatch && currentStep) {
			currentStep.optional = optionalMatch[1] === "true";
			continue;
		}

		// Step prompt line
		const promptMatch = line.match(/^\s+prompt:\s+(.+)$/);
		if (promptMatch && currentStep) {
			let prompt = promptMatch[1].trim();
			if ((prompt.startsWith('"') && prompt.endsWith('"')) ||
				(prompt.startsWith("'") && prompt.endsWith("'"))) {
				prompt = prompt.slice(1, -1);
			}
			prompt = prompt.replace(/\\n/g, "\n");
			currentStep.prompt = prompt;
			continue;
		}
	}

	if (current && currentStep) {
		current.steps.push(currentStep);
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
function collapseConsecutiveSteps(steps: ChainStep[]): ChainStep[] {
	const collapsed: ChainStep[] = [];
	let i = 0;
	while (i < steps.length) {
		const current = steps[i];
		const group = [current];
		let j = i + 1;
		while (j < steps.length && steps[j].agent === current.agent) {
			group.push(steps[j]);
			j++;
		}
		if (group.length > 1) {
			const mergedPrompt = group
				.map((s, idx) => `## Pass ${idx + 1}\n${s.prompt}`)
				.join("\n\n---\n\n");
			collapsed.push({
				agent: current.agent,
				prompt: mergedPrompt,
				optional: current.optional,
			});
		} else {
			collapsed.push(current);
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
	let pendingReset = false;

	// ── Step 3: Cached dispatcher system prompt ──
	let cachedDispatcherPrompt: string | null = null;

	function buildDispatcherPrompt(): string {
		if (!activeChain) return "";

		const flow = activeChain.steps.map(s => displayName(s.agent)).join(" → ");
		const desc = activeChain.description ? `\n${activeChain.description}` : "";

		// Short step list — no full system prompt text, just name + description + optional flag
		const steps = activeChain.steps.map((s, i) => {
			const agentDef = allAgents.get(s.agent.toLowerCase());
			const agentDesc = agentDef?.description || "";
			const optionalTag = s.optional ? " *(optional — skipped in fast mode)*" : "";
			return `${i + 1}. **${displayName(s.agent)}**${optionalTag} — ${agentDesc}`;
		}).join("\n");

		// Agent catalog: description + tools only — no full system prompt
		const seen = new Set<string>();
		const agentCatalog = activeChain.steps
			.filter(s => {
				const key = s.agent.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map(s => {
				const agentDef = allAgents.get(s.agent.toLowerCase());
				if (!agentDef) return `### ${displayName(s.agent)}\nAgent not found.`;
				return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}`;
			})
			.join("\n\n");

		return `You are a pipeline dispatcher. Your ONLY job is to route tasks through the "${activeChain.name}" chain via the run_chain tool.${desc}

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agents in This Chain

${agentCatalog}

## Rules — READ CAREFULLY

1. **ALWAYS call run_chain for ANY task.** You are a dispatcher, not a doer.
2. **NEVER implement, code, test, or build anything yourself.** That's what the chain agents are for.
3. **NEVER skip the chain.** Even if the task seems simple, run it through the pipeline. The whole point is TDD discipline.
4. Your other tools (read, bash, grep, etc.) are ONLY for pre-chain investigation if you need to understand the request before dispatching.
5. After the chain completes, summarize what each agent did and report the final result.

## How run_chain Works
- Pass a clear, specific task description to run_chain
- Each step's output feeds into the next step as \$INPUT
- Use \`fast: true\` to skip optional steps for quick iterations
- You can run the chain multiple times with different tasks if needed

## Your Workflow
1. User gives you a task
2. Optionally read relevant files to understand the scope
3. Call run_chain with a clear task description (and fast: true for quick iterations)
4. Summarize the chain's output for the user`;
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
			agent: s.agent,
			status: "pending" as const,
			elapsed: 0,
			lastWork: "",
		}));
		// Step 3: build and cache dispatcher prompt when chain changes
		cachedDispatcherPrompt = buildDispatcherPrompt();
		// Skip widget re-registration if reset is pending — let before_agent_start handle it
		if (!pendingReset) {
			updateWidget();
		}
	}

	// ── Card Rendering ──────────────────────────

	function renderCard(state: StepState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "pending" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success"
			: state.status === "skipped" ? "muted"
			: "error";
		const statusIcon = state.status === "pending" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓"
			: state.status === "skipped" ? "⊘"
			: "✗";

		const name = displayName(state.agent) + (state.merged ? " ×" : "");
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "pending" && state.status !== "skipped"
			? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		const workRaw = state.lastWork || "";
		const workText = workRaw ? truncate(workRaw, Math.min(50, w - 1)) : "";
		const workLine = workText ? theme.fg("muted", workText) : theme.fg("dim", "—");
		const workVisible = workText ? workText.length : 1;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			theme.fg("dim", bot),
		];
	}

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

					const arrowWidth = 5; // " ──▶ "
					const cols = stepStates.length;
					const totalArrowWidth = arrowWidth * (cols - 1);
					const colWidth = Math.max(12, Math.floor((width - totalArrowWidth) / cols));
					const arrowRow = 2; // middle of 5-line card (0-indexed)

					const cards = stepStates.map(s => renderCard(s, colWidth, theme));
					const cardHeight = cards[0].length;
					const outputLines: string[] = [];

					for (let line = 0; line < cardHeight; line++) {
						let row = cards[0][line];
						for (let c = 1; c < cols; c++) {
							if (line === arrowRow) {
								row += theme.fg("dim", " ──▶ ");
							} else {
								row += " ".repeat(arrowWidth);
							}
							row += cards[c][line];
						}
						outputLines.push(row);
					}

					text.setText(outputLines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Run Agent (subprocess) ──────────────────

	function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		// Use agent-specific model if defined, otherwise fall back to parent's model
		const model = agentDef.model
			? agentDef.model
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "openrouter/google/gemini-3-flash-preview";

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--model", model,
			"--tools", agentDef.tools,
			"--thinking", "off",
			// Step 2: only append system prompt on fresh sessions — not on resumes
			...(hasSession ? [] : ["--append-system-prompt", agentDef.systemPrompt]),
			"--session", agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const startTime = Date.now();
		const state = stepStates[stepIndex];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(timer);
				const elapsed = Date.now() - startTime;
				state.elapsed = elapsed;
				const output = textChunks.join("");
				state.lastWork = output.split("\n").filter((l: string) => l.trim()).pop() || "";

				if (code === 0) {
					agentSessions.set(agentKey, agentSessionFile);
				}

				// Step 0: log telemetry entry
				appendTelemetry({
					timestamp: new Date().toISOString(),
					chain: activeChain?.name ?? "unknown",
					agent: agentDef.name,
					model,
					promptChars: task.length,
					outputChars: output.length,
					elapsedMs: elapsed,
				}, telemetryPath);

				resolve({ output, exitCode: code ?? 1, elapsed });
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
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
		stepStates = effectiveSteps.map((s, i) => {
			const originalCount = activeChain!.steps.filter((os, oi) => {
				// find if this was a collapsed step
				return os.agent === s.agent;
			}).length;
			const merged = originalCount > 1 &&
				activeChain!.steps.filter(os => os.agent === s.agent).length > 1 &&
				effectiveSteps.filter(es => es.agent === s.agent).length <
				activeChain!.steps.filter(os => os.agent === s.agent).length;
			return {
				agent: s.agent,
				status: "pending" as const,
				elapsed: 0,
				lastWork: "",
				merged,
			};
		});
		updateWidget();

		let input = task;
		const originalPrompt = task;

		for (let i = 0; i < effectiveSteps.length; i++) {
			const step = effectiveSteps[i];

			// Step 8: skip optional steps in fast mode
			if (fast && step.optional) {
				stepStates[i].status = "skipped";
				stepStates[i].lastWork = "skipped (fast mode)";
				updateWidget();
				continue;
			}

			stepStates[i].status = "running";
			updateWidget();

			// Step 4: externalize $ORIGINAL if it's large
			const externalOriginal = externalizeIfLarge(
				originalPrompt,
				join(sessionDir, `original-${i}.txt`),
			);

			// Resolve prompt substitutions
			let resolvedPrompt = step.prompt
				.replace(/\$INPUT/g, input)
				.replace(/\$ORIGINAL/g, externalOriginal);

			// Step 4: externalize the full resolved prompt if it's still too large
			resolvedPrompt = externalizeIfLarge(
				resolvedPrompt,
				join(sessionDir, `task-${step.agent}-${i}.txt`),
			);

			const agentDef = allAgents.get(step.agent.toLowerCase());
			if (!agentDef) {
				stepStates[i].status = "error";
				stepStates[i].lastWork = `Agent "${step.agent}" not found`;
				updateWidget();
				return {
					output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			const result = await runAgent(agentDef, resolvedPrompt, i, ctx);

			if (result.exitCode !== 0) {
				stepStates[i].status = "error";
				updateWidget();
				return {
					output: `Error at step ${i + 1} (${step.agent}): ${result.output}`,
					success: false,
					elapsed: Date.now() - chainStart,
				};
			}

			stepStates[i].status = "done";
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
				const steps = c.steps.map(s => displayName(s.agent)).join(" → ");
				const desc = c.description ? ` — ${c.description}` : "";
				return `${c.name}${desc} (${steps})`;
			});

			const choice = await ctx.ui.select("Select Chain", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			activateChain(chains[idx]);
			const flow = chains[idx].steps.map(s => displayName(s.agent)).join(" → ");
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
					`  ${i + 1}. ${displayName(s.agent)}${s.optional ? " (optional)" : ""}`
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
		// Force widget reset on first turn after /new
		if (pendingReset && activeChain) {
			pendingReset = false;
			widgetCtx = _ctx;
			stepStates = activeChain.steps.map(s => ({
				agent: s.agent,
				status: "pending" as const,
				elapsed: 0,
				lastWork: "",
			}));
			updateWidget();
		}

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

		// Reset execution state — widget re-registration deferred to before_agent_start
		stepStates = [];
		activeChain = null;
		cachedDispatcherPrompt = null;
		pendingReset = true;

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

		const flow = activeChain!.steps.map(s => displayName(s.agent)).join(" → ");
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
