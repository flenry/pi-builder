/**
 * Scheduler — In-session recurring and one-shot task scheduling
 *
 * Schedule tasks that fire automatically while your Pi session is running.
 * Tasks trigger via pi.sendUserMessage() so the agent processes them like
 * any user prompt.
 *
 * Commands:
 *   /schedule <interval> <task>  — schedule a recurring task (e.g. /schedule 30m run tests)
 *   /schedule-once <delay> <task> — one-shot delayed task (e.g. /schedule-once 5m remind me to commit)
 *   /schedule-list               — show all scheduled tasks
 *   /schedule-cancel <id>        — cancel a task by ID
 *   /schedule-clear              — cancel all tasks
 *
 * Usage: pi -e extensions/scheduler.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────

interface ScheduledTask {
	id: number;
	task: string;
	intervalMs: number;
	recurring: boolean;
	nextFireAt: number;
	createdAt: number;
	fireCount: number;
	timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
}

// ── Time Parsing ─────────────────────────────────

function parseTimeSpec(spec: string): number | null {
	const match = spec.match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
	if (!match) return null;
	const value = parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	if (unit === "s") return value * 1000;
	if (unit === "m") return value * 60 * 1000;
	if (unit === "h") return value * 60 * 60 * 1000;
	return null;
}

function formatMs(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const tasks: Map<number, ScheduledTask> = new Map();
	let nextId = 1;
	let widgetCtx: ExtensionContext | null = null;

	function updateWidget() {
		if (!widgetCtx) return;

		if (tasks.size === 0) {
			widgetCtx.ui.setWidget("scheduler", undefined);
			widgetCtx.ui.setStatus("scheduler", "");
			return;
		}

		const activeCount = tasks.size;
		const recurringCount = Array.from(tasks.values()).filter(t => t.recurring).length;
		const onceCount = activeCount - recurringCount;
		const parts: string[] = [];
		if (recurringCount > 0) parts.push(`${recurringCount} recurring`);
		if (onceCount > 0) parts.push(`${onceCount} one-shot`);
		widgetCtx.ui.setStatus("scheduler", `⏰ ${parts.join(", ")}`);

		widgetCtx.ui.setWidget("scheduler", (_tui, theme) => ({
			render(width: number): string[] {
				const lines: string[] = [""];
				const header = theme.fg("accent", theme.bold(" ⏰ Scheduled Tasks"));
				lines.push(header);

				const now = Date.now();
				for (const [id, task] of tasks) {
					const type = task.recurring
						? theme.fg("muted", `every ${formatMs(task.intervalMs)}`)
						: theme.fg("dim", `once in ${formatMs(Math.max(0, task.nextFireAt - now))}`);
					const fires = task.fireCount > 0
						? theme.fg("success", ` ✓${task.fireCount}`)
						: "";
					const next = theme.fg("dim", ` next: ${formatTime(task.nextFireAt)}`);
					const desc = theme.fg("text", task.task.length > 50 ? task.task.slice(0, 47) + "..." : task.task);

					lines.push(
						`  ${theme.fg("accent", `#${id}`)} ${type}${fires}${next}` +
						`  ${desc}`
					);
				}

				lines.push("");
				return lines;
			},
			invalidate() {},
		}));
	}

	function fireTask(task: ScheduledTask) {
		task.fireCount++;
		task.nextFireAt = task.recurring ? Date.now() + task.intervalMs : 0;

		if (widgetCtx) {
			widgetCtx.ui.notify(
				`⏰ Scheduled task #${task.id} fired: ${task.task}`,
				"info",
			);
		}

		// Send as a user message so the agent processes it
		pi.sendUserMessage(
			`[Scheduled Task #${task.id}${task.recurring ? ` — recurring every ${formatMs(task.intervalMs)}` : " — one-shot"}]\n\n${task.task}`
		);

		if (!task.recurring) {
			tasks.delete(task.id);
		}

		updateWidget();
	}

	function scheduleTask(taskText: string, intervalMs: number, recurring: boolean): ScheduledTask {
		const id = nextId++;
		const now = Date.now();

		const task: ScheduledTask = {
			id,
			task: taskText,
			intervalMs,
			recurring,
			nextFireAt: now + intervalMs,
			createdAt: now,
			fireCount: 0,
			timer: recurring
				? setInterval(() => fireTask(task), intervalMs)
				: setTimeout(() => fireTask(task), intervalMs),
		};

		tasks.set(id, task);
		updateWidget();
		return task;
	}

	function cancelTask(id: number): boolean {
		const task = tasks.get(id);
		if (!task) return false;

		if (task.recurring) {
			clearInterval(task.timer as ReturnType<typeof setInterval>);
		} else {
			clearTimeout(task.timer as ReturnType<typeof setTimeout>);
		}

		tasks.delete(id);
		updateWidget();
		return true;
	}

	function cancelAll() {
		for (const [id] of tasks) {
			cancelTask(id);
		}
	}

	// ── Commands ─────────────────────────────────

	pi.registerCommand("schedule", {
		description: "Schedule a recurring task: /schedule <interval> <task>  (e.g. /schedule 30m run tests)",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /schedule <interval> <task>\nIntervals: 30s, 5m, 1h, 0.5h\nExample: /schedule 10m check if tests pass", "warning");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const timeSpec = parts[0];
			const taskText = parts.slice(1).join(" ");

			if (!taskText) {
				ctx.ui.notify("Usage: /schedule <interval> <task>", "warning");
				return;
			}

			const ms = parseTimeSpec(timeSpec);
			if (!ms) {
				ctx.ui.notify(`Invalid interval: "${timeSpec}". Use: 30s, 5m, 1h, 0.5h`, "error");
				return;
			}

			if (ms < 10_000) {
				ctx.ui.notify("Minimum interval is 10s", "error");
				return;
			}

			const task = scheduleTask(taskText, ms, true);
			ctx.ui.notify(
				`⏰ Scheduled recurring task #${task.id}: "${taskText}" every ${formatMs(ms)}\nNext fire: ${formatTime(task.nextFireAt)}`,
				"info",
			);
		},
	});

	pi.registerCommand("schedule-once", {
		description: "Schedule a one-shot task: /schedule-once <delay> <task>  (e.g. /schedule-once 5m remind me to commit)",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /schedule-once <delay> <task>\nExample: /schedule-once 5m remind me to commit", "warning");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const timeSpec = parts[0];
			const taskText = parts.slice(1).join(" ");

			if (!taskText) {
				ctx.ui.notify("Usage: /schedule-once <delay> <task>", "warning");
				return;
			}

			const ms = parseTimeSpec(timeSpec);
			if (!ms) {
				ctx.ui.notify(`Invalid delay: "${timeSpec}". Use: 30s, 5m, 1h`, "error");
				return;
			}

			const task = scheduleTask(taskText, ms, false);
			ctx.ui.notify(
				`⏰ Scheduled one-shot task #${task.id}: "${taskText}" in ${formatMs(ms)}\nFires at: ${formatTime(task.nextFireAt)}`,
				"info",
			);
		},
	});

	pi.registerCommand("schedule-list", {
		description: "Show all scheduled tasks",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (tasks.size === 0) {
				ctx.ui.notify("No scheduled tasks.", "info");
				return;
			}

			const now = Date.now();
			const lines = Array.from(tasks.values()).map(t => {
				const type = t.recurring ? `every ${formatMs(t.intervalMs)}` : "one-shot";
				const remaining = formatMs(Math.max(0, t.nextFireAt - now));
				return `#${t.id} [${type}] fires in ${remaining} (×${t.fireCount}): ${t.task}`;
			});

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("schedule-cancel", {
		description: "Cancel a scheduled task: /schedule-cancel <id>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const id = parseInt(args?.trim() || "", 10);
			if (isNaN(id)) {
				ctx.ui.notify("Usage: /schedule-cancel <id>", "warning");
				return;
			}

			if (cancelTask(id)) {
				ctx.ui.notify(`Cancelled task #${id}`, "info");
			} else {
				ctx.ui.notify(`Task #${id} not found`, "error");
			}
		},
	});

	pi.registerCommand("schedule-clear", {
		description: "Cancel all scheduled tasks",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const count = tasks.size;
			cancelAll();
			ctx.ui.notify(`Cleared ${count} scheduled task(s)`, "info");
		},
	});

	// ── Session Lifecycle ────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		widgetCtx = ctx;
		updateWidget();

		ctx.ui.notify(
			"⏰ Scheduler loaded\n\n" +
			"/schedule <interval> <task>     — recurring (e.g. /schedule 30m run tests)\n" +
			"/schedule-once <delay> <task>    — one-shot (e.g. /schedule-once 5m remind me)\n" +
			"/schedule-list                   — show tasks\n" +
			"/schedule-cancel <id>            — cancel task\n" +
			"/schedule-clear                  — cancel all",
			"info",
		);
	});

	pi.on("session_shutdown", async () => {
		cancelAll();
	});
}
