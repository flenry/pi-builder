/**
 * Pi Setup — Intelligent project configurator
 *
 * Scans a target project, matches against the pi-library.json registry,
 * and provisions the right extensions, skills, MCPs, themes, and agents.
 *
 * Features:
 * - Deep project analysis: package.json, README, file tree, infra configs
 * - Smart matching against library triggers and tags
 * - Preset selection or manual cherry-pick
 * - Copies extensions (not symlinks) for portability
 * - Generates justfile with recipes for each extension combo
 * - Idempotent — safe to re-run, only adds/updates
 *
 * Commands:
 *   /setup           — run the full setup flow
 *   /setup-status    — show what's installed in current project
 *   /setup-add       — add individual extensions/skills/mcps
 *   /setup-remove    — remove installed items
 *
 * Usage: pi -e extensions/pi-setup.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname, basename, relative } from "node:path";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────────────────────────────

interface LibraryExtension {
	path: string;
	description: string;
	tags: string[];
	triggers: string[];
	stackable: boolean;
	depends?: string[];
	requires?: {
		piFiles?: string[];
		npmDeps?: string[];
		agentDefs?: boolean;
	};
}

interface LibrarySkill {
	path: string;
	description: string;
	tags: string[];
	triggers: string[];
	setup?: string;
}

interface LibraryMCP {
	description: string;
	tags: string[];
	triggers: string[];
	config: {
		command: string;
		args: string[];
		env?: Record<string, string>;
	};
}

interface LibraryAgentTemplate {
	path: string;
	description: string;
	tags: string[];
}

interface LibraryPreset {
	description: string;
	extensions: string[];
	justfileRecipes: Record<string, string>;
}

interface Library {
	extensions: Record<string, LibraryExtension>;
	skills: Record<string, LibrarySkill>;
	mcps: Record<string, LibraryMCP>;
	agentTemplates: Record<string, LibraryAgentTemplate>;
	themes: { path: string; available: string[] };
	presets: Record<string, LibraryPreset>;
}

interface SetupReceipt {
	libraryPath: string;
	installedAt: string;
	updatedAt: string;
	extensions: string[];
	skills: string[];
	mcps: string[];
	agentTemplates: string[];
	themes: string[];
	preset?: string;
}

interface ProjectAnalysis {
	name: string;
	stack: string[];
	triggers: string[];
	hasMonorepo: boolean;
	hasFrontend: boolean;
	hasBackend: boolean;
	hasInfra: boolean;
	hasDocker: boolean;
	hasCI: boolean;
	subprojects: string[];
	summary: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getLibraryDir(): string {
	// Library is in the same repo as this extension
	return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function loadLibrary(): Library {
	const libPath = join(getLibraryDir(), "pi-library.json");
	if (!existsSync(libPath)) {
		throw new Error(`Library not found at ${libPath}`);
	}
	return JSON.parse(readFileSync(libPath, "utf-8"));
}

function loadReceipt(projectDir: string): SetupReceipt | null {
	const receiptPath = join(projectDir, ".pi", "pi-setup.json");
	if (!existsSync(receiptPath)) return null;
	try {
		return JSON.parse(readFileSync(receiptPath, "utf-8"));
	} catch {
		return null;
	}
}

function saveReceipt(projectDir: string, receipt: SetupReceipt): void {
	const piDir = join(projectDir, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(join(piDir, "pi-setup.json"), JSON.stringify(receipt, null, 2) + "\n");
}

function copyDirRecursive(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src)) {
		const srcPath = join(src, entry);
		const destPath = join(dest, entry);
		const stat = statSync(srcPath);
		if (stat.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

// ── Project Analysis ─────────────────────────────────────────────────────

function analyzeProject(projectDir: string): ProjectAnalysis {
	const triggers: string[] = [];
	const stack: string[] = [];
	const subprojects: string[] = [];

	// Scan for package.json files (up to 2 levels deep)
	const scanDirs = [projectDir];
	try {
		for (const entry of readdirSync(projectDir)) {
			if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
			const sub = join(projectDir, entry);
			try {
				if (statSync(sub).isDirectory()) scanDirs.push(sub);
			} catch {}
		}
	} catch {}

	for (const dir of scanDirs) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (dir !== projectDir) subprojects.push(basename(dir));

				// Extract all dependency names as triggers
				const allDeps = {
					...(pkg.dependencies || {}),
					...(pkg.devDependencies || {}),
					...(pkg.peerDependencies || {}),
				};

				for (const dep of Object.keys(allDeps)) {
					triggers.push(dep);
					// Also push scoped package prefix
					if (dep.startsWith("@")) {
						triggers.push(dep.split("/")[0]);
					}
				}

				// Detect stack from deps
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
				if (allDeps["@aws-sdk/client-s3"] || dep_matches(allDeps, "@aws-sdk/")) stack.push("AWS SDK");
				if (allDeps["@aws-amplify/cli"] || allDeps["aws-amplify"]) stack.push("Amplify");
				if (allDeps["prisma"] || allDeps["@prisma/client"]) stack.push("Prisma");
				if (allDeps["drizzle-orm"]) stack.push("Drizzle");
				if (allDeps["pg"] || allDeps["postgres"]) stack.push("PostgreSQL");
				if (allDeps["mongoose"] || allDeps["mongodb"]) stack.push("MongoDB");
				if (allDeps["playwright"] || allDeps["@playwright/test"]) stack.push("Playwright");
				if (allDeps["cypress"]) stack.push("Cypress");
				if (allDeps["docker-compose"] || allDeps["dockerode"]) stack.push("Docker");
				if (allDeps["typescript"] || allDeps["ts-node"]) stack.push("TypeScript");

				// Scripts as triggers
				if (pkg.scripts) {
					for (const [name, cmd] of Object.entries(pkg.scripts)) {
						if (typeof cmd === "string") {
							if (cmd.includes("cdk")) triggers.push("cdk");
							if (cmd.includes("amplify")) triggers.push("amplify");
							if (cmd.includes("docker")) triggers.push("docker");
							if (cmd.includes("playwright")) triggers.push("playwright");
						}
					}
				}
			} catch {}
		}

		// Python projects
		const reqPath = join(dir, "requirements.txt");
		if (existsSync(reqPath)) {
			try {
				const reqs = readFileSync(reqPath, "utf-8");
				if (reqs.includes("boto3")) { triggers.push("boto3"); stack.push("boto3"); }
				if (reqs.includes("django")) { triggers.push("django"); stack.push("Django"); }
				if (reqs.includes("flask")) { triggers.push("flask"); stack.push("Flask"); }
				if (reqs.includes("fastapi")) { triggers.push("fastapi"); stack.push("FastAPI"); }
				stack.push("Python");
			} catch {}
		}
	}

	// File/directory-based detection
	const checks: [string, string, string][] = [
		["Dockerfile", "docker", "Docker"],
		["docker-compose.yml", "docker", "Docker Compose"],
		["docker-compose.yaml", "docker", "Docker Compose"],
		[".github", ".github", "GitHub Actions"],
		[".gitlab-ci.yml", "gitlab-ci", "GitLab CI"],
		["cdk.json", "cdk", "AWS CDK"],
		["serverless.yml", "serverless", "Serverless Framework"],
		["serverless.yaml", "serverless", "Serverless Framework"],
		["sam.yaml", "sam", "AWS SAM"],
		["template.yaml", "sam", "AWS SAM"],
		["terraform", "terraform", "Terraform"],
		[".terraform", "terraform", "Terraform"],
		["k8s", "kubernetes", "Kubernetes"],
		["kubernetes", "kubernetes", "Kubernetes"],
		["helm", "helm", "Helm"],
		[".env", "env-files", "Env Files"],
		[".env.local", "env-files", "Env Files"],
		[".claude", ".claude", "Claude Code"],
		[".gemini", ".gemini", "Gemini"],
		[".codex", ".codex", "Codex"],
		["amplify", "amplify", "Amplify"],
	];

	for (const [file, trigger, label] of checks) {
		if (existsSync(join(projectDir, file))) {
			triggers.push(trigger);
			if (!stack.includes(label)) stack.push(label);
		}
	}

	// Keyword scan README (read-only)
	for (const readmeFile of ["README.md", "readme.md", "README.rst"]) {
		const readmePath = join(projectDir, readmeFile);
		if (existsSync(readmePath)) {
			try {
				const readme = readFileSync(readmePath, "utf-8").toLowerCase();
				const keywords = ["aws", "lambda", "s3", "dynamodb", "cognito", "api gateway",
					"cloudfront", "ecs", "eks", "fargate", "rds", "aurora",
					"microservice", "monorepo", "docker", "kubernetes", "terraform",
					"serverless", "graphql", "rest api", "websocket", "redis",
					"elasticsearch", "kafka", "rabbitmq", "ci/cd", "pipeline"];
				for (const kw of keywords) {
					if (readme.includes(kw)) triggers.push(kw);
				}
			} catch {}
		}
	}

	// Keyword scan CLAUDE.md if present
	const claudeMd = join(projectDir, "CLAUDE.md");
	if (existsSync(claudeMd)) {
		try {
			const content = readFileSync(claudeMd, "utf-8").toLowerCase();
			const keywords = ["aws", "docker", "kubernetes", "terraform", "monorepo", "microservice"];
			for (const kw of keywords) {
				if (content.includes(kw)) triggers.push(kw);
			}
		} catch {}
	}

	// Deduplicate
	const uniqueTriggers = [...new Set(triggers.map(t => t.toLowerCase()))];
	const uniqueStack = [...new Set(stack)];

	const hasFrontend = uniqueStack.some(s => ["React", "Vue", "Angular", "Next.js", "Nuxt", "Svelte"].includes(s));
	const hasBackend = uniqueStack.some(s => ["Express", "Fastify", "NestJS", "Django", "Flask", "FastAPI"].includes(s));
	const hasInfra = uniqueStack.some(s => ["AWS CDK", "Terraform", "Serverless Framework", "AWS SAM", "Kubernetes"].includes(s));
	const hasDocker = uniqueTriggers.includes("docker");
	const hasCI = uniqueTriggers.includes(".github") || uniqueTriggers.includes("gitlab-ci");
	const hasMonorepo = subprojects.length > 1;

	// Build summary
	const parts: string[] = [];
	if (uniqueStack.length > 0) parts.push(`Stack: ${uniqueStack.join(", ")}`);
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
		hasMonorepo,
		hasFrontend,
		hasBackend,
		hasInfra,
		hasDocker,
		hasCI,
		subprojects,
		summary: parts.join("\n   "),
	};
}

function dep_matches(deps: Record<string, string>, prefix: string): boolean {
	return Object.keys(deps).some(d => d.startsWith(prefix));
}

// ── Matching ──────────────────────────────────────────────────────────────

function scoreItem(triggers: string[], itemTriggers: string[]): number {
	if (itemTriggers.includes("*")) return 1; // universal, low priority
	let score = 0;
	for (const t of itemTriggers) {
		if (triggers.some(pt => pt.includes(t.toLowerCase()) || t.toLowerCase().includes(pt))) {
			score += 2;
		}
	}
	return score;
}

function getRecommendations(analysis: ProjectAnalysis, library: Library) {
	const extScores: [string, LibraryExtension, number][] = [];
	for (const [name, ext] of Object.entries(library.extensions)) {
		const score = scoreItem(analysis.triggers, ext.triggers);
		extScores.push([name, ext, score]);
	}
	extScores.sort((a, b) => b[2] - a[2]);

	const skillScores: [string, LibrarySkill, number][] = [];
	for (const [name, skill] of Object.entries(library.skills)) {
		const score = scoreItem(analysis.triggers, skill.triggers);
		skillScores.push([name, skill, score]);
	}
	skillScores.sort((a, b) => b[2] - a[2]);

	const mcpScores: [string, LibraryMCP, number][] = [];
	for (const [name, mcp] of Object.entries(library.mcps)) {
		const score = scoreItem(analysis.triggers, mcp.triggers);
		mcpScores.push([name, mcp, score]);
	}
	mcpScores.sort((a, b) => b[2] - a[2]);

	return {
		extensions: extScores,
		skills: skillScores,
		mcps: mcpScores,
	};
}

// ── Provisioning ─────────────────────────────────────────────────────────

function provisionExtension(name: string, ext: LibraryExtension, libDir: string, projectDir: string): string[] {
	const extDir = join(projectDir, ".pi", "ext");
	ensureDir(extDir);
	const messages: string[] = [];

	// Copy main extension file
	const srcPath = join(libDir, ext.path);
	const destPath = join(extDir, basename(ext.path));
	if (existsSync(srcPath)) {
		copyFileSync(srcPath, destPath);
		messages.push(`  ✓ Copied ${basename(ext.path)}`);
	}

	// Copy dependencies
	if (ext.depends) {
		for (const dep of ext.depends) {
			const depSrc = join(libDir, dep);
			const depDest = join(extDir, basename(dep));
			if (existsSync(depSrc) && !existsSync(depDest)) {
				copyFileSync(depSrc, depDest);
				messages.push(`  ✓ Copied dependency ${basename(dep)}`);
			}
		}
	}

	// Copy required .pi files
	if (ext.requires?.piFiles) {
		for (const piFile of ext.requires.piFiles) {
			const src = join(libDir, piFile);
			const dest = join(projectDir, piFile);
			if (!existsSync(src)) continue;
			if (statSync(src).isDirectory()) {
				copyDirRecursive(src, dest);
				messages.push(`  ✓ Copied ${piFile}/`);
			} else {
				ensureDir(dirname(dest));
				copyFileSync(src, dest);
				messages.push(`  ✓ Copied ${piFile}`);
			}
		}
	}

	return messages;
}

function provisionSkill(name: string, skill: LibrarySkill, libDir: string, projectDir: string): string[] {
	const messages: string[] = [];
	const src = join(libDir, skill.path);
	const dest = join(projectDir, skill.path);
	if (existsSync(src)) {
		ensureDir(dirname(dest));
		copyFileSync(src, dest);
		messages.push(`  ✓ Copied skill ${name}`);
	}
	if (skill.setup) {
		messages.push(`  ⚠ Run: ${skill.setup}`);
	}
	return messages;
}

function provisionThemes(libDir: string, projectDir: string): string[] {
	const src = join(libDir, ".pi", "themes");
	const dest = join(projectDir, ".pi", "themes");
	if (existsSync(src)) {
		copyDirRecursive(src, dest);
		return ["  ✓ Copied all themes"];
	}
	return [];
}

function provisionAgentTemplate(name: string, template: LibraryAgentTemplate, libDir: string, projectDir: string): string[] {
	const messages: string[] = [];
	const src = join(libDir, template.path);
	const dest = join(projectDir, ".pi", "agents", basename(template.path));
	if (existsSync(src)) {
		ensureDir(dirname(dest));
		if (statSync(src).isDirectory()) {
			copyDirRecursive(src, dest);
		} else {
			copyFileSync(src, dest);
		}
		messages.push(`  ✓ Copied agent template ${name}`);
	}
	return messages;
}

function generateJustfile(projectDir: string, selectedExtensions: string[], library: Library, existingJustfile: string | null): string {
	const lines: string[] = [];

	// If there's an existing justfile, preserve it and append our recipes
	if (existingJustfile) {
		// Check if it already has pi recipes
		if (existingJustfile.includes("# ── Pi Recipes")) {
			// Strip old pi recipes section
			const idx = existingJustfile.indexOf("# ── Pi Recipes");
			const before = existingJustfile.slice(0, idx).trimEnd();
			lines.push(before);
			lines.push("");
			lines.push("");
		} else {
			lines.push(existingJustfile.trimEnd());
			lines.push("");
			lines.push("");
		}
	} else {
		lines.push("set dotenv-load := true");
		lines.push("");
		lines.push("default:");
		lines.push("    @just --list");
		lines.push("");
	}

	lines.push("# ── Pi Recipes (auto-generated by pi-setup) ──────────────────────────");
	lines.push("");

	// Basic pi
	lines.push("# Launch pi with no extensions");
	lines.push("pi:");
	lines.push("    pi");
	lines.push("");

	// Generate recipes for installed extensions
	const extDir = ".pi/ext";

	// Standard combo: tool-counter + theme-cycler
	if (selectedExtensions.includes("tool-counter") && selectedExtensions.includes("theme-cycler")) {
		lines.push("# Pi with metrics footer and theme cycling");
		lines.push("pi-metrics:");
		lines.push(`    pi -e ${extDir}/tool-counter.ts -e ${extDir}/theme-cycler.ts`);
		lines.push("");
	}

	// Damage control combo
	if (selectedExtensions.includes("damage-control")) {
		const footer = selectedExtensions.includes("minimal") ? `${extDir}/minimal.ts` : selectedExtensions.includes("tool-counter") ? `${extDir}/tool-counter.ts` : null;
		const parts = [`${extDir}/damage-control.ts`];
		if (footer) parts.push(footer);
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with safety rails");
		lines.push("pi-safe:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Purpose gate
	if (selectedExtensions.includes("purpose-gate")) {
		const parts = [`${extDir}/purpose-gate.ts`, `${extDir}/minimal.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with intent declaration");
		lines.push("pi-focus:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Tilldone
	if (selectedExtensions.includes("tilldone")) {
		const parts = [`${extDir}/tilldone.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with task tracking");
		lines.push("pi-tasks:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Agent team
	if (selectedExtensions.includes("agent-team")) {
		const parts = [`${extDir}/agent-team.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with multi-agent team orchestration");
		lines.push("pi-team:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Agent chain
	if (selectedExtensions.includes("agent-chain")) {
		const parts = [`${extDir}/agent-chain.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with sequential agent pipeline");
		lines.push("pi-chain:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// System select
	if (selectedExtensions.includes("system-select")) {
		const parts = [`${extDir}/system-select.ts`, `${extDir}/minimal.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with system prompt switcher");
		lines.push("pi-system:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Session replay
	if (selectedExtensions.includes("session-replay")) {
		const parts = [`${extDir}/session-replay.ts`, `${extDir}/minimal.ts`];
		lines.push("# Pi with session history replay");
		lines.push("pi-replay:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Cross-agent
	if (selectedExtensions.includes("cross-agent")) {
		const parts = [`${extDir}/cross-agent.ts`, `${extDir}/minimal.ts`];
		lines.push("# Pi with cross-tool command loading");
		lines.push("pi-cross:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	// Subagent widget
	if (selectedExtensions.includes("subagent-widget")) {
		const parts = [`${extDir}/subagent-widget.ts`, `${extDir}/pure-focus.ts`];
		if (selectedExtensions.includes("theme-cycler")) parts.push(`${extDir}/theme-cycler.ts`);
		lines.push("# Pi with sub-agent spawning widget");
		lines.push("pi-sub:");
		lines.push(`    pi ${parts.map(p => `-e ${p}`).join(" ")}`);
		lines.push("");
	}

	return lines.join("\n");
}

function generatePackageJson(projectDir: string, selectedExtensions: string[], library: Library): boolean {
	// Check if any selected extension needs npm deps
	const neededDeps: Record<string, string> = {};
	for (const extName of selectedExtensions) {
		const ext = library.extensions[extName];
		if (ext?.requires?.npmDeps) {
			for (const dep of ext.requires.npmDeps) {
				if (dep === "yaml") neededDeps["yaml"] = "^2.8.0";
			}
		}
	}

	if (Object.keys(neededDeps).length === 0) return false;

	const pkgPath = join(projectDir, ".pi", "package.json");
	let pkg: any = {};
	if (existsSync(pkgPath)) {
		try { pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); } catch {}
	}

	pkg.name = pkg.name || "pi-extensions";
	pkg.private = true;
	pkg.type = "module";
	pkg.dependencies = { ...(pkg.dependencies || {}), ...neededDeps };

	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
	return true;
}

function generateSetupInstructions(projectDir: string, needsBunInstall: boolean, setupCommands: string[]): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push("📋 Setup Instructions:");
	lines.push("─────────────────────");

	if (needsBunInstall) {
		lines.push(`  1. cd ${projectDir}/.pi && bun install`);
	}

	let step = needsBunInstall ? 2 : 1;
	for (const cmd of setupCommands) {
		lines.push(`  ${step}. ${cmd}`);
		step++;
	}

	lines.push(`  ${step}. Run \`just --list\` to see available pi recipes`);
	lines.push(`  ${step + 1}. Run \`just pi-metrics\` (or any recipe) to start`);
	lines.push("");

	return lines;
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.notify("Pi Setup loaded — use /setup to configure a project, or ask me to set up a project", "info");
	});

	// ── /setup command ───────────────────────────────────────────────────

	pi.registerCommand("setup", {
		description: "Run the full Pi project setup flow",
		handler: async (args, ctx) => {
			try {
				await runSetup(args, ctx);
			} catch (err: any) {
				ctx.ui.notify(`Setup error: ${err.message}`, "error");
			}
		},
	});

	// ── /setup-status command ────────────────────────────────────────────

	pi.registerCommand("setup-status", {
		description: "Show what's installed in the current project",
		handler: async (_args, ctx) => {
			const receipt = loadReceipt(ctx.cwd);
			if (!receipt) {
				ctx.ui.notify("No Pi setup found in this project. Run /setup first.", "warning");
				return;
			}

			const lines = [
				`Pi Setup Status for ${basename(ctx.cwd)}`,
				`─────────────────────────────────`,
				`Library: ${receipt.libraryPath}`,
				`Installed: ${receipt.installedAt}`,
				`Updated: ${receipt.updatedAt}`,
				``,
				`Extensions: ${receipt.extensions.join(", ") || "none"}`,
				`Skills: ${receipt.skills.join(", ") || "none"}`,
				`MCPs: ${receipt.mcps.join(", ") || "none"}`,
				`Agent Templates: ${receipt.agentTemplates.join(", ") || "none"}`,
				`Themes: ${receipt.themes.length > 0 ? `${receipt.themes.length} installed` : "none"}`,
				receipt.preset ? `Preset: ${receipt.preset}` : "",
			].filter(Boolean);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Setup tool (callable by LLM) ────────────────────────────────────

	pi.registerTool({
		name: "pi_setup",
		label: "Pi Setup",
		description: "Analyze a project directory and set up Pi extensions, skills, MCPs, and agents. Use this when the user asks to set up or configure Pi for a project.",
		parameters: Type.Object({
			projectDir: Type.String({ description: "Absolute path to the target project directory" }),
			mode: Type.Optional(Type.Union([
				Type.Literal("analyze"),
				Type.Literal("recommend"),
				Type.Literal("apply"),
			], { description: "Mode: analyze (scan only), recommend (scan + suggestions), apply (full setup with prompts). Default: recommend" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const projectDir = resolve(params.projectDir);
			const mode = params.mode || "recommend";

			if (!existsSync(projectDir)) {
				return {
					content: [{ type: "text", text: `Error: Directory not found: ${projectDir}` }],
					details: {},
				};
			}

			const library = loadLibrary();
			const analysis = analyzeProject(projectDir);
			const recs = getRecommendations(analysis, library);

			if (mode === "analyze") {
				return {
					content: [{ type: "text", text: JSON.stringify({ analysis }, null, 2) }],
					details: { analysis },
				};
			}

			const recText: string[] = [
				`🔍 Project Analysis: ${analysis.name}`,
				`   ${analysis.summary}`,
				``,
				`📦 Recommended Extensions:`,
			];

			for (const [name, ext, score] of recs.extensions) {
				if (score > 0 || ext.triggers.includes("*")) {
					const marker = score > 1 ? "●" : score === 1 ? "○" : "·";
					recText.push(`   ${marker} ${name} (score: ${score}) — ${ext.description}`);
				}
			}

			if (recs.skills.some(([, , s]) => s > 0)) {
				recText.push(``, `🎯 Recommended Skills:`);
				for (const [name, skill, score] of recs.skills) {
					if (score > 0) recText.push(`   ● ${name} (score: ${score}) — ${skill.description}`);
				}
			}

			if (recs.mcps.some(([, , s]) => s > 0)) {
				recText.push(``, `🔌 Recommended MCPs:`);
				for (const [name, mcp, score] of recs.mcps) {
					if (score > 0) recText.push(`   ● ${name} (score: ${score}) — ${mcp.description}`);
				}
			}

			recText.push(``, `Available Presets: ${Object.entries(library.presets).map(([k, v]) => `${k} (${v.description})`).join(", ")}`);
			recText.push(``, `Use /setup to run the interactive setup flow, or ask me to apply specific recommendations.`);

			return {
				content: [{ type: "text", text: recText.join("\n") }],
				details: { analysis, recommendations: { extensions: recs.extensions.map(([n,,s]) => ({name: n, score: s})), skills: recs.skills.map(([n,,s]) => ({name: n, score: s})), mcps: recs.mcps.map(([n,,s]) => ({name: n, score: s})) }},
			};
		},
	});

	// ── Interactive setup flow ───────────────────────────────────────────

	async function runSetup(args: string, ctx: any) {
		const libDir = getLibraryDir();
		const library = loadLibrary();

		// Ask for target directory
		let targetDir = args?.trim() || "";
		if (!targetDir) {
			targetDir = await ctx.ui.input("Target project directory", ctx.cwd) || ctx.cwd;
		}
		targetDir = resolve(targetDir.replace(/^~/, process.env.HOME || "~"));

		if (!existsSync(targetDir)) {
			ctx.ui.notify(`Directory not found: ${targetDir}`, "error");
			return;
		}

		// Analyze
		ctx.ui.notify(`🔍 Analyzing ${basename(targetDir)}...`, "info");
		const analysis = analyzeProject(targetDir);
		const recs = getRecommendations(analysis, library);

		// Show analysis
		ctx.ui.notify(`📦 ${analysis.name}\n   ${analysis.summary}`, "info");

		// Check existing receipt
		const existingReceipt = loadReceipt(targetDir);
		if (existingReceipt) {
			const update = await ctx.ui.confirm(
				"Existing Setup Found",
				`This project was set up on ${existingReceipt.installedAt} with: ${existingReceipt.extensions.join(", ")}.\n\nUpdate?`
			);
			if (!update) return;
		}

		// Choose mode: preset or custom
		const presetOptions = [
			"Custom — choose individual extensions",
			...Object.entries(library.presets).map(([name, preset]) =>
				`${name} — ${preset.description} [${preset.extensions.join(", ")}]`
			),
		];

		const presetChoice = await ctx.ui.select("Setup Mode", presetOptions);
		if (presetChoice === undefined) return;

		let selectedExtensions: string[] = [];
		let selectedSkills: string[] = [];
		let selectedMCPs: string[] = [];
		let selectedAgents: string[] = [];
		let presetName: string | undefined;

		if (presetChoice === presetOptions[0]) {
			// Custom mode — let user pick extensions
			const extOptions = Object.entries(library.extensions).map(([name, ext]) => {
				const score = recs.extensions.find(([n]) => n === name)?.[2] || 0;
				const marker = score > 1 ? "★" : score === 1 ? "●" : " ";
				return `${marker} ${name} — ${ext.description}`;
			});

			// Multi-select via repeated single select (pi TUI limitation)
			ctx.ui.notify("Select extensions one at a time. Choose 'Done' when finished.", "info");

			const allExtNames = Object.keys(library.extensions);
			while (true) {
				const remaining = allExtNames.filter(n => !selectedExtensions.includes(n));
				const options = [
					`✓ Done (selected: ${selectedExtensions.length})`,
					...remaining.map(name => {
						const ext = library.extensions[name];
						const score = recs.extensions.find(([n]) => n === name)?.[2] || 0;
						const marker = score > 1 ? "★" : score === 1 ? "●" : " ";
						return `${marker} ${name} — ${ext.description}`;
					}),
				];

				const choice = await ctx.ui.select(
					`Extensions (${selectedExtensions.length} selected)`,
					options
				);
				if (!choice || choice.startsWith("✓ Done")) break;

				const extName = choice.replace(/^[★● ] /, "").split(" — ")[0];
				selectedExtensions.push(extName);
				ctx.ui.notify(`Added: ${extName}`, "success");
			}

			// Skills
			if (Object.keys(library.skills).length > 0) {
				const skillOptions = [
					"Skip skills",
					...Object.entries(library.skills).map(([name, skill]) => {
						const score = recs.skills.find(([n]) => n === name)?.[2] || 0;
						return `${score > 0 ? "★" : " "} ${name} — ${skill.description}`;
					}),
				];
				while (true) {
					const remaining = Object.keys(library.skills).filter(n => !selectedSkills.includes(n));
					if (remaining.length === 0) break;
					const opts = [
						`✓ Done (selected: ${selectedSkills.length})`,
						...remaining.map(name => {
							const skill = library.skills[name];
							return `${name} — ${skill.description}`;
						}),
					];
					const choice = await ctx.ui.select(`Skills (${selectedSkills.length} selected)`, opts);
					if (!choice || choice.startsWith("✓ Done")) break;
					const skillName = choice.split(" — ")[0];
					selectedSkills.push(skillName);
				}
			}

			// MCPs
			const scoredMcps = recs.mcps.filter(([, , s]) => s > 0);
			if (scoredMcps.length > 0) {
				ctx.ui.notify(`Found ${scoredMcps.length} relevant MCP(s)`, "info");
				for (const [name, mcp, score] of scoredMcps) {
					const add = await ctx.ui.confirm(`Add MCP: ${name}?`, mcp.description);
					if (add) selectedMCPs.push(name);
				}
			}

		} else {
			// Preset mode
			presetName = presetChoice.split(" — ")[0];
			const preset = library.presets[presetName];
			selectedExtensions = [...preset.extensions];

			// Also check for recommended MCPs even in preset mode
			const scoredMcps = recs.mcps.filter(([, , s]) => s > 0);
			if (scoredMcps.length > 0) {
				for (const [name, mcp] of scoredMcps) {
					const add = await ctx.ui.confirm(`Add MCP: ${name}?`, mcp.description);
					if (add) selectedMCPs.push(name);
				}
			}
		}

		// Always include standard agent templates
		const agentNames = Object.keys(library.agentTemplates);
		const includeAgents = await ctx.ui.confirm("Include Agent Templates?", `Copy standard agents: ${agentNames.join(", ")}?`);
		if (includeAgents) selectedAgents = agentNames;

		// Confirm
		const summary = [
			`Extensions: ${selectedExtensions.join(", ") || "none"}`,
			`Skills: ${selectedSkills.join(", ") || "none"}`,
			`MCPs: ${selectedMCPs.join(", ") || "none"}`,
			`Agents: ${selectedAgents.join(", ") || "none"}`,
			`Themes: all (${library.themes.available.length})`,
			`Target: ${targetDir}`,
		].join("\n");

		const proceed = await ctx.ui.confirm("Apply Setup?", summary);
		if (!proceed) {
			ctx.ui.notify("Setup cancelled.", "warning");
			return;
		}

		// ── Provision ────────────────────────────────────────────────────

		const messages: string[] = ["", "🚀 Provisioning..."];

		// Extensions
		for (const extName of selectedExtensions) {
			const ext = library.extensions[extName];
			if (ext) {
				const msgs = provisionExtension(extName, ext, libDir, targetDir);
				messages.push(...msgs);
			}
		}

		// Skills
		for (const skillName of selectedSkills) {
			const skill = library.skills[skillName];
			if (skill) {
				const msgs = provisionSkill(skillName, skill, libDir, targetDir);
				messages.push(...msgs);
			}
		}

		// Agent templates
		for (const agentName of selectedAgents) {
			const template = library.agentTemplates[agentName];
			if (template) {
				const msgs = provisionAgentTemplate(agentName, template, libDir, targetDir);
				messages.push(...msgs);
			}
		}

		// Themes
		const themeMessages = provisionThemes(libDir, targetDir);
		messages.push(...themeMessages);

		// Teams.yaml if agent-team or agent-chain selected
		if (selectedExtensions.includes("agent-team") || selectedExtensions.includes("agent-chain")) {
			const teamsSrc = join(libDir, ".pi", "agents", "teams.yaml");
			if (existsSync(teamsSrc)) {
				const teamsDest = join(targetDir, ".pi", "agents", "teams.yaml");
				ensureDir(dirname(teamsDest));
				copyFileSync(teamsSrc, teamsDest);
				messages.push("  ✓ Copied teams.yaml");
			}
		}

		// MCPs config
		if (selectedMCPs.length > 0) {
			const mcpConfig: Record<string, any> = {};
			const envWarnings: string[] = [];

			for (const mcpName of selectedMCPs) {
				const mcp = library.mcps[mcpName];
				if (mcp) {
					mcpConfig[mcpName] = {
						command: mcp.config.command,
						args: mcp.config.args.map(a => a.replace("{projectDir}", targetDir)),
					};
					if (mcp.config.env) {
						mcpConfig[mcpName].env = {};
						for (const [key, desc] of Object.entries(mcp.config.env)) {
							mcpConfig[mcpName].env[key] = process.env[key] || `<SET_${key}>`;
							if (!process.env[key]) {
								envWarnings.push(`  ⚠ ${mcpName}: Set ${key} — ${desc}`);
							}
						}
					}
				}
			}

			const mcpPath = join(targetDir, ".pi", "mcps.json");
			writeFileSync(mcpPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2) + "\n");
			messages.push("  ✓ Generated .pi/mcps.json");
			messages.push(...envWarnings);
		}

		// Package.json for npm deps
		const needsBunInstall = generatePackageJson(targetDir, selectedExtensions, library);
		if (needsBunInstall) {
			messages.push("  ✓ Generated .pi/package.json");
		}

		// Settings.json (only create if doesn't exist)
		const settingsPath = join(targetDir, ".pi", "settings.json");
		if (!existsSync(settingsPath)) {
			writeFileSync(settingsPath, JSON.stringify({ theme: "synthwave" }, null, 2) + "\n");
			messages.push("  ✓ Created .pi/settings.json");
		}

		// Justfile
		const justfilePath = join(targetDir, "justfile");
		const existingJustfile = existsSync(justfilePath) ? readFileSync(justfilePath, "utf-8") : null;
		const justfileContent = generateJustfile(targetDir, selectedExtensions, library, existingJustfile);
		writeFileSync(justfilePath, justfileContent);
		messages.push("  ✓ Generated/updated justfile");

		// Setup commands
		const setupCommands: string[] = [];
		for (const skillName of selectedSkills) {
			const skill = library.skills[skillName];
			if (skill?.setup) setupCommands.push(skill.setup);
		}

		// Instructions
		const instructions = generateSetupInstructions(targetDir, needsBunInstall, setupCommands);
		messages.push(...instructions);

		// Save receipt
		const receipt: SetupReceipt = {
			libraryPath: libDir,
			installedAt: existingReceipt?.installedAt || new Date().toISOString().split("T")[0],
			updatedAt: new Date().toISOString().split("T")[0],
			extensions: selectedExtensions,
			skills: selectedSkills,
			mcps: selectedMCPs,
			agentTemplates: selectedAgents,
			themes: library.themes.available,
			preset: presetName,
		};
		saveReceipt(targetDir, receipt);
		messages.push("  ✓ Saved .pi/pi-setup.json (receipt)");

		ctx.ui.notify(messages.join("\n"), "success");
	}
}
