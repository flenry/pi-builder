/**
 * Agent Builder — Generates project-specific agent definitions
 *
 * Analyzes a project's codebase and recommends/generates custom agent
 * definitions tailored to the project's tech stack and needs.
 *
 * Can generate:
 * - Custom agent .md files with project-specific system prompts
 * - teams.yaml with sensible team compositions
 * - Specialized agents for the detected stack (e.g. cdk-deployer, ui-tester)
 *
 * Commands:
 *   /agents-build           — interactive agent generation flow
 *   /agents-build-status    — show current agent definitions
 *
 * Also exposes a tool for LLM-driven agent generation.
 *
 * Usage: pi -e extensions/agent-builder.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	model?: string;
	color?: string;
	skills?: string[];
}

interface TeamDef {
	name: string;
	description: string;
	agents: string[];
}

interface StackProfile {
	name: string;
	stack: string[];
	subprojects: string[];
	hasFrontend: boolean;
	hasBackend: boolean;
	hasInfra: boolean;
	hasDocker: boolean;
	hasCI: boolean;
	hasTests: boolean;
	hasDocs: boolean;
	primaryLanguage: string;
	frameworks: string[];
}

// ── Standard Agents ──────────────────────────────────────────────────────

const STANDARD_AGENTS: AgentDef[] = [
	{
		name: "scout",
		description: "Fast recon and codebase exploration",
		tools: "read,grep,find,ls",
		systemPrompt: "You are a scout agent. Investigate the codebase quickly and report findings concisely. Do NOT modify any files. Focus on structure, patterns, and key entry points.",
	},
	{
		name: "planner",
		description: "Architecture and implementation planning",
		tools: "read,grep,find,ls",
		systemPrompt: "You are a planner agent. Analyze requirements and produce clear, actionable implementation plans. Identify files to change, dependencies, and risks. Output a numbered step-by-step plan. Do NOT modify files.",
	},
	{
		name: "builder",
		description: "Implementation and code generation",
		tools: "read,write,edit,bash,grep,find,ls",
		systemPrompt: "You are a builder agent. Implement the requested changes thoroughly. Write clean, minimal code. Follow existing patterns in the codebase. Test your work when possible.",
	},
	{
		name: "reviewer",
		description: "Code review and quality checks",
		tools: "read,bash,grep,find,ls",
		systemPrompt: "You are a code reviewer agent. Review code for bugs, security issues, style problems, and improvements. Run tests if available. Be concise and use bullet points. Do NOT modify files.",
	},
	{
		name: "documenter",
		description: "Documentation and README generation",
		tools: "read,write,edit,grep,find,ls",
		systemPrompt: "You are a documentation agent. Write clear, concise documentation. Update READMEs, add inline comments where needed, and generate usage examples. Match the project's existing doc style.",
	},
	{
		name: "red-team",
		description: "Security and adversarial testing",
		tools: "read,bash,grep,find,ls",
		systemPrompt: "You are a red team agent. Find security vulnerabilities, edge cases, and failure modes. Check for injection risks, exposed secrets, missing validation, and unsafe defaults. Report findings with severity ratings. Do NOT modify files.",
	},
];

// ── Stack-Specific Agent Templates ───────────────────────────────────────

interface StackAgentTemplate {
	triggers: string[];
	agent: AgentDef;
}

const STACK_AGENTS: StackAgentTemplate[] = [
	{
		triggers: ["aws-cdk", "cdk", "aws-cdk-lib", "cloudformation"],
		agent: {
			name: "cdk-deployer",
			description: "AWS CDK infrastructure management — synth, diff, deploy",
			tools: "bash,read,grep,find,ls",
			systemPrompt: `You are a CDK infrastructure agent. Your responsibilities:
- Run \`cdk synth\` to validate CloudFormation templates
- Run \`cdk diff\` to preview infrastructure changes
- Run \`cdk deploy\` when explicitly asked (always with --require-approval broadening)
- Review stack outputs and resource configurations
- Check for security best practices in IAM policies and resource configs
- Never deploy without showing the diff first
- Use cdk-nag findings to improve security posture`,
		},
	},
	{
		triggers: ["react", "vue", "angular", "next", "nuxt", "svelte"],
		agent: {
			name: "ui-builder",
			description: "Frontend component development and styling",
			tools: "read,write,edit,bash,grep,find,ls",
			systemPrompt: `You are a frontend UI builder agent. Your responsibilities:
- Build and modify UI components following the project's component patterns
- Ensure responsive design and accessibility (ARIA, semantic HTML)
- Follow the existing styling approach (CSS modules, Tailwind, styled-components, etc.)
- Write component tests when test infrastructure exists
- Keep components focused and composable`,
		},
	},
	{
		triggers: ["playwright", "@playwright/test", "cypress"],
		agent: {
			name: "ui-tester",
			description: "End-to-end UI testing with browser automation",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a UI testing agent. Your responsibilities:
- Write and run end-to-end tests using the project's test framework
- Test critical user flows: login, navigation, forms, data display
- Take screenshots for visual regression when relevant
- Report test failures with clear reproduction steps
- Keep tests stable and avoid flaky selectors`,
			skills: ["playwright-bowser"],
		},
	},
	{
		triggers: ["express", "fastify", "nestjs", "@nestjs/core", "hono"],
		agent: {
			name: "api-builder",
			description: "Backend API development — routes, middleware, validation",
			tools: "read,write,edit,bash,grep,find,ls",
			systemPrompt: `You are a backend API builder agent. Your responsibilities:
- Build and modify API endpoints following existing patterns
- Add proper input validation and error handling
- Write integration tests for new endpoints
- Ensure consistent response formats
- Follow RESTful conventions (or GraphQL patterns if applicable)`,
		},
	},
	{
		triggers: ["docker", "dockerfile", "docker-compose"],
		agent: {
			name: "docker-ops",
			description: "Docker containerization — build, compose, optimize",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a Docker operations agent. Your responsibilities:
- Build and optimize Dockerfiles (multi-stage builds, layer caching)
- Manage docker-compose configurations
- Debug container issues (logs, exec, inspect)
- Ensure images are minimal and secure
- Never push images without explicit approval`,
		},
	},
	{
		triggers: ["prisma", "@prisma/client", "drizzle", "drizzle-orm", "typeorm", "sequelize", "knex"],
		agent: {
			name: "db-manager",
			description: "Database schema management — migrations, queries, models",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a database management agent. Your responsibilities:
- Create and review database migrations
- Optimize queries and indexes
- Manage schema changes safely (backward compatible)
- Generate and update ORM models/schemas
- Always preview migrations before applying them`,
		},
	},
	{
		triggers: [".github", "github-actions", ".gitlab-ci.yml"],
		agent: {
			name: "ci-engineer",
			description: "CI/CD pipeline management — workflows, builds, deployments",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a CI/CD engineering agent. Your responsibilities:
- Create and modify CI/CD pipeline configurations
- Optimize build times and caching strategies
- Set up proper test, lint, and deploy stages
- Ensure secrets are handled securely (never hardcoded)
- Debug pipeline failures from logs`,
		},
	},
	{
		triggers: ["terraform", ".terraform"],
		agent: {
			name: "terraform-ops",
			description: "Terraform infrastructure management — plan, apply, state",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a Terraform operations agent. Your responsibilities:
- Run \`terraform plan\` to preview changes
- Review state files and resource dependencies
- Write clean, modular HCL with proper variable usage
- Never apply without showing the plan first
- Follow security best practices for cloud resources`,
		},
	},
	{
		triggers: ["kubernetes", "k8s", "helm"],
		agent: {
			name: "k8s-ops",
			description: "Kubernetes management — manifests, helm, debugging",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are a Kubernetes operations agent. Your responsibilities:
- Create and modify K8s manifests and Helm charts
- Debug pod issues (logs, describe, exec)
- Manage deployments, services, and ingress configs
- Review resource limits and security contexts
- Never apply to production without explicit confirmation`,
		},
	},
	{
		triggers: ["amplify", "@aws-amplify"],
		agent: {
			name: "amplify-ops",
			description: "AWS Amplify management — codegen, push, pull",
			tools: "bash,read,write,edit,grep,find,ls",
			systemPrompt: `You are an AWS Amplify operations agent. Your responsibilities:
- Run amplify codegen to generate GraphQL types
- Manage Amplify backend resources (API, auth, storage)
- Handle amplify push/pull operations
- Review and optimize GraphQL schemas and resolvers
- Ensure proper authentication and authorization rules`,
		},
	},
];

// ── Analysis ─────────────────────────────────────────────────────────────

function analyzeStack(projectDir: string): StackProfile {
	const stack: string[] = [];
	const frameworks: string[] = [];
	const subprojects: string[] = [];
	let primaryLanguage = "Unknown";
	let hasFrontend = false;
	let hasBackend = false;
	let hasInfra = false;
	let hasDocker = false;
	let hasCI = false;
	let hasTests = false;
	let hasDocs = false;

	const allTriggers: string[] = [];

	// Scan package.json files
	const scanDirs = [projectDir];
	try {
		for (const entry of readdirSync(projectDir)) {
			if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
			const sub = join(projectDir, entry);
			try {
				const s = require("node:fs").statSync(sub);
				if (s.isDirectory()) scanDirs.push(sub);
			} catch {}
		}
	} catch {}

	for (const dir of scanDirs) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (dir !== projectDir) subprojects.push(basename(dir));

				const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
				for (const dep of Object.keys(deps)) {
					allTriggers.push(dep.toLowerCase());
				}

				if (deps["react"] || deps["vue"] || deps["@angular/core"] || deps["svelte"]) hasFrontend = true;
				if (deps["express"] || deps["fastify"] || deps["@nestjs/core"] || deps["hono"]) hasBackend = true;
				if (deps["aws-cdk-lib"] || deps["aws-cdk"]) hasInfra = true;

				if (deps["typescript"]) primaryLanguage = "TypeScript";
				else if (!deps["typescript"] && primaryLanguage === "Unknown") primaryLanguage = "JavaScript";

				// Check for test frameworks
				if (deps["jest"] || deps["vitest"] || deps["mocha"] || deps["@playwright/test"] || deps["cypress"]) hasTests = true;
			} catch {}
		}

		// Python
		if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) {
			primaryLanguage = "Python";
			stack.push("Python");
		}
	}

	// File checks
	if (existsSync(join(projectDir, "Dockerfile")) || existsSync(join(projectDir, "docker-compose.yml"))) hasDocker = true;
	if (existsSync(join(projectDir, ".github")) || existsSync(join(projectDir, ".gitlab-ci.yml"))) hasCI = true;
	if (existsSync(join(projectDir, "docs")) || existsSync(join(projectDir, "doc"))) hasDocs = true;
	if (existsSync(join(projectDir, "terraform")) || existsSync(join(projectDir, ".terraform"))) hasInfra = true;
	if (existsSync(join(projectDir, "k8s")) || existsSync(join(projectDir, "kubernetes"))) hasInfra = true;

	return {
		name: basename(projectDir),
		stack: [...new Set(stack)],
		subprojects,
		hasFrontend,
		hasBackend,
		hasInfra,
		hasDocker,
		hasCI,
		hasTests,
		hasDocs,
		primaryLanguage,
		frameworks,
	};
}

function getRecommendedAgents(profile: StackProfile, triggers: string[]): AgentDef[] {
	const recommended: AgentDef[] = [];

	for (const template of STACK_AGENTS) {
		const match = template.triggers.some(t =>
			triggers.some(pt => pt.includes(t.toLowerCase()) || t.toLowerCase().includes(pt))
		);
		if (match) {
			recommended.push(template.agent);
		}
	}

	return recommended;
}

function generateAgentMd(agent: AgentDef): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${agent.name}`);
	lines.push(`description: ${agent.description}`);
	lines.push(`tools: ${agent.tools}`);
	if (agent.model) lines.push(`model: ${agent.model}`);
	if (agent.color) lines.push(`color: ${agent.color}`);
	if (agent.skills?.length) lines.push(`skills:\n${agent.skills.map(s => `  - ${s}`).join("\n")}`);
	lines.push("---");
	lines.push(agent.systemPrompt);
	return lines.join("\n") + "\n";
}

function generateTeamsYaml(teams: TeamDef[]): string {
	const lines: string[] = [];
	for (const team of teams) {
		lines.push(`# ${team.description}`);
		lines.push(`${team.name}:`);
		for (const agent of team.agents) {
			lines.push(`  - ${agent}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function buildDefaultTeams(standardAgents: string[], stackAgents: string[]): TeamDef[] {
	const teams: TeamDef[] = [];

	// Full team: all agents
	const all = [...standardAgents, ...stackAgents];
	teams.push({
		name: "full",
		description: "All available agents",
		agents: all,
	});

	// Plan-build: planning then implementation
	const planBuild = ["planner", "builder", "reviewer"];
	if (standardAgents.includes("planner") && standardAgents.includes("builder")) {
		teams.push({
			name: "plan-build",
			description: "Plan, build, review cycle",
			agents: planBuild.filter(a => standardAgents.includes(a)),
		});
	}

	// Info: read-only exploration
	const info = ["scout", "documenter", "reviewer"].filter(a => standardAgents.includes(a));
	if (info.length > 1) {
		teams.push({
			name: "info",
			description: "Read-only exploration and documentation",
			agents: info,
		});
	}

	// Stack-specific teams
	if (stackAgents.includes("ui-builder") || stackAgents.includes("ui-tester")) {
		const frontend = ["planner", "ui-builder"];
		if (stackAgents.includes("ui-tester")) frontend.push("ui-tester");
		frontend.push("reviewer");
		teams.push({
			name: "frontend",
			description: "Frontend development team",
			agents: frontend.filter(a => standardAgents.includes(a) || stackAgents.includes(a)),
		});
	}

	if (stackAgents.includes("cdk-deployer") || stackAgents.includes("terraform-ops") || stackAgents.includes("k8s-ops")) {
		const infra = ["scout"];
		if (stackAgents.includes("cdk-deployer")) infra.push("cdk-deployer");
		if (stackAgents.includes("terraform-ops")) infra.push("terraform-ops");
		if (stackAgents.includes("k8s-ops")) infra.push("k8s-ops");
		if (stackAgents.includes("docker-ops")) infra.push("docker-ops");
		infra.push("reviewer");
		teams.push({
			name: "infra",
			description: "Infrastructure management team",
			agents: infra.filter(a => standardAgents.includes(a) || stackAgents.includes(a)),
		});
	}

	if (stackAgents.includes("api-builder") && stackAgents.includes("db-manager")) {
		teams.push({
			name: "backend",
			description: "Backend API and database team",
			agents: ["planner", "api-builder", "db-manager", "reviewer"].filter(
				a => standardAgents.includes(a) || stackAgents.includes(a)
			),
		});
	}

	return teams;
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		ctx.ui.notify("Agent Builder loaded — use /agents-build to generate project-specific agents", "info");
	});

	// ── /agents-build command ────────────────────────────────────────────

	pi.registerCommand("agents-build", {
		description: "Generate project-specific agent definitions",
		handler: async (args, ctx) => {
			try {
				await runAgentBuild(args, ctx);
			} catch (err: any) {
				ctx.ui.notify(`Agent Builder error: ${err.message}`, "error");
			}
		},
	});

	// ── /agents-build-status command ─────────────────────────────────────

	pi.registerCommand("agents-build-status", {
		description: "Show current agent definitions in the project",
		handler: async (_args, ctx) => {
			const agentDir = join(ctx.cwd, ".pi", "agents");
			if (!existsSync(agentDir)) {
				ctx.ui.notify("No .pi/agents/ directory found. Run /agents-build first.", "warning");
				return;
			}

			const agents: string[] = [];
			for (const file of readdirSync(agentDir)) {
				if (!file.endsWith(".md")) continue;
				try {
					const content = readFileSync(join(agentDir, file), "utf-8");
					const nameMatch = content.match(/^name:\s*(.+)$/m);
					const descMatch = content.match(/^description:\s*(.+)$/m);
					agents.push(`  ${nameMatch?.[1] || basename(file, ".md")} — ${descMatch?.[1] || "no description"}`);
				} catch {}
			}

			const teamsPath = join(agentDir, "teams.yaml");
			let teamsInfo = "";
			if (existsSync(teamsPath)) {
				const content = readFileSync(teamsPath, "utf-8");
				const teamNames = content.match(/^(\w[\w-]*):/gm) || [];
				teamsInfo = `\nTeams: ${teamNames.map(t => t.replace(":", "")).join(", ")}`;
			}

			ctx.ui.notify(
				`Agents in ${basename(ctx.cwd)}:\n${agents.join("\n")}${teamsInfo}`,
				"info"
			);
		},
	});

	// ── Tool for LLM-driven agent generation ─────────────────────────────

	pi.registerTool({
		name: "build_agents",
		label: "Build Agents",
		description: "Analyze a project and generate/recommend custom agent definitions. Use when the user asks to create agents for a project.",
		parameters: Type.Object({
			projectDir: Type.String({ description: "Absolute path to the target project directory" }),
			mode: Type.Optional(Type.Union([
				Type.Literal("recommend"),
				Type.Literal("generate"),
			], { description: "recommend = show suggestions, generate = write files. Default: recommend" })),
			customAgents: Type.Optional(Type.Array(
				Type.Object({
					name: Type.String(),
					description: Type.String(),
					tools: Type.String(),
					systemPrompt: Type.String(),
					model: Type.Optional(Type.String()),
				}),
				{ description: "Custom agent definitions to include alongside standard/recommended agents" }
			)),
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

			const profile = analyzeStack(projectDir);

			// Gather all triggers from package.json deps
			const allTriggers: string[] = [];
			const scanDirs = [projectDir];
			try {
				for (const entry of readdirSync(projectDir)) {
					if (entry.startsWith(".") || entry === "node_modules") continue;
					const sub = join(projectDir, entry);
					try { if (require("node:fs").statSync(sub).isDirectory()) scanDirs.push(sub); } catch {}
				}
			} catch {}
			for (const dir of scanDirs) {
				const pkgPath = join(dir, "package.json");
				if (existsSync(pkgPath)) {
					try {
						const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
						const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
						allTriggers.push(...Object.keys(deps).map(d => d.toLowerCase()));
					} catch {}
				}
			}

			const recommended = getRecommendedAgents(profile, allTriggers);
			const standardNames = STANDARD_AGENTS.map(a => a.name);
			const stackNames = recommended.map(a => a.name);
			const teams = buildDefaultTeams(standardNames, stackNames);

			if (mode === "recommend") {
				const lines: string[] = [
					`🤖 Agent Recommendations for ${profile.name}`,
					`   Language: ${profile.primaryLanguage}`,
					`   Frontend: ${profile.hasFrontend ? "yes" : "no"} | Backend: ${profile.hasBackend ? "yes" : "no"} | Infra: ${profile.hasInfra ? "yes" : "no"}`,
					`   Sub-projects: ${profile.subprojects.join(", ") || "none"}`,
					``,
					`📋 Standard Agents (always recommended):`,
					...STANDARD_AGENTS.map(a => `   ● ${a.name} — ${a.description}`),
					``,
				];

				if (recommended.length > 0) {
					lines.push(`🎯 Stack-Specific Agents (detected from your project):`);
					for (const agent of recommended) {
						lines.push(`   ★ ${agent.name} — ${agent.description}`);
					}
					lines.push("");
				}

				lines.push(`👥 Suggested Teams:`);
				for (const team of teams) {
					lines.push(`   ${team.name}: ${team.agents.join(" → ")} — ${team.description}`);
				}

				if (params.customAgents?.length) {
					lines.push(``, `🔧 Custom Agents (user-defined):`);
					for (const a of params.customAgents) {
						lines.push(`   ✦ ${a.name} — ${a.description}`);
					}
				}

				lines.push(``, `Use mode "generate" to write these to ${projectDir}/.pi/agents/`);

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { profile, standardAgents: standardNames, stackAgents: stackNames, teams: teams.map(t => t.name) },
				};
			}

			// Generate mode — write files
			const agentDir = join(projectDir, ".pi", "agents");
			mkdirSync(agentDir, { recursive: true });

			const written: string[] = [];

			// Standard agents
			for (const agent of STANDARD_AGENTS) {
				const filePath = join(agentDir, `${agent.name}.md`);
				writeFileSync(filePath, generateAgentMd(agent));
				written.push(agent.name);
			}

			// Stack-specific agents
			for (const agent of recommended) {
				const filePath = join(agentDir, `${agent.name}.md`);
				writeFileSync(filePath, generateAgentMd(agent));
				written.push(agent.name);
			}

			// Custom agents
			if (params.customAgents) {
				for (const agent of params.customAgents) {
					const filePath = join(agentDir, `${agent.name}.md`);
					writeFileSync(filePath, generateAgentMd(agent as AgentDef));
					written.push(agent.name);

					// Add to teams
					const customTeamAgents = [...stackNames, agent.name];
					// Rebuild teams with custom agents
				}
			}

			// Teams
			const allStackNames = [...stackNames, ...(params.customAgents?.map(a => a.name) || [])];
			const finalTeams = buildDefaultTeams(standardNames, allStackNames);
			const teamsPath = join(agentDir, "teams.yaml");
			writeFileSync(teamsPath, generateTeamsYaml(finalTeams));

			return {
				content: [{ type: "text", text: `✓ Generated ${written.length} agent definitions and ${finalTeams.length} teams in ${agentDir}/\n\nAgents: ${written.join(", ")}\nTeams: ${finalTeams.map(t => t.name).join(", ")}` }],
				details: { written, teams: finalTeams.map(t => t.name), path: agentDir },
			};
		},
	});

	// ── Interactive flow ─────────────────────────────────────────────────

	async function runAgentBuild(args: string, ctx: any) {
		let targetDir = args?.trim() || "";
		if (!targetDir) {
			targetDir = await ctx.ui.input("Target project directory", ctx.cwd) || ctx.cwd;
		}
		targetDir = resolve(targetDir.replace(/^~/, process.env.HOME || "~"));

		if (!existsSync(targetDir)) {
			ctx.ui.notify(`Directory not found: ${targetDir}`, "error");
			return;
		}

		ctx.ui.notify(`🔍 Analyzing ${basename(targetDir)}...`, "info");
		const profile = analyzeStack(targetDir);

		// Gather triggers
		const allTriggers: string[] = [];
		const scanDirs = [targetDir];
		try {
			for (const entry of readdirSync(targetDir)) {
				if (entry.startsWith(".") || entry === "node_modules") continue;
				const sub = join(targetDir, entry);
				try { if (require("node:fs").statSync(sub).isDirectory()) scanDirs.push(sub); } catch {}
			}
		} catch {}
		for (const dir of scanDirs) {
			const pkgPath = join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
					const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
					allTriggers.push(...Object.keys(deps).map(d => d.toLowerCase()));
				} catch {}
			}
		}

		const recommended = getRecommendedAgents(profile, allTriggers);

		// Show profile
		ctx.ui.notify(
			`📦 ${profile.name}\n` +
			`   Language: ${profile.primaryLanguage}\n` +
			`   Frontend: ${profile.hasFrontend} | Backend: ${profile.hasBackend} | Infra: ${profile.hasInfra}\n` +
			`   Sub-projects: ${profile.subprojects.join(", ") || "none"}`,
			"info"
		);

		// Select standard agents
		ctx.ui.notify("Select standard agents (pick one at a time, 'Done' when finished)", "info");
		const selectedStandard: string[] = [];
		while (true) {
			const remaining = STANDARD_AGENTS.filter(a => !selectedStandard.includes(a.name));
			if (remaining.length === 0) break;
			const options = [
				`✓ Done (${selectedStandard.length} selected)`,
				...remaining.map(a => `${a.name} — ${a.description}`),
			];
			const choice = await ctx.ui.select(`Standard Agents (${selectedStandard.length}/${STANDARD_AGENTS.length})`, options);
			if (!choice || choice.startsWith("✓ Done")) break;
			const name = choice.split(" — ")[0];
			selectedStandard.push(name);
			ctx.ui.notify(`Added: ${name}`, "success");
		}

		// Select stack-specific agents
		const selectedStack: string[] = [];
		if (recommended.length > 0) {
			ctx.ui.notify(`Found ${recommended.length} stack-specific agent(s)`, "info");
			for (const agent of recommended) {
				const add = await ctx.ui.confirm(
					`Add ${agent.name}?`,
					agent.description
				);
				if (add) selectedStack.push(agent.name);
			}
		}

		// Custom agents
		const addCustom = await ctx.ui.confirm("Add Custom Agents?", "Define your own specialized agents?");
		const customAgents: AgentDef[] = [];
		if (addCustom) {
			while (true) {
				const name = await ctx.ui.input("Agent name (empty to stop)", "e.g. data-migrator");
				if (!name?.trim()) break;
				const description = await ctx.ui.input("Description", "") || "";
				const tools = await ctx.ui.input("Tools (comma-separated)", "read,write,edit,bash,grep,find,ls") || "read,bash,grep,find,ls";
				const prompt = await ctx.ui.input("System prompt", "") || `You are a ${name} agent. ${description}`;
				customAgents.push({ name: name.trim(), description, tools, systemPrompt: prompt });
				ctx.ui.notify(`Added custom agent: ${name.trim()}`, "success");
			}
		}

		// Build teams
		const allStandard = selectedStandard;
		const allStack = [...selectedStack, ...customAgents.map(a => a.name)];
		const teams = buildDefaultTeams(allStandard, allStack);

		// Confirm
		const summary = [
			`Standard: ${selectedStandard.join(", ") || "none"}`,
			`Stack-specific: ${selectedStack.join(", ") || "none"}`,
			`Custom: ${customAgents.map(a => a.name).join(", ") || "none"}`,
			`Teams: ${teams.map(t => `${t.name}(${t.agents.length})`).join(", ")}`,
			`Target: ${targetDir}/.pi/agents/`,
		].join("\n");

		const proceed = await ctx.ui.confirm("Generate Agents?", summary);
		if (!proceed) {
			ctx.ui.notify("Cancelled.", "warning");
			return;
		}

		// Write
		const agentDir = join(targetDir, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });

		let count = 0;

		for (const name of selectedStandard) {
			const agent = STANDARD_AGENTS.find(a => a.name === name)!;
			writeFileSync(join(agentDir, `${agent.name}.md`), generateAgentMd(agent));
			count++;
		}

		for (const name of selectedStack) {
			const agent = recommended.find(a => a.name === name)!;
			writeFileSync(join(agentDir, `${agent.name}.md`), generateAgentMd(agent));
			count++;
		}

		for (const agent of customAgents) {
			writeFileSync(join(agentDir, `${agent.name}.md`), generateAgentMd(agent));
			count++;
		}

		writeFileSync(join(agentDir, "teams.yaml"), generateTeamsYaml(teams));

		ctx.ui.notify(
			`✓ Generated ${count} agents and ${teams.length} teams\n` +
			`   Location: ${agentDir}/\n` +
			`   Teams: ${teams.map(t => t.name).join(", ")}`,
			"success"
		);
	}
}
