/**
 * pi-todo — Stateful to-do extension for pi.
 *
 * Two surfaces:
 *  1. Recited list (compact, injected every turn via the `context` event)
 *  2. Per-item detail (addressable via todo_get, full detail only for in_progress)
 *
 * Persistence: .pi/pi-todo.md (project-local markdown file).
 * UI: persistent top-right overlay panel (auto-shows/hides with todo state).
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
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type TodoItem,
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

// ─── Persistent Overlay Component ─────────────────────────────────────────────

/**
 * Compact todo panel rendered as a right-anchored overlay.
 * Auto-hides when there are no todos.
 */
class TodoOverlay implements Component {
	private items: TodoItem[];
	private theme: Theme;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(items: TodoItem[], theme: Theme) {
		this.items = items;
		this.theme = theme;
	}

	/** Update items in-place (avoids recreating the component) */
	update(items: TodoItem[]): void {
		this.items = items;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];

		// Top border with title
		const title = th.fg("accent", " TODO ");
		const remaining = Math.max(0, width - 9);
		lines.push(
			th.fg("borderMuted", "╭─") +
				title +
				th.fg("borderMuted", "─".repeat(remaining) + "╮"),
		);

		const done = this.items.filter((i) => i.status === "completed").length;
		const total = this.items.length;
		lines.push(
			th.fg("borderMuted", "│ ") +
				th.fg("dim", truncateToWidth(`${done}/${total}`, width - 4, "", true)) +
				th.fg("borderMuted", " │"),
		);

		for (const item of this.items) {
			const icon =
				item.status === "completed"
					? th.fg("success", "✅")
					: item.status === "in_progress"
						? th.fg("accent", "▶")
						: th.fg("dim", "○");
			const id = th.fg("accent", item.id);
			const text =
				item.status === "completed"
					? th.fg("dim", item.headline)
					: th.fg("text", item.headline);
			const line = `${icon} ${id} ${text}`;
			const padded = truncateToWidth(line, width - 4, "", true);
			lines.push(
				th.fg("borderMuted", "│ ") + padded + th.fg("borderMuted", " │"),
			);
		}

		// Bottom border
		const bottomInner = Math.max(0, width - 2);
		lines.push(th.fg("borderMuted", "╰" + "─".repeat(bottomInner) + "╯"));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let todoList: TodoList = { items: [] };
	const config: TodoConfig = { ...DEFAULT_CONFIG };
	let cwd: string = "";

	// Persistent overlay state
	let overlayHandle: OverlayHandle | null = null;
	let overlayTui: TUI | null = null;
	let overlayComponent: TodoOverlay | null = null;

	/** Load from file and set in-memory state */
	const loadState = (ctx: ExtensionContext) => {
		cwd = ctx.cwd;
		todoList = loadTodoList(cwd);
	};

	/** Save in-memory state to file */
	const saveState = () => {
		if (cwd) saveTodoList(cwd, todoList);
	};

	/** Refresh the overlay panel with current state. Creates it if needed. */
	const refreshOverlay = (ctx?: ExtensionContext) => {
		if (todoList.items.length === 0) {
			if (overlayHandle) {
				overlayHandle.hide();
				overlayHandle = null;
			}
			overlayTui = null;
			overlayComponent = null;
		} else if (overlayComponent && overlayTui) {
			// Overlay exists — update in place
			overlayComponent.update(todoList.items);
			overlayTui.requestRender();
		} else if (ctx && ctx.hasUI) {
			// No overlay yet — create one
			ctx.ui.custom<void>(
				(tui, theme, _kb, _done) => {
					overlayTui = tui;
					overlayComponent = new TodoOverlay(todoList.items, theme);
					return overlayComponent;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right" as const,
						width: "40%",
						minWidth: 30,
						margin: 1,
						nonCapturing: true,
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			);
		}
	};

	// ─── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx);
		enforceSingleInProgress(todoList);

		// Show persistent overlay + status indicator if there are todos.
		refreshOverlay(ctx);
		if (todoList.items.length > 0) updateStatusIndicator(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (cwd) saveState();
		if (overlayHandle) {
			overlayHandle.hide();
			overlayHandle = null;
		}
		overlayTui = null;
		overlayComponent = null;
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
			refreshOverlay(ctx);
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				if (params.replaceAll) {
					todoList = { items: [] };
				}

				for (const newItem of params.items ?? []) {
					if (newItem.status === "in_progress") {
						for (const item of todoList.items) {
							if (item.id !== newItem.id && item.status === "in_progress") {
								item.status = "pending";
							}
						}
					}
					const existing = todoList.items.find((i) => i.id === newItem.id);
					if (existing) {
						if (newItem.headline) existing.headline = newItem.headline;
						if (newItem.status) existing.status = newItem.status;
						if (newItem.detail) {
							existing.detail = { ...existing.detail, ...newItem.detail };
						}
					} else {
						todoList.items.push({
							id: newItem.id,
							headline: newItem.headline,
							status: newItem.status ?? "pending",
							detail: newItem.detail ?? {},
						});
					}
				}

				enforceSingleInProgress(todoList);
				saveState();
				refreshOverlay(ctx);

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
				refreshOverlay(ctx);

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
					refreshOverlay(ctx);
					ctx.ui.setStatus("pi-todo", undefined);
					ctx.ui.notify("Todos cleared", "info");
				}
				return;
			}

			if (args === "detail" || args === "list") {
				await showTodoDetail(ctx, args === "detail");
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

	async function showTodoDetail(ctx: ExtensionContext, _showAll: boolean) {
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
