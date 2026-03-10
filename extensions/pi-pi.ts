/**
 * Pi Pi — One-command Pi builder for any repository
 *
 * Automatically analyzes the current repo, queries domain experts in parallel,
 * and builds a complete Pi configuration: extensions, skills, agents, settings,
 * themes, justfile, and project instructions.
 *
 * On session start it:
 * 1. Scans the repo (languages, frameworks, structure, existing config)
 * 2. Matches against the extension library
 * 3. Injects everything as the first prompt so the orchestrator starts immediately
 *
 * Commands:
 *   /experts          — list available experts and their status
 *   /experts-grid N   — set dashboard column count (default 3)
 *   /analyze          — re-run project analysis and show results
 *
 * Usage: pi -e extensions/pi-pi.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	systemPrompt: string;
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	timer?: ReturnType<typeof setInterval>;
}

interface ProjectAnalysis {
	name: string;
	stack: string[];
	triggers: string[];
	languages: string[];
	buildTools: string[];
	hasMonorepo: boolean;
	hasFrontend: boolean;
	hasBackend: boolean;
	hasInfra: boolean;
	hasDocker: boolean;
	hasCI: boolean;
	hasExistingPi: boolean;
	existingPiFiles: string[];
	subprojects: string[];
	keyFiles: string[];
	summary: string;
}

interface LibraryExtension {
	path: string;
	description: string;
	tags: string[];
	triggers: string[];
	stackable: boolean;
	depends?: string[];
	requires?: { piFiles?: string[]; npmDeps?: string[]; agentDefs?: boolean };
}

interface Library {
	extensions: Record<string, LibraryExtension>;
	skills: Record<string, any>;
	mcps: Record<string, any>;
	agentTemplates: Record<string, any>;
	themes: { path: string; available: string[] };
	presets: Record<string, any>;
}

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function parseAgentFile(filePath: string): ExpertDef | null {
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
			file: filePath,
		};
	} catch {
		return null;
	}
}

// ── Expert card colors ────────────────────────────
const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert":      { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m"  },
	"config-expert":     { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   },
	"ext-expert":        { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   },
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  },
	"prompt-expert":     { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  },
	"skill-expert":      { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  },
	"theme-expert":      { bg: "\x1b[48;2;80;18;62m",  br: "\x1b[38;2;210;55;160m"  },
	"tui-expert":        { bg: "\x1b[48;2;28;42;80m",  br: "\x1b[38;2;85;120;210m"  },
	"cli-expert":        { bg: "\x1b[48;2;60;80;20m",  br: "\x1b[38;2;160;210;55m"  },
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

// ── Project Analysis ─────────────────────────────

function analyzeProject(projectDir: string): ProjectAnalysis {
	const triggers: string[] = [];
	const stack: string[] = [];
	const languages: string[] = [];
	const buildTools: string[] = [];
	const subprojects: string[] = [];
	const keyFiles: string[] = [];

	// Scan for package.json files (up to 2 levels deep)
	const scanDirs = [projectDir];
	try {
		for (const entry of readdirSync(projectDir)) {
			if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build" || entry === "vendor") continue;
			const sub = join(projectDir, entry);
			try { if (statSync(sub).isDirectory()) scanDirs.push(sub); } catch {}
		}
	} catch {}

	for (const dir of scanDirs) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (dir !== projectDir) subprojects.push(basename(dir));
				keyFiles.push(dir === projectDir ? "package.json" : `${basename(dir)}/package.json`);

				const allDeps = {
					...(pkg.dependencies || {}),
					...(pkg.devDependencies || {}),
					...(pkg.peerDependencies || {}),
				};

				for (const dep of Object.keys(allDeps)) {
					triggers.push(dep);
					if (dep.startsWith("@")) triggers.push(dep.split("/")[0]);
				}

				if (allDeps["react"] || allDeps["react-dom"]) stack.push("React");
				if (allDeps["vue"]) stack.push("Vue");
				if (allDeps["angular"] || allDeps["@angular/core"]) stack.push("Angular");
				if (allDeps["next"]) stack.push("Next.js");
				if (allDeps["nuxt"]) stack.push("Nuxt");
				if (allDeps["svelte"]) stack.push("Svelte");
				if (allDeps["express"]) stack.push("Express");
				if (allDeps["fastify"]) stack.push("Fastify");
				if (allDeps["nestjs"] || allDeps["@nestjs/core"]) stack.push("NestJS");
				if (allDeps["aws-cdk-lib"] || allDeps["aws-cdk"]) stack.push("AWS CDK");
				if (Object.keys(allDeps).some(d => d.startsWith("@aws-sdk/"))) stack.push("AWS SDK");
				if (allDeps["prisma"] || allDeps["@prisma/client"]) stack.push("Prisma");
				if (allDeps["drizzle-orm"]) stack.push("Drizzle");
				if (allDeps["pg"] || allDeps["postgres"]) stack.push("PostgreSQL");
				if (allDeps["mongoose"] || allDeps["mongodb"]) stack.push("MongoDB");
				if (allDeps["playwright"] || allDeps["@playwright/test"]) stack.push("Playwright");
				if (allDeps["cypress"]) stack.push("Cypress");
				if (allDeps["typescript"] || allDeps["ts-node"]) stack.push("TypeScript");
				if (allDeps["bun-types"] || allDeps["bun"]) stack.push("Bun");
				if (allDeps["vitest"]) stack.push("Vitest");
				if (allDeps["jest"]) stack.push("Jest");
				if (allDeps["mocha"]) stack.push("Mocha");
				if (allDeps["eslint"]) stack.push("ESLint");
				if (allDeps["prettier"]) stack.push("Prettier");
				if (allDeps["tailwindcss"]) stack.push("Tailwind CSS");
				if (allDeps["graphql"]) stack.push("GraphQL");
				if (allDeps["redis"] || allDeps["ioredis"]) stack.push("Redis");
				if (allDeps["@trpc/server"]) stack.push("tRPC");
				if (allDeps["zod"]) stack.push("Zod");

				if (pkg.scripts) {
					for (const [, cmd] of Object.entries(pkg.scripts)) {
						if (typeof cmd === "string") {
							if (cmd.includes("cdk")) triggers.push("cdk");
							if (cmd.includes("docker")) triggers.push("docker");
							if (cmd.includes("playwright")) triggers.push("playwright");
						}
					}
				}

				if (!languages.includes("JavaScript/TypeScript")) languages.push("JavaScript/TypeScript");
			} catch {}
		}

		// Python
		for (const pyFile of ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
			if (existsSync(join(dir, pyFile))) {
				if (!languages.includes("Python")) languages.push("Python");
				keyFiles.push(dir === projectDir ? pyFile : `${basename(dir)}/${pyFile}`);
				try {
					const content = readFileSync(join(dir, pyFile), "utf-8");
					if (content.includes("django")) { triggers.push("django"); stack.push("Django"); }
					if (content.includes("flask")) { triggers.push("flask"); stack.push("Flask"); }
					if (content.includes("fastapi")) { triggers.push("fastapi"); stack.push("FastAPI"); }
					if (content.includes("boto3")) { triggers.push("boto3"); stack.push("boto3"); }
					if (content.includes("pytest")) stack.push("pytest");
				} catch {}
			}
		}

		// Go
		if (existsSync(join(dir, "go.mod"))) {
			if (!languages.includes("Go")) languages.push("Go");
			keyFiles.push(dir === projectDir ? "go.mod" : `${basename(dir)}/go.mod`);
		}

		// Rust
		if (existsSync(join(dir, "Cargo.toml"))) {
			if (!languages.includes("Rust")) languages.push("Rust");
			keyFiles.push(dir === projectDir ? "Cargo.toml" : `${basename(dir)}/Cargo.toml`);
		}

		// Java/Kotlin
		for (const jFile of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
			if (existsSync(join(dir, jFile))) {
				if (!languages.includes("Java/Kotlin")) languages.push("Java/Kotlin");
				keyFiles.push(dir === projectDir ? jFile : `${basename(dir)}/${jFile}`);
			}
		}
	}

	// Build tools
	const buildToolChecks: [string, string][] = [
		["Makefile", "Make"],
		["justfile", "just"],
		["Taskfile.yml", "Task"],
		["Rakefile", "Rake"],
		["CMakeLists.txt", "CMake"],
		["Gruntfile.js", "Grunt"],
		["gulpfile.js", "Gulp"],
	];
	for (const [file, tool] of buildToolChecks) {
		if (existsSync(join(projectDir, file))) {
			buildTools.push(tool);
			keyFiles.push(file);
		}
	}

	// Infra/CI/Docker detection
	const fileChecks: [string, string, string][] = [
		["Dockerfile", "docker", "Docker"],
		["docker-compose.yml", "docker-compose", "Docker Compose"],
		["docker-compose.yaml", "docker-compose", "Docker Compose"],
		[".github", ".github", "GitHub Actions"],
		[".gitlab-ci.yml", "gitlab-ci", "GitLab CI"],
		["cdk.json", "cdk", "AWS CDK"],
		["serverless.yml", "serverless", "Serverless"],
		["terraform", "terraform", "Terraform"],
		["k8s", "kubernetes", "Kubernetes"],
		["helm", "helm", "Helm"],
		[".env", "env-files", "Env Files"],
		[".claude", ".claude", "Claude Code"],
		[".gemini", ".gemini", "Gemini"],
		[".codex", ".codex", "Codex"],
		[".cursor", ".cursor", "Cursor"],
	];
	for (const [file, trigger, label] of fileChecks) {
		if (existsSync(join(projectDir, file))) {
			triggers.push(trigger);
			if (!stack.includes(label)) stack.push(label);
			keyFiles.push(file);
		}
	}

	// README keyword scan
	for (const readmeFile of ["README.md", "readme.md"]) {
		if (existsSync(join(projectDir, readmeFile))) {
			keyFiles.push(readmeFile);
			try {
				const readme = readFileSync(join(projectDir, readmeFile), "utf-8").toLowerCase();
				const keywords = ["aws", "lambda", "s3", "dynamodb", "microservice", "monorepo",
					"docker", "kubernetes", "terraform", "serverless", "graphql", "rest api",
					"websocket", "redis", "elasticsearch", "kafka", "ci/cd"];
				for (const kw of keywords) {
					if (readme.includes(kw)) triggers.push(kw);
				}
			} catch {}
		}
	}

	// CLAUDE.md
	if (existsSync(join(projectDir, "CLAUDE.md"))) {
		keyFiles.push("CLAUDE.md");
	}

	// Existing .pi config
	const existingPiFiles: string[] = [];
	const piDir = join(projectDir, ".pi");
	if (existsSync(piDir)) {
		try {
			const scan = (dir: string, prefix: string) => {
				for (const entry of readdirSync(dir)) {
					const full = join(dir, entry);
					const rel = prefix ? `${prefix}/${entry}` : entry;
					try {
						if (statSync(full).isDirectory()) scan(full, rel);
						else existingPiFiles.push(rel);
					} catch {}
				}
			};
			scan(piDir, "");
		} catch {}
	}

	// Deduplicate
	const uniqueTriggers = [...new Set(triggers.map(t => t.toLowerCase()))];
	const uniqueStack = [...new Set(stack)];
	const uniqueLangs = [...new Set(languages)];

	const hasFrontend = uniqueStack.some(s => ["React", "Vue", "Angular", "Next.js", "Nuxt", "Svelte"].includes(s));
	const hasBackend = uniqueStack.some(s => ["Express", "Fastify", "NestJS", "Django", "Flask", "FastAPI", "tRPC"].includes(s));
	const hasInfra = uniqueStack.some(s => ["AWS CDK", "Terraform", "Serverless", "Kubernetes"].includes(s));
	const hasDocker = uniqueTriggers.includes("docker") || uniqueTriggers.includes("docker-compose");
	const hasCI = uniqueTriggers.includes(".github") || uniqueTriggers.includes("gitlab-ci");
	const hasMonorepo = subprojects.length > 1;

	const parts: string[] = [];
	if (uniqueLangs.length > 0) parts.push(`Languages: ${uniqueLangs.join(", ")}`);
	if (uniqueStack.length > 0) parts.push(`Stack: ${uniqueStack.join(", ")}`);
	if (buildTools.length > 0) parts.push(`Build tools: ${buildTools.join(", ")}`);
	if (subprojects.length > 0) parts.push(`Sub-projects: ${subprojects.join(", ")}`);
	if (hasMonorepo) parts.push("Monorepo detected");
	if (hasFrontend) parts.push("Has frontend");
	if (hasBackend) parts.push("Has backend");
	if (hasInfra) parts.push("Has infrastructure-as-code");
	if (hasDocker) parts.push("Uses Docker");
	if (hasCI) parts.push("Has CI/CD");

	return {
		name: basename(projectDir),
		stack: uniqueStack,
		triggers: uniqueTriggers,
		languages: uniqueLangs,
		buildTools,
		hasMonorepo,
		hasFrontend,
		hasBackend,
		hasInfra,
		hasDocker,
		hasCI,
		hasExistingPi: existingPiFiles.length > 0,
		existingPiFiles,
		subprojects,
		keyFiles: [...new Set(keyFiles)],
		summary: parts.join("\n"),
	};
}

// ── Library Matching ─────────────────────────────

function loadLibrary(): Library | null {
	const libPath = join(dirname(new URL(import.meta.url).pathname), "..", "pi-library.json");
	try {
		return JSON.parse(readFileSync(libPath, "utf-8"));
	} catch {
		return null;
	}
}

function scoreItem(projectTriggers: string[], itemTriggers: string[]): number {
	if (itemTriggers.includes("*")) return 1;
	let score = 0;
	for (const t of itemTriggers) {
		if (projectTriggers.some(pt => pt.includes(t.toLowerCase()) || t.toLowerCase().includes(pt))) {
			score += 2;
		}
	}
	return score;
}

function getLibraryRecommendations(analysis: ProjectAnalysis, library: Library): string {
	const lines: string[] = [];

	lines.push("### Available Library Extensions");
	lines.push("These are pre-built extensions you can copy to .pi/extensions/. Score indicates relevance (higher = better match).");
	lines.push("");

	const extScores = Object.entries(library.extensions)
		.map(([name, ext]) => ({ name, ext, score: scoreItem(analysis.triggers, ext.triggers) }))
		.sort((a, b) => b.score - a.score);

	for (const { name, ext, score } of extScores) {
		const marker = score > 1 ? "★★" : score === 1 ? "★" : "·";
		const deps = ext.depends ? ` (depends: ${ext.depends.map(d => basename(d)).join(", ")})` : "";
		const reqs = ext.requires?.piFiles ? ` [needs: ${ext.requires.piFiles.join(", ")}]` : "";
		lines.push(`- ${marker} **${name}** (score: ${score}): ${ext.description}${deps}${reqs}`);
	}

	lines.push("");
	lines.push("### Available Library Skills");
	for (const [name, skill] of Object.entries(library.skills)) {
		const score = scoreItem(analysis.triggers, skill.triggers);
		lines.push(`- ${score > 0 ? "★" : "·"} **${name}** (score: ${score}): ${skill.description}`);
	}

	lines.push("");
	lines.push("### Available Agent Templates");
	for (const [name, agent] of Object.entries(library.agentTemplates)) {
		lines.push(`- **${name}**: ${agent.description}`);
	}

	lines.push("");
	lines.push("### Available Themes");
	lines.push(library.themes.available.join(", "));

	lines.push("");
	lines.push("### Presets (pre-configured combos)");
	for (const [name, preset] of Object.entries(library.presets)) {
		lines.push(`- **${name}**: ${preset.description} → [${preset.extensions.join(", ")}]`);
	}

	return lines.join("\n");
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	let gridCols = 3;
	let widgetCtx: any;
	let lastAnalysis: ProjectAnalysis | null = null;

	function loadExperts(cwd: string) {
		const piPiDir = join(cwd, ".pi", "agents", "pi-pi");
		experts.clear();

		if (!existsSync(piPiDir)) return;
		try {
			for (const file of readdirSync(piPiDir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "pi-orchestrator.md") continue;
				const fullPath = resolve(piPiDir, file);
				const def = parseAgentFile(fullPath);
				if (def) {
					const key = def.name.toLowerCase();
					if (!experts.has(key)) {
						experts.set(key, {
							def,
							status: "idle",
							question: "",
							elapsed: 0,
							lastLine: "",
							queryCount: 0,
						});
					}
				}
			}
		} catch {}
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "researching" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "researching" ? "◉"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const queriesStr = state.queryCount > 0 ? ` (${state.queryCount})` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr + queriesStr);
		const statusVisible = statusStr.length + timeStr.length + queriesStr.length;

		const workRaw = state.question || state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const lastRaw = state.lastLine || "";
		const lastText = truncate(lastRaw, Math.min(50, w - 1));
		const lastLineRendered = lastText ? theme.fg("dim", lastText) : theme.fg("dim", "—");
		const lastVisible = lastText ? lastText.length : 1;

		const colors = EXPERT_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";

		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			border(" " + lastLineRendered, 1 + lastVisible),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("pi-pi-grid", (_tui: any, theme: any) => {
			return {
				render(width: number): string[] {
					if (experts.size === 0) {
						return ["", theme.fg("dim", "  No experts found. Add agent .md files to .pi/agents/pi-pi/")];
					}

					const cols = Math.min(gridCols, experts.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;
					const allExperts = Array.from(experts.values());

					const lines: string[] = [""];

					for (let i = 0; i < allExperts.length; i += cols) {
						const rowExperts = allExperts.slice(i, i + cols);
						const cards = rowExperts.map(e => renderCard(e, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							lines.push(cards.map(card => card[line] || "").join(" ".repeat(gap)));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ── Query Expert ─────────────────────────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Expert "${expertName}" not found. Available: ${Array.from(experts.values()).map(s => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `Expert "${displayName(state.def.name)}" is already researching. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		// Use expert-specific model if defined, otherwise fall back to parent's model
		const model = state.def.model
			? state.def.model
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "openrouter/google/gemini-3-flash-preview";

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			question,
		];

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

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
								state.lastLine = last;
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

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				const full = textChunks.join("");
				state.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.status = "error";
				state.lastLine = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning expert: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── query_experts Tool (parallel) ───────────

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: `Query one or more Pi domain experts IN PARALLEL. All experts run simultaneously as concurrent subprocesses.

Pass an array of queries — each with an expert name and a specific question. All experts start at the same time and their results are returned together.

Available experts:
- ext-expert: Extensions — tools, events, commands, rendering, state management
- theme-expert: Themes — JSON format, 51 color tokens, vars, color values
- skill-expert: Skills — SKILL.md multi-file packages, scripts, references, frontmatter
- config-expert: Settings — settings.json, providers, models, packages, keybindings
- tui-expert: TUI — components, keyboard input, overlays, widgets, footers, editors
- prompt-expert: Prompt templates — single-file .md commands, arguments ($1, $@)
- agent-expert: Agent definitions — .md personas, tools, teams.yaml, orchestration
- keybinding-expert: Keyboard shortcuts — registerShortcut(), Key IDs, reserved keys
- cli-expert: CLI flags, modes, non-interactive execution, tool control

Ask specific questions about what you need to BUILD. Each expert will return documentation excerpts, code patterns, and implementation guidance.`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description: "Expert name: ext-expert, theme-expert, skill-expert, config-expert, tui-expert, prompt-expert, agent-expert, keybinding-expert, or cli-expert",
					}),
					question: Type.String({
						description: "Specific question about what you need to build. Include context about the target component.",
					}),
				}),
				{ description: "Array of expert queries to run in parallel" },
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { queries } = params as { queries: { expert: string; question: string }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "No queries provided." }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map(q => displayName(q.expert)).join(", ");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Querying ${queries.length} experts in parallel: ${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question }) => {
					const result = await queryExpert(expert, question, ctx);
					const truncated = result.output.length > 12000
						? result.output.slice(0, 12000) + "\n\n... [truncated — ask follow-up for more]"
						: result.output;
					const status = result.exitCode === 0 ? "done" : "error";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: truncated,
						fullOutput: result.output,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
						expert: queries[i].expert,
						question: queries[i].question,
						status: "error" as const,
						elapsed: 0,
						exitCode: 1,
						output: `Error: ${(s.reason as any)?.message || s.reason}`,
						fullOutput: "",
					},
			);

			const sections = results.map(r => {
				const icon = r.status === "done" ? "✓" : "✗";
				return `## [${icon}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: results.every(r => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args, theme) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("query_experts ")) +
				theme.fg("accent", `${queries.length} parallel`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length || "?";
				return new Text(
					theme.fg("accent", `◉ ${count} experts`) +
					theme.fg("dim", " researching in parallel..."),
					0, 0,
				);
			}

			const lines = (details.results as any[]).map((r: any) => {
				const icon = r.status === "done" ? "✓" : "✗";
				const color = r.status === "done" ? "success" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) +
					theme.fg("dim", ` ${elapsed}s`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? (r.fullOutput.length > 4000 ? r.fullOutput.slice(0, 4000) + "\n... [truncated]" : r.fullOutput)
						: r.output || "";
					return theme.fg("accent", `── ${displayName(r.expert)} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and their status",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map(s => `${displayName(s.def.name)} (${s.status}, queries: ${s.queryCount}): ${s.def.description}`)
				.join("\n");
			_ctx.ui.notify(lines || "No experts loaded", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "Set expert grid columns: /experts-grid <1-5>",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 5) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /experts-grid <1-5>", "error");
			}
		},
	});

	pi.registerCommand("analyze", {
		description: "Re-run project analysis: /analyze [path]",
		handler: async (_args, ctx) => {
			const targetPath = _args?.trim() || ctx.cwd;
			const resolvedPath = resolve(targetPath.replace(/^~/, process.env.HOME || "~"));
			if (!existsSync(resolvedPath)) {
				ctx.ui.notify(`Directory not found: ${resolvedPath}`, "error");
				return;
			}
			const analysis = analyzeProject(resolvedPath);
			lastAnalysis = analysis;
			const lines = [
				`📦 ${analysis.name}`,
				``,
				analysis.summary,
				``,
				`Key files: ${analysis.keyFiles.join(", ")}`,
				`Triggers: ${analysis.triggers.slice(0, 20).join(", ")}${analysis.triggers.length > 20 ? "..." : ""}`,
				analysis.hasExistingPi ? `Existing .pi/ files: ${analysis.existingPiFiles.join(", ")}` : "No existing .pi/ configuration",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── System Prompt ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map(s => `### ${displayName(s.def.name)}\n**Query as:** \`${s.def.name}\`\n${s.def.description}`)
			.join("\n\n");

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");

		// Load library catalog for the system prompt
		const library = loadLibrary();
		const libraryCatalog = library && lastAnalysis
			? getLibraryRecommendations(lastAnalysis, library)
			: "Library not available — create extensions from scratch based on expert research.";

		const orchestratorPath = join(_ctx.cwd, ".pi", "agents", "pi-pi", "pi-orchestrator.md");
		let systemPrompt = "";
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			const template = match ? match[2].trim() : raw;

			systemPrompt = template
				.replace("{{EXPERT_COUNT}}", experts.size.toString())
				.replace("{{EXPERT_NAMES}}", expertNames)
				.replace("{{EXPERT_CATALOG}}", expertCatalog)
				.replace("{{LIBRARY_CATALOG}}", libraryCatalog);
		} catch (err) {
			systemPrompt = "Error: Could not load pi-orchestrator.md. Make sure it exists in .pi/agents/pi-pi/.";
		}

		return { systemPrompt };
	});

	// ── Marketplace Packages ─────────────────────

	interface MarketplacePackage {
		name: string;
		description: string;
		keywords: string[];
	}

	async function fetchMarketplacePackages(): Promise<MarketplacePackage[]> {
		try {
			const res = await fetch("https://registry.npmjs.org/-/v1/search?text=keywords:pi-coding-agent&size=50");
			if (!res.ok) return [];
			const data = await res.json();
			return (data.objects || []).map((obj: any) => ({
				name: obj.package.name,
				description: (obj.package.description || "").slice(0, 120),
				keywords: obj.package.keywords || [],
			}));
		} catch {
			return [];
		}
	}

	// ── Build Auto-Start Prompt ──────────────────

	function buildAutoStartPrompt(targetDir: string, analysis: ProjectAnalysis, library: Library | null, marketplacePackages: MarketplacePackage[]): string {
		const lines: string[] = [];

		lines.push("# Auto-Setup: Configure Pi for this repository");
		lines.push("");
		lines.push(`**Target directory:** \`${targetDir}\``);
		lines.push("");
		lines.push("## Project Analysis");
		lines.push("");
		lines.push(`**Project:** ${analysis.name}`);
		lines.push(`**Languages:** ${analysis.languages.join(", ") || "unknown"}`);
		lines.push(`**Stack:** ${analysis.stack.join(", ") || "minimal"}`);
		lines.push(`**Build tools:** ${analysis.buildTools.join(", ") || "none detected"}`);
		lines.push("");

		if (analysis.hasMonorepo) lines.push("⚡ **Monorepo** with sub-projects: " + analysis.subprojects.join(", "));
		if (analysis.hasFrontend) lines.push("🖥️ **Frontend** detected");
		if (analysis.hasBackend) lines.push("⚙️ **Backend** detected");
		if (analysis.hasInfra) lines.push("☁️ **Infrastructure-as-code** detected");
		if (analysis.hasDocker) lines.push("🐳 **Docker** detected");
		if (analysis.hasCI) lines.push("🔄 **CI/CD** detected");
		lines.push("");

		lines.push("### Key Files to Read");
		lines.push("Read these to understand the project before building:");
		for (const f of analysis.keyFiles.slice(0, 15)) {
			lines.push(`- \`${f}\``);
		}
		lines.push("");

		if (analysis.hasExistingPi) {
			lines.push("### Existing .pi/ Configuration");
			lines.push("This project already has some Pi config. Review and extend it:");
			for (const f of analysis.existingPiFiles) {
				lines.push(`- \`.pi/${f}\``);
			}
			lines.push("");
		}

		lines.push("### Matched Triggers");
		lines.push("These were detected in the project and can guide extension/skill selection:");
		lines.push(analysis.triggers.slice(0, 30).join(", "));
		lines.push("");

		// Marketplace packages
		if (marketplacePackages.length > 0) {
			lines.push("## Pi Marketplace Packages (npm)");
			lines.push("These are community-built packages installable via `pi install <name>`. Consider recommending relevant ones:");
			lines.push("");
			for (const pkg of marketplacePackages) {
				lines.push(`- **${pkg.name}**: ${pkg.description}`);
			}
			lines.push("");
			lines.push("To install a marketplace package in the target project, run: `cd <target> && pi install <package-name>`");
			lines.push("");
		}

		lines.push("## Your Mission");
		lines.push("");
		lines.push("1. **Read the key files** listed above to understand the project's domain, conventions, and workflows");
		lines.push("2. **Query experts** for the Pi APIs you need — especially ext-expert for extension patterns");
		lines.push("3. **Copy relevant library extensions** to the target's `.pi/extensions/` (use `bash` to `cp` from the library paths below)");
		lines.push("4. **Create custom extensions** — THIS IS THE MOST IMPORTANT STEP. Build project-specific tools, hooks, and commands that would genuinely help a developer working on this codebase. Examples:");
		lines.push("   - Tools that wrap project-specific commands with structured output (test runners, linters, deploy scripts)");
		lines.push("   - `before_agent_start` hooks that inject project context, coding conventions, and architecture into the system prompt");
		lines.push("   - Event hooks that enforce project conventions (e.g., auto-lint, auto-format, branch naming)");
		lines.push("   - Custom commands (`/deploy`, `/db-reset`, `/test-e2e`) for common developer workflows");
		lines.push("   - Keyboard shortcuts for frequent operations");
		lines.push("5. **Recommend marketplace packages** — if any community packages from the marketplace list would benefit this project, list them with install commands");
		lines.push("6. **Create agent definitions** tailored to this project's architecture");
		lines.push("7. **Write a justfile** in the target project with recipes for launching Pi with different extension combos");
		lines.push("8. **Write/update CLAUDE.md** in the target project with project context and Pi usage instructions");
		lines.push("");
		lines.push("Think about what tools, commands, and workflows would make a developer 10x more productive on THIS specific project. Don't just copy generic stuff — create value.");
		lines.push("");
		lines.push("**⚠️ FILE LAYOUT IS CRITICAL:**");
		lines.push("- Shared utility modules (like `themeMap.ts`) go in `.pi/extensions/lib/` — NOT root. Pi auto-loads all `.ts` in root as extensions.");
		lines.push("- Orchestrators (`agent-chain.ts`, `agent-team.ts`) go in `.pi/extensions/lib/` — load them explicitly via `-e` in justfile. They conflict when auto-loaded together.");
		lines.push("- Extensions in root import from `./lib/themeMap.ts`. Extensions in `lib/` import from `./themeMap.ts`.");
		lines.push("- If any extension needs npm packages (e.g. `yaml`), create `.pi/package.json` and run `cd <target>/.pi && bun install`.");
		lines.push("");

		// Tell the orchestrator where the library lives so it can copy files
		const libDir = dirname(new URL(import.meta.url).pathname);
		const libRoot = resolve(libDir, "..");
		lines.push(`## Library Location`);
		lines.push(`The pre-built extension library is at: \`${libRoot}\``);
		lines.push(`Copy extensions from \`${resolve(libDir)}/\` to \`${targetDir}/.pi/extensions/\``);
		lines.push(`Copy themes from \`${join(libRoot, ".pi", "themes")}/\` to \`${targetDir}/.pi/themes/\``);
		lines.push(`Copy skills from \`${join(libRoot, ".pi", "skills")}/\` to \`${targetDir}/.pi/skills/\``);
		lines.push(`Copy agent templates from \`${join(libRoot, ".pi", "agents")}/\` to \`${targetDir}/.pi/agents/\``);
		lines.push(`Copy \`${resolve(libDir)}/themeMap.ts\` to \`${targetDir}/.pi/extensions/lib/themeMap.ts\` — it's a shared dep, must be in lib/`);
		lines.push(`Copy \`${resolve(libDir)}/agent-chain.ts\` to \`${targetDir}/.pi/extensions/lib/agent-chain.ts\` — explicit load only`);
		lines.push(`Copy \`${resolve(libDir)}/agent-team.ts\` to \`${targetDir}/.pi/extensions/lib/agent-team.ts\` — explicit load only`);
		lines.push(`All other extensions go to \`${targetDir}/.pi/extensions/\` (auto-loaded)`);
		lines.push(`After copying, fix import paths: root extensions use \`./lib/themeMap.ts\`, lib extensions use \`./themeMap.ts\``);
		lines.push("");
		lines.push("**Start now. Read the project files, then query your experts, then build everything.**");

		return lines.join("\n");
	}

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		if (widgetCtx) {
			widgetCtx.ui.setWidget("pi-pi-grid", undefined);
		}
		widgetCtx = _ctx;

		loadExperts(_ctx.cwd);
		updateWidget();

		// Ask for the target project path
		const targetPath = await _ctx.ui.input(
			"Target project path",
			"Enter the absolute path to the project you want to configure Pi for",
		);

		if (!targetPath || !targetPath.trim()) {
			_ctx.ui.notify("No project path provided. Use /analyze <path> to start manually.", "warning");
			return;
		}

		const resolvedPath = resolve(targetPath.trim().replace(/^~/, process.env.HOME || "~"));

		if (!existsSync(resolvedPath)) {
			_ctx.ui.notify(`Directory not found: ${resolvedPath}`, "error");
			return;
		}

		// Auto-analyze the target repo
		const analysis = analyzeProject(resolvedPath);
		lastAnalysis = analysis;
		const library = loadLibrary();

		// Fetch marketplace packages
		const marketplacePackages = await fetchMarketplacePackages();

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui.setStatus("pi-pi", `Pi Pi (${experts.size} experts)`);

		// Build and inject auto-start prompt
		const autoPrompt = buildAutoStartPrompt(resolvedPath, analysis, library, marketplacePackages);

		_ctx.ui.notify(
			`🚀 Pi Pi — Auto-configuring Pi for "${analysis.name}"\n\n` +
			`   Target: ${resolvedPath}\n` +
			`   ${analysis.summary.split("\n").join("\n   ")}\n\n` +
			`   ${experts.size} experts: ${expertNames}\n` +
			`   ${marketplacePackages.length} marketplace packages available\n` +
			`   Starting automatic setup...`,
			"info",
		);

		// Inject the analysis as the first user message so the orchestrator starts immediately
		pi.sendUserMessage(autoPrompt);

		// Custom footer
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter(e => e.status === "researching").length;
				const done = Array.from(experts.values()).filter(e => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", "Pi Pi");
				const mid = active > 0
					? theme.fg("accent", ` ◉ ${active} researching`)
					: done > 0
					? theme.fg("success", ` ✓ ${done} done`)
					: "";
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
