/**
 * Pure logic for pi-todo — parse, serialize, recitation, deps.
 * Extracted so it can be tested independently of the pi extension API.
 */

// ─── Data Model ───────────────────────────────────────────────────────────────

export type Status = "pending" | "in_progress" | "completed";

export interface TodoDetail {
	definitionOfDone?: string;
	constraints?: string[];
	refs?: string[];
	deps?: string[];
	rationale?: string;
	nextStep?: string;
}

export interface TodoItem {
	id: string;
	headline: string;
	status: Status;
	detail?: TodoDetail;
}

export interface TodoList {
	items: TodoItem[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface TodoConfig {
	strictDeps: boolean;
	shortListThreshold: number;
	shortDetailMaxLen: number;
}

export const DEFAULT_CONFIG: TodoConfig = {
	strictDeps: false,
	shortListThreshold: 5,
	shortDetailMaxLen: 120,
};

// ─── Serialize ────────────────────────────────────────────────────────────────

/**
 * Serialize a TodoList to markdown.
 */
export function serializeTodoList(list: TodoList): string {
	const lines: string[] = ["# Todo List", ""];

	for (const item of list.items) {
		const marker =
			item.status === "completed"
				? "[x]"
				: item.status === "in_progress"
					? "[>]"
					: "[ ]";
		lines.push(`- ${marker} ${item.id}: ${item.headline}`);

		if (item.detail) {
			const d = item.detail;
			if (d.definitionOfDone)
				lines.push(`  - definitionOfDone: ${d.definitionOfDone}`);
			if (d.constraints?.length) {
				for (const c of d.constraints) lines.push(`  - constraints: ${c}`);
			}
			if (d.refs?.length) {
				for (const r of d.refs) lines.push(`  - refs: ${r}`);
			}
			if (d.deps?.length) {
				for (const dep of d.deps) lines.push(`  - deps: ${dep}`);
			}
			if (d.rationale) lines.push(`  - rationale: ${d.rationale}`);
			if (d.nextStep) lines.push(`  - nextStep: ${d.nextStep}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a markdown todo file back into a TodoList.
 */
export function parseTodoList(content: string): TodoList {
	const items: TodoItem[] = [];
	const lines = content.split("\n");
	let current: TodoItem | null = null;

	for (const rawLine of lines) {
		const line = rawLine;

		// Match todo item line: "- [x] t1: headline" or "- [>] t1: headline" or "- [ ] t1: headline"
		const itemMatch = line.match(/^-\s+\[([x> ])\]\s+(\S+):\s+(.+)$/);
		if (itemMatch) {
			if (current) items.push(current);
			const marker = itemMatch[1];
			const status: Status =
				marker === "x"
					? "completed"
					: marker === ">"
						? "in_progress"
						: "pending";
			current = {
				id: itemMatch[2],
				headline: itemMatch[3],
				status,
				detail: {},
			};
			continue;
		}

		// Match detail sub-bullet: "  - key: value"
		if (current) {
			const detailMatch = line.match(/^\s+-\s+(\w+):\s+(.+)$/);
			if (detailMatch) {
				const key = detailMatch[1] as keyof TodoDetail;
				const value = detailMatch[2];
				if (!current.detail) current.detail = {};
				if (key === "constraints" || key === "refs" || key === "deps") {
					const arr = current.detail[key] as string[] | undefined;
					if (arr) {
						arr.push(value);
					} else {
						(current.detail as any)[key] = [value];
					}
				} else {
					(current.detail as any)[key] = value;
				}
			}
		}
	}

	if (current) items.push(current);
	return { items };
}

// ─── Recitation ───────────────────────────────────────────────────────────────

/**
 * Build the recited block for injection into context.
 * Compact list + active item detail (or short-list lookahead).
 */
export function buildRecitation(list: TodoList, config: TodoConfig): string {
	if (list.items.length === 0) return "";

	const lines: string[] = ["## Active Todo List"];

	const inProgress = list.items.find((i) => i.status === "in_progress");

	// Short-list lookahead: when list is small and details are terse
	const useLookahead =
		list.items.length <= config.shortListThreshold &&
		list.items.every(
			(item) =>
				!item.detail ||
				!item.detail.nextStep ||
				item.detail.nextStep.length <= config.shortDetailMaxLen,
		);

	for (const item of list.items) {
		const icon =
			item.status === "completed"
				? "✅"
				: item.status === "in_progress"
					? "▶️"
					: "⬜";
		lines.push(`${icon} ${item.id}: ${item.headline}`);

		// Inline nextStep for short lists
		if (useLookahead && item.detail?.nextStep && item.status !== "completed") {
			lines.push(`  → ${item.detail.nextStep}`);
		}
	}

	// Full detail for in_progress item
	if (inProgress?.detail) {
		lines.push("");
		lines.push(`### Detail: ${inProgress.id} (${inProgress.headline})`);
		const d = inProgress.detail;
		if (d.definitionOfDone) lines.push(`- **DoD**: ${d.definitionOfDone}`);
		if (d.constraints?.length)
			lines.push(`- **Constraints**: ${d.constraints.join("; ")}`);
		if (d.refs?.length) lines.push(`- **Refs**: ${d.refs.join(", ")}`);
		if (d.deps?.length) lines.push(`- **Deps**: ${d.deps.join(", ")}`);
		if (d.rationale) lines.push(`- **Rationale**: ${d.rationale}`);
		if (d.nextStep) lines.push(`- **Next**: ${d.nextStep}`);
	}

	lines.push("");
	return lines.join("\n");
}

// ─── Dependency Checking ──────────────────────────────────────────────────────

/** Check deps for an item. Returns unmet dep IDs or empty array. */
export function checkDeps(list: TodoList, item: TodoItem): string[] {
	if (!item.detail?.deps?.length) return [];
	const completedIds = new Set(
		list.items.filter((i) => i.status === "completed").map((i) => i.id),
	);
	return item.detail.deps.filter((dep) => !completedIds.has(dep));
}

// ─── Invariant Enforcement ────────────────────────────────────────────────────

/** Enforce single in_progress invariant. Mutates list in place. */
export function enforceSingleInProgress(list: TodoList): void {
	const inProgressIds = list.items
		.filter((i) => i.status === "in_progress")
		.map((i) => i.id);
	if (inProgressIds.length > 1) {
		for (let i = 1; i < inProgressIds.length; i++) {
			const item = list.items.find((it) => it.id === inProgressIds[i]);
			if (item) item.status = "pending";
		}
	}
}
