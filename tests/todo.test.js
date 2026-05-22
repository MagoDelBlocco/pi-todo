/**
 * Tests for pi-todo core logic (parse, serialize, recitation, deps).
 *
 * Run with: node --test tests/todo.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseTodoList,
	serializeTodoList,
	buildRecitation,
	checkDeps,
	enforceSingleInProgress,
	DEFAULT_CONFIG,
} from "../lib.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function item(id, headline, status, detail) {
	return { id, headline, status, detail: detail ?? {} };
}

function list(...items) {
	return { items };
}

// ─── Serialize ────────────────────────────────────────────────────────────────

describe("serializeTodoList", () => {
	it("empty list produces header only", () => {
		const md = serializeTodoList(list());
		assert.ok(md.startsWith("# Todo List"));
		assert.equal(md.split("\n").filter((l) => l.startsWith("-")).length, 0);
	});

	it("serializes pending items with [ ] marker", () => {
		const md = serializeTodoList(list(item("t1", "Do thing", "pending")));
		assert.ok(md.includes("- [ ] t1: Do thing"));
	});

	it("serializes in_progress items with [>] marker", () => {
		const md = serializeTodoList(
			list(item("t2", "Working on it", "in_progress")),
		);
		assert.ok(md.includes("- [>] t2: Working on it"));
	});

	it("serializes completed items with [x] marker", () => {
		const md = serializeTodoList(list(item("t3", "Done", "completed")));
		assert.ok(md.includes("- [x] t3: Done"));
	});

	it("serializes all detail fields", () => {
		const md = serializeTodoList(
			list(
				item("t1", "Test", "pending", {
					definitionOfDone: "Works",
					constraints: ["fast", "safe"],
					refs: ["src/main.ts"],
					deps: ["t0"],
					rationale: "Needed for v2",
					nextStep: "Write tests",
				}),
			),
		);
		assert.ok(md.includes("definitionOfDone: Works"));
		assert.ok(md.includes("constraints: fast"));
		assert.ok(md.includes("constraints: safe"));
		assert.ok(md.includes("refs: src/main.ts"));
		assert.ok(md.includes("deps: t0"));
		assert.ok(md.includes("rationale: Needed for v2"));
		assert.ok(md.includes("nextStep: Write tests"));
	});

	it("skips empty detail fields", () => {
		const md = serializeTodoList(list(item("t1", "Test", "pending", {})));
		assert.ok(!md.includes("definitionOfDone"));
		assert.ok(!md.includes("constraints"));
	});

	it("serializes multiple items in order", () => {
		const md = serializeTodoList(
			list(
				item("t1", "First", "pending"),
				item("t2", "Second", "in_progress"),
				item("t3", "Third", "completed"),
			),
		);
		const t1Idx = md.indexOf("t1");
		const t2Idx = md.indexOf("t2");
		const t3Idx = md.indexOf("t3");
		assert.ok(t1Idx < t2Idx && t2Idx < t3Idx);
	});
});

// ─── Parse ────────────────────────────────────────────────────────────────────

describe("parseTodoList", () => {
	it("empty content produces empty list", () => {
		const result = parseTodoList("");
		assert.equal(result.items.length, 0);
	});

	it("parses pending items", () => {
		const result = parseTodoList("- [ ] t1: Do thing\n");
		assert.equal(result.items.length, 1);
		assert.equal(result.items[0].id, "t1");
		assert.equal(result.items[0].headline, "Do thing");
		assert.equal(result.items[0].status, "pending");
	});

	it("parses in_progress items", () => {
		const result = parseTodoList("- [>] t2: Working\n");
		assert.equal(result.items[0].status, "in_progress");
	});

	it("parses completed items", () => {
		const result = parseTodoList("- [x] t3: Done\n");
		assert.equal(result.items[0].status, "completed");
	});

	it("parses detail fields", () => {
		const content = [
			"- [ ] t1: Test",
			"  - definitionOfDone: Works",
			"  - constraints: fast",
			"  - constraints: safe",
			"  - refs: src/main.ts",
			"  - deps: t0",
			"  - rationale: Needed",
			"  - nextStep: Write tests",
			"",
		].join("\n");

		const result = parseTodoList(content);
		const d = result.items[0].detail;
		assert.equal(d.definitionOfDone, "Works");
		assert.deepEqual(d.constraints, ["fast", "safe"]);
		assert.deepEqual(d.refs, ["src/main.ts"]);
		assert.deepEqual(d.deps, ["t0"]);
		assert.equal(d.rationale, "Needed");
		assert.equal(d.nextStep, "Write tests");
	});

	it("parses multiple items", () => {
		const content = [
			"- [ ] t1: First",
			"- [>] t2: Second",
			"- [x] t3: Third",
			"",
		].join("\n");

		const result = parseTodoList(content);
		assert.equal(result.items.length, 3);
		assert.equal(result.items[0].status, "pending");
		assert.equal(result.items[1].status, "in_progress");
		assert.equal(result.items[2].status, "completed");
	});

	it("ignores non-matching lines", () => {
		const content = [
			"# Todo List",
			"",
			"- [ ] t1: Item",
			"some random text",
			"",
		].join("\n");

		const result = parseTodoList(content);
		assert.equal(result.items.length, 1);
	});
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe("round-trip (serialize → parse)", () => {
	it("preserves all fields for a single item", () => {
		const original = list(
			item("t1", "Test item", "in_progress", {
				definitionOfDone: "It works",
				constraints: ["no deps"],
				refs: ["lib.ts"],
				deps: ["t0"],
				rationale: "Core feature",
				nextStep: "Ship it",
			}),
		);

		const parsed = parseTodoList(serializeTodoList(original));
		assert.equal(parsed.items.length, 1);
		assert.equal(parsed.items[0].id, "t1");
		assert.equal(parsed.items[0].headline, "Test item");
		assert.equal(parsed.items[0].status, "in_progress");
		assert.equal(parsed.items[0].detail.definitionOfDone, "It works");
		assert.deepEqual(parsed.items[0].detail.constraints, ["no deps"]);
		assert.deepEqual(parsed.items[0].detail.refs, ["lib.ts"]);
		assert.deepEqual(parsed.items[0].detail.deps, ["t0"]);
		assert.equal(parsed.items[0].detail.rationale, "Core feature");
		assert.equal(parsed.items[0].detail.nextStep, "Ship it");
	});

	it("preserves multiple items with mixed statuses", () => {
		const original = list(
			item("t1", "First", "pending"),
			item("t2", "Second", "in_progress"),
			item("t3", "Third", "completed"),
		);

		const parsed = parseTodoList(serializeTodoList(original));
		assert.equal(parsed.items.length, 3);
		assert.equal(parsed.items[0].status, "pending");
		assert.equal(parsed.items[1].status, "in_progress");
		assert.equal(parsed.items[2].status, "completed");
	});

	it("preserves empty list", () => {
		const parsed = parseTodoList(serializeTodoList(list()));
		assert.equal(parsed.items.length, 0);
	});
});

// ─── Recitation ───────────────────────────────────────────────────────────────

describe("buildRecitation", () => {
	it("returns empty string for empty list", () => {
		assert.equal(buildRecitation(list(), DEFAULT_CONFIG), "");
	});

	it("includes header and items", () => {
		const rec = buildRecitation(
			list(item("t1", "Do thing", "pending")),
			DEFAULT_CONFIG,
		);
		assert.ok(rec.includes("## Active Todo List"));
		assert.ok(rec.includes("t1: Do thing"));
	});

	it("includes short-list lookahead nextStep", () => {
		const rec = buildRecitation(
			list(item("t1", "Do thing", "pending", { nextStep: "Start coding" })),
			DEFAULT_CONFIG,
		);
		assert.ok(rec.includes("→ Start coding"));
	});

	it("skips nextStep for completed items in lookahead", () => {
		const rec = buildRecitation(
			list(item("t1", "Done", "completed", { nextStep: "Should not appear" })),
			DEFAULT_CONFIG,
		);
		assert.ok(!rec.includes("Should not appear"));
	});

	it("includes full detail section for in_progress item", () => {
		const rec = buildRecitation(
			list(
				item("t1", "Active", "in_progress", {
					definitionOfDone: "Works",
					constraints: ["fast"],
					refs: ["a.ts"],
					deps: ["t0"],
					rationale: "Core",
					nextStep: "Ship",
				}),
			),
			DEFAULT_CONFIG,
		);
		assert.ok(rec.includes("### Detail: t1 (Active)"));
		assert.ok(rec.includes("**DoD**: Works"));
		assert.ok(rec.includes("**Constraints**: fast"));
		assert.ok(rec.includes("**Refs**: a.ts"));
		assert.ok(rec.includes("**Deps**: t0"));
		assert.ok(rec.includes("**Rationale**: Core"));
		assert.ok(rec.includes("**Next**: Ship"));
	});

	it("does not include detail section when no in_progress item", () => {
		const rec = buildRecitation(
			list(item("t1", "Pending", "pending")),
			DEFAULT_CONFIG,
		);
		assert.ok(!rec.includes("### Detail"));
	});

	it("disables lookahead when list exceeds threshold", () => {
		const config = { ...DEFAULT_CONFIG, shortListThreshold: 2 };
		const items = [
			item("t1", "A", "pending", { nextStep: "s1" }),
			item("t2", "B", "pending", { nextStep: "s2" }),
			item("t3", "C", "pending", { nextStep: "s3" }),
		];
		const rec = buildRecitation(list(...items), config);
		assert.ok(!rec.includes("→ s1"));
		assert.ok(!rec.includes("→ s2"));
		assert.ok(!rec.includes("→ s3"));
	});

	it("disables lookahead when nextStep exceeds max length", () => {
		const longStep = "x".repeat(130);
		const rec = buildRecitation(
			list(item("t1", "A", "pending", { nextStep: longStep })),
			DEFAULT_CONFIG,
		);
		assert.ok(!rec.includes("→"));
	});
});

// ─── Dependency Checking ──────────────────────────────────────────────────────

describe("checkDeps", () => {
	it("returns empty array when no deps", () => {
		const listObj = list(item("t1", "A", "pending"));
		assert.deepEqual(checkDeps(listObj, listObj.items[0]), []);
	});

	it("returns empty array when all deps completed", () => {
		const listObj = list(
			item("t0", "Done", "completed"),
			item("t1", "A", "pending", { deps: ["t0"] }),
		);
		assert.deepEqual(checkDeps(listObj, listObj.items[1]), []);
	});

	it("returns unmet dep IDs", () => {
		const listObj = list(
			item("t0", "Pending", "pending"),
			item("t1", "A", "pending", { deps: ["t0"] }),
		);
		assert.deepEqual(checkDeps(listObj, listObj.items[1]), ["t0"]);
	});

	it("returns multiple unmet deps", () => {
		const listObj = list(
			item("t0", "Pending", "pending"),
			item("t2", "Pending", "pending"),
			item("t1", "A", "pending", { deps: ["t0", "t2"] }),
		);
		assert.deepEqual(checkDeps(listObj, listObj.items[2]), ["t0", "t2"]);
	});

	it("ignores non-existent dep IDs (treated as unmet)", () => {
		const listObj = list(item("t1", "A", "pending", { deps: ["t999"] }));
		assert.deepEqual(checkDeps(listObj, listObj.items[0]), ["t999"]);
	});

	it("partial completion: only unmet deps returned", () => {
		const listObj = list(
			item("t0", "Done", "completed"),
			item("t2", "Pending", "pending"),
			item("t1", "A", "pending", { deps: ["t0", "t2"] }),
		);
		assert.deepEqual(checkDeps(listObj, listObj.items[2]), ["t2"]);
	});
});

// ─── Invariant Enforcement ────────────────────────────────────────────────────

describe("enforceSingleInProgress", () => {
	it("does nothing when no in_progress items", () => {
		const listObj = list(
			item("t1", "A", "pending"),
			item("t2", "B", "completed"),
		);
		enforceSingleInProgress(listObj);
		assert.equal(listObj.items[0].status, "pending");
		assert.equal(listObj.items[1].status, "completed");
	});

	it("keeps single in_progress", () => {
		const listObj = list(
			item("t1", "A", "pending"),
			item("t2", "B", "in_progress"),
			item("t3", "C", "completed"),
		);
		enforceSingleInProgress(listObj);
		assert.equal(listObj.items[1].status, "in_progress");
	});

	it("reverts extra in_progress to pending (keeps first)", () => {
		const listObj = list(
			item("t1", "A", "in_progress"),
			item("t2", "B", "in_progress"),
			item("t3", "C", "in_progress"),
		);
		enforceSingleInProgress(listObj);
		assert.equal(listObj.items[0].status, "in_progress");
		assert.equal(listObj.items[1].status, "pending");
		assert.equal(listObj.items[2].status, "pending");
	});
});
