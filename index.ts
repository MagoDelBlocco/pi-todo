/**
 * pi-todo — Stateful to-do extension for pi.
 *
 * Two surfaces:
 *  1. Recited list (compact, injected every turn via the `context` event)
 *  2. Per-item detail (addressable via todo_get, full detail only for in_progress)
 *
 * Persistence: .pi/pi-todo.md (project-local markdown file).
 * UI: plan approval dialog on creation, plus an active-item status indicator.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	appendFileSync,
	mkdirSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	matchesKey,
	Text,
	Container,
	Spacer,
	type SelectItem,
	SelectList,
	type Component,
	truncateToWidth,
	visibleWidth,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type TodoList,
	type TodoConfig,
	DEFAULT_CONFIG,
	serializeTodoList,
	parseTodoList,
	buildRecitation,
	checkDeps,
	enforceSingleInProgress,
} from "./lib.ts";

// ─── Persistence ──────────────────────────────────────────────────────────────

const TODO_FILE = "pi-todo.md";
const DONE_FILE = "pi-todo.done.md";

function getPiDir(cwd: string): string {
	return resolve(cwd, ".pi");
}

function getTodoPath(cwd: string): string {
	return join(getPiDir(cwd), TODO_FILE);
}

function getDonePath(cwd: string): string {
	return join(getPiDir(cwd), DONE_FILE);
}

function loadTodoList(cwd: string): TodoList {
	const path = getTodoPath(cwd);
	if (!existsSync(path)) return { items: [] };
	const content = readFileSync(path, "utf-8");
	return parseTodoList(content);
}

function saveTodoList(cwd: string, list: TodoList): void {
	const path = getTodoPath(cwd);

	// An empty list means "no todos". Remove the file instead of writing an
	// empty stub — otherwise the shutdown save resurrects the file that retire
	// (or /todo clear) just deleted.
	if (list.items.length === 0) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}

	const piDir = getPiDir(cwd);
	if (!existsSync(piDir)) mkdirSync(piDir, { recursive: true });
	writeFileSync(path, serializeTodoList(list), "utf-8");
}

function retireTodoList(cwd: string): void {
	const todoPath = getTodoPath(cwd);
	const donePath = getDonePath(cwd);
	if (!existsSync(todoPath)) return;

	const content = readFileSync(todoPath, "utf-8");
	const timestamp = new Date().toISOString();
	const header = `## Completed: ${timestamp}\n\n`;

	const piDir = getPiDir(cwd);
	if (!existsSync(piDir)) mkdirSync(piDir, { recursive: true });
	appendFileSync(donePath, header + content + "\n\n", "utf-8");

	unlinkSync(todoPath);
}

// ─── Temporary approval dialog ───────────────────────────────────────────────

type PlanDecision = "approve" | "revise" | "reject";

class PlanApproval implements Component {
	private scroll = 0;
	private maxScroll = 0;
	private pageSize = 1;
	private preview: string;
	private tui: TUI;
	private theme: Theme;
	private choices: SelectList;

	constructor(
		preview: string,
		tui: TUI,
		theme: Theme,
		done: (decision: PlanDecision) => void,
	) {
		this.preview = preview;
		this.tui = tui;
		this.theme = theme;
		this.choices = new SelectList(
			[
				{ value: "approve", label: "Approve plan" },
				{ value: "revise", label: "Request changes" },
				{ value: "reject", label: "Reject plan" },
			],
			3,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		this.choices.onSelect = (item) => done(item.value as PlanDecision);
		this.choices.onCancel = () => done("reject");
	}

	invalidate(): void {
		this.choices.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const content = wrapTextWithAnsi(this.preview, innerWidth);
		const availableRows = Math.max(5, Math.floor((this.tui.terminal.rows - 2) * 0.85));
		const showHelp = availableRows >= 9;
		const visibleRows = Math.max(0, availableRows - (showHelp ? 8 : 5));
		this.pageSize = Math.max(1, visibleRows - 1);
		this.maxScroll = Math.max(0, content.length - visibleRows);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const row = (text: string) =>
			border("│ ") + truncateToWidth(text, innerWidth, "", true) + border(" │");
		const title = " Review proposed todo plan ";
		const lines = [border("╭─" + title + "─".repeat(Math.max(0, width - visibleWidth("╭─" + title + "╮"))) + "╮")];
		for (const line of content.slice(this.scroll, this.scroll + visibleRows)) {
			lines.push(row(line));
		}
		if (showHelp) {
			lines.push(row(`Plan ${this.scroll + 1}-${Math.min(content.length, this.scroll + visibleRows)}/${content.length}  •  PageUp/PageDown scroll`));
			lines.push(row("Choose an action:"));
		}
		for (const line of this.choices.render(innerWidth)) lines.push(row(line));
		if (showHelp) lines.push(row(this.theme.fg("dim", "↑↓ choose  •  Enter select  •  Esc cancel")));
		lines.push(border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯"));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "pageup")) this.scroll = Math.max(0, this.scroll - this.pageSize);
		else if (matchesKey(data, "pagedown")) this.scroll = Math.min(this.maxScroll, this.scroll + this.pageSize);
		else this.choices.handleInput(data);
		this.tui.requestRender();
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let todoList: TodoList = { items: [] };
	const config: TodoConfig = { ...DEFAULT_CONFIG };
	let cwd: string = "";

	/** Load from file and set in-memory state */
	const loadState = (ctx: ExtensionContext) => {
		cwd = ctx.cwd;
		todoList = loadTodoList(cwd);
	};

	/** Save in-memory state to file */
	const saveState = () => {
		if (cwd) saveTodoList(cwd, todoList);
	};

	const approvePlan = async (
		ctx: ExtensionContext,
		preview: string,
		signal?: AbortSignal,
	): Promise<PlanDecision | undefined> => {
		if (!ctx.hasUI || signal?.aborted) return undefined;
		let removeAbortListener: (() => void) | undefined;
		try {
			const result = await ctx.ui.custom<PlanDecision>(
				(tui, theme, _kb, done) => {
					const onAbort = () => done("reject");
					signal?.addEventListener("abort", onAbort, { once: true });
					removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
					return new PlanApproval(preview, tui, theme, done);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "70%",
						minWidth: 50,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
			if (result !== undefined) return signal?.aborted ? undefined : result;
			// RPC clients can implement select/input while custom components are unavailable.
			const choice = await ctx.ui.select(
				`Review proposed todo plan\n\n${preview}`,
				["Approve", "Request changes", "Reject"],
				{ signal },
			);
			if (signal?.aborted) return undefined;
			return choice === "Approve" ? "approve" : choice === "Request changes" ? "revise" : "reject";
		} finally {
			removeAbortListener?.();
		}
	};

	// ─── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx);
		enforceSingleInProgress(todoList);

		updateStatusIndicator(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (cwd) saveState();
	});

	// ─── Recitation before every model call ─────────────────────────────────

	pi.on("context", async (event, _ctx) => {
		const recitation = buildRecitation(todoList, config);
		if (!recitation) return;

		// Find the last user message and insert recitation before it
		const messages = [...event.messages];
		let insertIndex = messages.length;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				insertIndex = i;
				break;
			}
		}

		messages.splice(insertIndex, 0, {
			role: "user" as const,
			content: [{ type: "text" as const, text: recitation }],
			timestamp: Date.now(),
		} as any);

		return { messages };
	});

	// ─── Helpers ────────────────────────────────────────────────────────────

	const buildSummary = () =>
		todoList.items
			.map((i) => {
				const icon =
					i.status === "completed"
						? "✅"
						: i.status === "in_progress"
							? "▶️"
							: "⬜";
				return `${icon} ${i.id}: ${i.headline}`;
			})
			.join("\n");

	const updateStatusIndicator = (ctx: ExtensionContext) => {
		const inProgress = todoList.items.find((i) => i.status === "in_progress");
		if (inProgress) {
			ctx.ui.setStatus(
				"pi-todo",
				`${ctx.ui.theme.bg("customMessageBg", ctx.ui.theme.fg("accent", `▶ ${inProgress.id}: ${inProgress.headline}`))}`,
			);
		} else if (todoList.items.length > 0) {
			ctx.ui.setStatus(
				"pi-todo",
				`${ctx.ui.theme.bg("customMessageBg", ctx.ui.theme.fg("dim", `${todoList.items.length} todo(s)`))}`,
			);
		} else {
			ctx.ui.setStatus("pi-todo", undefined);
		}
	};

	const handleRetire = (ctx: ExtensionContext) => {
		if (
			todoList.items.length > 0 &&
			todoList.items.every((i) => i.status === "completed")
		) {
			const summary = todoList.items
				.map((i) => `- [x] ${i.id}: ${i.headline}`)
				.join("\n");
			retireTodoList(cwd);
			todoList = { items: [] };
			ctx.ui.setStatus("pi-todo", undefined);
			return {
				content: [
					{
						type: "text" as const,
						text: `All todos completed! Retired to ${DONE_FILE}.\n\n${summary}`,
					},
				],
				details: { retired: true },
			};
		}
		return null;
	};

	// ─── Tools ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the todo list. Use for multi-step, multi-tool, or long-running tasks. " +
			"NOT for trivial single-step work. Actions: write (create/update items), " +
			"set_status (change status), get (fetch item detail), list (compact overview).",
		promptSnippet: "Manage persistent todo list for multi-step tasks",
		promptGuidelines: [
			"Use todo with action 'write' to create a plan before starting multi-step work. Fill definitionOfDone for every item.",
			"New plans and full replacements require user approval. If the user requests changes, revise the proposal and submit it again before acting on it.",
			"Use todo with action 'set_status' to move items between pending, in_progress, and completed. Only one item may be in_progress at a time.",
			"Use todo with action 'get' to fetch full detail of a specific item by ID when you need the agent-facing notes.",
			"Use todo with action 'list' to see the compact list without detail.",
			"Refine the active item's detail just before executing it — don't trust stale plan notes.",
		],
		parameters: Type.Object({
			action: StringEnum(["write", "set_status", "get", "list"] as const),
			// write
			items: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({
							description: "Stable short unique ID (e.g. t1, t2)",
						}),
						headline: Type.String({
							description: "Imperative user-facing headline",
						}),
						status: Type.Optional(
							StringEnum(["pending", "in_progress", "completed"] as const),
						),
						detail: Type.Optional(
							Type.Object({
								definitionOfDone: Type.Optional(
									Type.String({
										description:
											"Acceptance criteria — how you'll know it's done",
									}),
								),
								constraints: Type.Optional(
									Type.Array(Type.String({ description: "Guardrails" })),
								),
								refs: Type.Optional(
									Type.Array(
										Type.String({
											description:
												"Pointers: file paths, symbols, IDs — not copies",
										}),
									),
								),
								deps: Type.Optional(
									Type.Array(
										Type.String({ description: "IDs this item depends on" }),
									),
								),
								rationale: Type.Optional(
									Type.String({ description: "Why this item exists" }),
								),
								nextStep: Type.Optional(
									Type.String({
										description: "One-line hand-off note: what to do next",
									}),
								),
							}),
						),
					}),
				),
			),
			replaceAll: Type.Optional(
				Type.Boolean({
					description: "Replace entire list (default: false, upsert)",
				}),
			),
			// set_status
			id: Type.Optional(Type.String({ description: "Todo item ID" })),
			status: Type.Optional(
				StringEnum(["pending", "in_progress", "completed"] as const),
			),
			nextStep: Type.Optional(
				Type.String({ description: "Update the nextStep hand-off note" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { action } = params;
			const invalidParams = (message: string) => ({
				content: [{ type: "text" as const, text: message }],
				details: { error: "invalid parameters" },
			});

			// ── write ──
			if (action === "write") {
				if (!params.items) return invalidParams("write requires items");
				for (const item of params.items) {
					if (!/^\S+$/.test(item.id)) {
						return invalidParams(`Invalid todo ID: ${item.id}`);
					}
				}
				const proposed: TodoList = params.replaceAll
					? { items: [] }
					: structuredClone(todoList);

				for (const newItem of params.items ?? []) {
					if (newItem.status === "in_progress") {
						for (const item of proposed.items) {
							if (item.id !== newItem.id && item.status === "in_progress") {
								item.status = "pending";
							}
						}
					}
					const existing = proposed.items.find((i) => i.id === newItem.id);
					if (existing) {
						if (newItem.headline) existing.headline = newItem.headline;
						if (newItem.status) existing.status = newItem.status;
						if (newItem.detail) {
							existing.detail = { ...existing.detail, ...newItem.detail };
						}
					} else {
						proposed.items.push({
							id: newItem.id,
							headline: newItem.headline,
							status: newItem.status ?? "pending",
							detail: newItem.detail ?? {},
						});
					}
				}

				enforceSingleInProgress(proposed);
				if (proposed.items.length > 0 && (todoList.items.length === 0 || params.replaceAll)) {
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: "Plan approval requires an interactive UI; no changes were saved." }],
							isError: true,
							details: { approval: "unavailable" },
						};
					}
					onUpdate?.({ content: [{ type: "text", text: "Waiting for plan approval..." }] });
					const decision = await approvePlan(ctx, serializeTodoList(proposed), signal);
					if (decision !== "approve") {
						const feedback = decision === "revise"
							? await ctx.ui.input("What should the agent change in the plan?", "Describe the changes...", { signal })
							: undefined;
						const message = decision === "revise"
							? `User requested changes to the plan${feedback?.trim() ? `: ${feedback.trim()}` : ". Ask for specific feedback before trying again."}`
							: "Plan was not approved. No changes were saved.";
						return {
							content: [{ type: "text", text: message }],
							details: { approval: decision ?? "cancelled", feedback: feedback?.trim() },
						};
					}
				}
				todoList = proposed;
				saveState();

				// A write can complete the final item just as set_status can.
				const retiredAfterWrite = handleRetire(ctx);
				if (retiredAfterWrite) return retiredAfterWrite;

				updateStatusIndicator(ctx);

				return {
					content: [
						{ type: "text", text: `Todo list updated:\n${buildSummary()}` },
					],
					details: { items: todoList.items.length },
				};
			}

			// ── set_status ──
			if (action === "set_status") {
				if (
					!params.id ||
					!params.status ||
					!["pending", "in_progress", "completed"].includes(params.status)
				) {
					return invalidParams("set_status requires id and status");
				}
				const id = params.id;
				const item = todoList.items.find((i) => i.id === id);
				if (!item) {
					return {
						content: [{ type: "text", text: `Todo item ${id} not found` }],
						details: { error: "not found" },
					};
				}

				const newStatus = params.status;
				let warningNote = "";
				let unmetDeps: string[] = [];

				// Check deps before setting in_progress
				if (newStatus === "in_progress") {
					unmetDeps = checkDeps(todoList, item);
					if (unmetDeps.length > 0) {
						// strictDeps blocks the transition; otherwise warn and proceed.
						if (config.strictDeps) {
							return {
								content: [
									{
										type: "text",
										text:
											`Blocked: ${id} has unmet dependencies: ${unmetDeps.join(", ")}. ` +
											`Complete those first, or set strictDeps: false in config.`,
									},
								],
								details: { error: "unmet deps", unmetDeps },
							};
						}
						warningNote =
							`\nWarning: unmet dependencies: ${unmetDeps.join(", ")} ` +
							`(strictDeps is off, proceeding).`;
					}

					// Move previous in_progress to pending
					for (const i of todoList.items) {
						if (i.id !== id && i.status === "in_progress") {
							i.status = "pending";
						}
					}
				}

				item.status = newStatus;
				if (params.nextStep !== undefined) {
					if (!item.detail) item.detail = {};
					item.detail.nextStep = params.nextStep;
				}

				saveState();

				const retired = handleRetire(ctx);
				if (retired) return retired;

				updateStatusIndicator(ctx);

				return {
					content: [
						{
							type: "text",
							text: `${id}: ${item.headline} → ${newStatus}${warningNote}`,
						},
					],
					details: {
						id,
						status: newStatus,
						...(unmetDeps.length > 0 ? { warning: "unmet deps", unmetDeps } : {}),
					},
				};
			}

			// ── get ──
			if (action === "get") {
				if (!params.id) return invalidParams("get requires id");
				const id = params.id;
				const item = todoList.items.find((i) => i.id === id);
				if (!item) {
					return {
						content: [{ type: "text", text: `Todo item ${id} not found` }],
						details: { error: "not found" },
					};
				}

				const lines: string[] = [
					`## ${item.id}: ${item.headline}`,
					`Status: ${item.status}`,
				];

				if (item.detail) {
					const d = item.detail;
					if (d.definitionOfDone)
						lines.push(`definitionOfDone: ${d.definitionOfDone}`);
					if (d.constraints?.length)
						lines.push(`constraints: ${d.constraints.join("; ")}`);
					if (d.refs?.length) lines.push(`refs: ${d.refs.join(", ")}`);
					if (d.deps?.length) lines.push(`deps: ${d.deps.join(", ")}`);
					if (d.rationale) lines.push(`rationale: ${d.rationale}`);
					if (d.nextStep) lines.push(`nextStep: ${d.nextStep}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { item },
				};
			}

			// ── list ──
			if (action === "list") {
				if (todoList.items.length === 0) {
					return {
						content: [{ type: "text", text: "No todos" }],
						details: { items: [] },
					};
				}

				return {
					content: [{ type: "text", text: buildSummary() }],
					details: {
						items: todoList.items.map((i) => ({
							id: i.id,
							headline: i.headline,
							status: i.status,
						})),
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: { error: "unknown action" },
			};
		},
	});

	// ─── /todo command (user inspection) ────────────────────────────────────

	pi.registerCommand("todo", {
		description: "View and manage todo items",
		getArgumentCompletions: (prefix: string) => {
			const actions = ["list", "detail", "clear"];
			const items = actions.map((a) => ({ value: a, label: a }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				if (todoList.items.length === 0) {
					ctx.ui.notify("No todos", "info");
					return;
				}
				const text = todoList.items
					.map((i) => {
						const icon =
							i.status === "completed"
								? "✅"
								: i.status === "in_progress"
									? "▶️"
									: "⬜";
						return `${icon} ${i.id}: ${i.headline}`;
					})
					.join("\n");
				ctx.ui.setEditorText(text);
				return;
			}

			if (args === "clear") {
				const ok = await ctx.ui.confirm("Clear todos", "Clear all todos?");
				if (ok) {
					todoList = { items: [] };
					saveState();
					ctx.ui.setStatus("pi-todo", undefined);
					ctx.ui.notify("Todos cleared", "info");
				}
				return;
			}

			if (args === "detail") {
				await showTodoDetail(ctx);
				return;
			}

			if (args === "list") {
				await showTodoList(ctx);
				return;
			}

			// Default: show list view
			await showTodoList(ctx);
		},
	});

	// ─── UI Components ──────────────────────────────────────────────────────

	async function showTodoList(ctx: ExtensionContext) {
		if (todoList.items.length === 0) {
			ctx.ui.notify("No todos. Ask the agent to create some.", "info");
			return;
		}

		await ctx.ui.custom<void>((_tui, theme, _kb, close) => {
			const container = new Container();

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);

			const doneCount = todoList.items.filter(
				(i) => i.status === "completed",
			).length;
			const total = todoList.items.length;
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(` Todos (${doneCount}/${total})`)),
					1,
					0,
				),
			);

			container.addChild(new Spacer(1));

			for (const item of todoList.items) {
				const icon =
					item.status === "completed"
						? theme.fg("success", "✅")
						: item.status === "in_progress"
							? theme.fg("accent", "▶️")
							: theme.fg("dim", "⬜");
				const id = theme.fg("accent", item.id);
				const text =
					item.status === "completed"
						? theme.fg("dim", item.headline)
						: theme.fg("text", item.headline);
				container.addChild(new Text(`${icon} ${id} ${text}`, 2, 0));
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("dim", "Press Escape to close • /todo detail for full view"),
					1,
					0,
				),
			);
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						close();
					}
				},
			};
		});
	}

	async function showTodoDetail(ctx: ExtensionContext) {
		if (todoList.items.length === 0) {
			ctx.ui.notify("No todos", "info");
			return;
		}

		const items: SelectItem[] = todoList.items.map((item) => {
			const icon =
				item.status === "completed"
					? "✅"
					: item.status === "in_progress"
						? "▶️"
						: "⬜";
			return {
				value: item.id,
				label: `${icon} ${item.id}: ${item.headline}`,
				description: item.status,
			};
		});

		const selectedId = await ctx.ui.custom<string | null>(
			(tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);
				container.addChild(
					new Text(theme.fg("accent", theme.bold(" Select Todo Item")), 1, 0),
				);
				container.addChild(new Spacer(1));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
						1,
						0,
					),
				);
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
		);

		if (!selectedId) return;

		const item = todoList.items.find((i) => i.id === selectedId);
		if (!item) return;

		await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
			const container = new Container();

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(` ${item.id}: ${item.headline}`)),
					1,
					0,
				),
			);
			container.addChild(
				new Text(theme.fg("muted", `Status: ${item.status}`), 2, 0),
			);
			container.addChild(new Spacer(1));

			if (item.detail) {
				const d = item.detail;
				if (d.definitionOfDone) {
					container.addChild(
						new Text(
							theme.fg("text", `definitionOfDone: ${d.definitionOfDone}`),
							2,
							0,
						),
					);
				}
				if (d.constraints?.length) {
					for (const c of d.constraints) {
						container.addChild(
							new Text(theme.fg("warning", `constraints: ${c}`), 2, 0),
						);
					}
				}
				if (d.refs?.length) {
					for (const r of d.refs) {
						container.addChild(
							new Text(theme.fg("mdLink", `refs: ${r}`), 2, 0),
						);
					}
				}
				if (d.deps?.length) {
					for (const dep of d.deps) {
						container.addChild(
							new Text(theme.fg("accent", `deps: ${dep}`), 2, 0),
						);
					}
				}
				if (d.rationale) {
					container.addChild(
						new Text(theme.fg("dim", `rationale: ${d.rationale}`), 2, 0),
					);
				}
				if (d.nextStep) {
					container.addChild(
						new Text(theme.fg("success", `nextStep: ${d.nextStep}`), 2, 0),
					);
				}
			} else {
				container.addChild(new Text(theme.fg("dim", "No detail"), 2, 0));
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "Press Escape to close"), 1, 0),
			);
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done();
					}
				},
			};
		});
	}
}
