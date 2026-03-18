/**
 * Project Context Header
 *
 * Injects project-specific context into every agent's system prompt at startup.
 * Reads CLAUDE.md (or README.md as fallback), detects the stack, and prepends
 * a structured context block so agents start smart — not cold.
 *
 * Also scans available skills and lists them so every agent knows what tools
 * are loaded without having to discover them manually.
 *
 * Usage: pi -e extensions/project-context.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

function readFileSafe(path: string): string | null {
	try {
		if (existsSync(path)) return readFileSync(path, "utf-8");
	} catch {}
	return null;
}

function detectStack(cwd: string): string[] {
	const indicators: string[] = [];

	const checks: [string, string][] = [
		["package.json", "Node.js/JS"],
		["bun.lockb", "Bun"],
		["pyproject.toml", "Python"],
		["requirements.txt", "Python"],
		["Cargo.toml", "Rust"],
		["go.mod", "Go"],
		["Dockerfile", "Docker"],
		["docker-compose.yml", "Docker Compose"],
		[".github/workflows", "GitHub Actions"],
		["terraform", "Terraform"],
		["justfile", "Just task runner"],
	];

	for (const [file, label] of checks) {
		if (existsSync(join(cwd, file))) indicators.push(label);
	}

	// Detect frameworks from package.json
	const pkg = readFileSafe(join(cwd, "package.json"));
	if (pkg) {
		try {
			const parsed = JSON.parse(pkg);
			const deps = { ...parsed.dependencies, ...parsed.devDependencies };
			if (deps["next"]) indicators.push("Next.js");
			if (deps["react"]) indicators.push("React");
			if (deps["vue"]) indicators.push("Vue");
			if (deps["svelte"]) indicators.push("Svelte");
			if (deps["prisma"]) indicators.push("Prisma");
			if (deps["drizzle-orm"]) indicators.push("Drizzle");
			if (deps["vitest"]) indicators.push("Vitest");
			if (deps["jest"]) indicators.push("Jest");
			if (deps["playwright"]) indicators.push("Playwright");
		} catch {}
	}

	return [...new Set(indicators)];
}

function scanSkills(cwd: string): string[] {
	const skillDirs = [
		join(cwd, ".pi", "skills"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".claude", "skills"),
	];
	const skills: string[] = [];

	for (const dir of skillDirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				const fullPath = join(dir, entry);
				if (statSync(fullPath).isDirectory()) {
					const skillMd = join(fullPath, "SKILL.md");
					if (existsSync(skillMd)) skills.push(entry);
				} else if (entry.endsWith(".md")) {
					skills.push(basename(entry, ".md"));
				}
			}
		} catch {}
	}

	return skills;
}

function buildContextBlock(cwd: string): string {
	const projectName = basename(cwd);
	const stack = detectStack(cwd);
	const skills = scanSkills(cwd);

	// Read CLAUDE.md or README.md for project instructions
	const claudeMd = readFileSafe(join(cwd, "CLAUDE.md"));
	const readme = readFileSafe(join(cwd, "README.md"));

	const projectInstructions = claudeMd
		? claudeMd.slice(0, 2000) // cap to avoid context bloat
		: readme
		? readme.slice(0, 800)
		: null;

	const lines: string[] = [
		"## Project Context",
		`**Project:** ${projectName}`,
		stack.length > 0 ? `**Stack:** ${stack.join(", ")}` : "",
		skills.length > 0 ? `**Available Skills:** ${skills.join(", ")}` : "",
		"",
	];

	if (projectInstructions) {
		lines.push("### Project Instructions (CLAUDE.md)");
		lines.push(projectInstructions);
		if (claudeMd && claudeMd.length > 2000) {
			lines.push(`\n_[truncated — full context in CLAUDE.md]_`);
		}
	}

	lines.push("\n---\n");

	return lines.filter((l) => l !== "").join("\n");
}

export default function (pi: ExtensionAPI) {
	let contextBlock = "";

	pi.on("session_start", async (_event, ctx) => {
		contextBlock = buildContextBlock(ctx.cwd);

		// Show a brief summary in the footer
		const stack = detectStack(ctx.cwd);
		const skills = scanSkills(ctx.cwd);
		const summary = [
			stack.slice(0, 3).join(" · "),
			skills.length > 0 ? `${skills.length} skill${skills.length > 1 ? "s" : ""}` : "",
		]
			.filter(Boolean)
			.join(" | ");

		if (summary) {
			ctx.ui.setStatus("project-context", summary);
		}
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!contextBlock) return {};
		return { systemPromptPrefix: contextBlock };
	});
}
