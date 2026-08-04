import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

import type { ToolComponentLike } from "../extensions/_shared/runtime/tool-grouping.ts";
import { requirePresent } from "../extensions/_shared/runtime/require-present.ts";


const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});
const grouping = await jiti.import<typeof import("../extensions/_shared/runtime/tool-grouping.ts")>(
	"../extensions/_shared/runtime/tool-grouping.ts",
);
const tui = await jiti.import<{ visibleWidth: (text: string) => number }>("@earendil-works/pi-tui");
const {
	formatDoneLineSpacing,
	planToolGroups,
	renderPlannedChildren,
	resolveTodoGrouping,
	resolveToolGrouping,
} = grouping;

function tool(
	toolName: string,
	id: string,
	args: Record<string, unknown>,
	text = `${id} result`,
	isError = false,
): ToolComponentLike {
	return {
		toolName,
		toolCallId: id,
		args,
		expanded: false,
		result: { content: [{ type: "text", text }], isError },
		render() {
			const target = toolName === "grep" || toolName === "find"
				? args.pattern ?? args.path ?? ""
				: toolName === "bash"
					? args.command ?? ""
					: toolName === "todo"
						? args.subject ?? args.action ?? ""
						: args.path ?? args.pattern ?? "";
			return [`⏺ ${toolName}(${target})`, `  ⎿ ${isError ? "ERROR: " : ""}${text}`];
		},
	};
}

test("Read, Read, Read becomes one Read group", () => {
	const children = [
		tool("read", "r1", { path: "src/a.py" }),
		tool("read", "r2", { path: "src/b.py" }),
		tool("read", "r3", { path: "tests/test_a.py" }),
	];
	const plan = planToolGroups(children, "consecutive-same-type");
	assert.equal(plan.length, 1);
	assert.equal(plan[0]?.kind, "group");
	assert.match(renderPlannedChildren(children, "consecutive-same-type", 120).join("\n"), /Read 3 files/);
	assert.deepEqual(
		(renderPlannedChildren(children, "consecutive-same-type", 120).join("\n").match(/src\/a\.py|src\/b\.py|tests\/test_a\.py/g)),
		["src/a.py", "src/b.py", "tests/test_a.py"],
	);
});

test("Read, Grep, Read stays as three groups", () => {
	const children = [
		tool("read", "r1", { path: "a.py" }),
		tool("grep", "g1", { pattern: "router", path: "src" }),
		tool("read", "r2", { path: "b.py" }),
	];
	assert.deepEqual(
		planToolGroups(children, "consecutive-same-type").map((item) => item.kind),
		["single", "single", "single"],
	);
});

test("Read x3, Grep x2, Find x1 becomes separate same-type groups", () => {
	const children = [
		tool("read", "r1", { path: "a.py" }),
		tool("read", "r2", { path: "b.py" }),
		tool("read", "r3", { path: "c.py" }),
		tool("grep", "g1", { pattern: "router", path: "src" }),
		tool("grep", "g2", { pattern: "handler", path: "src" }),
		tool("find", "f1", { pattern: "*.py", path: "tests" }),
	];
	const plan = planToolGroups(children, "consecutive-same-type");
	assert.deepEqual(
		plan.map((item) => item.kind === "group" ? `${item.toolName}:${item.children.length}` : item.child.toolName),
		["read:3", "grep:2", "find"],
	);
	const collapsed = renderPlannedChildren(children, "consecutive-same-type", 120).join("\n");
	assert.match(collapsed, /Read 3 files/);
	assert.match(collapsed, /Grep 2 patterns/);
	assert.match(collapsed, /find\(\*\.py\)/);
	assert.doesNotMatch(collapsed, /Listing directories|Inspecting app routes|Searching project files/);
});

test("a failed Read ends the successful Read run and stays visible", () => {
	const children = [
		tool("read", "r1", { path: "ok.py" }, "ok"),
		tool("read", "r2", { path: "missing.py" }, "not found", true),
	];
	const plan = planToolGroups(children, "consecutive-same-type");
	assert.deepEqual(plan.map((item) => item.kind), ["single", "single"]);
	assert.match(renderPlannedChildren(children, "consecutive-same-type", 120).join("\n"), /ERROR: not found/);
});

test("Edit, Edit always renders as two independent calls", () => {
	const children = [
		tool("edit", "e1", { path: "a.py" }, "diff a"),
		tool("edit", "e2", { path: "b.py" }, "diff b"),
	];
	assert.deepEqual(
		planToolGroups(children, "consecutive-same-type").map((item) => item.kind),
		["single", "single"],
	);
	assert.equal(renderPlannedChildren(children, "consecutive-same-type", 120).filter((line) => line.startsWith("⏺")).length, 2);
});

test("Ctrl+O expansion restores every real call argument and result", () => {
	const children = [
		tool("read", "r1", { path: "a.py" }, "alpha"),
		tool("read", "r2", { path: "b.py" }, "beta"),
	];
	assert.match(renderPlannedChildren(children, "consecutive-same-type", 120).join("\n"), /Read 2 files/);
	for (const child of children) child.expanded = true;
	const expanded = renderPlannedChildren(children, "consecutive-same-type", 120).join("\n");
	assert.doesNotMatch(expanded, /Read 2 files/);
	assert.match(expanded, /read\(a\.py\)[\s\S]*alpha/);
	assert.match(expanded, /read\(b\.py\)[\s\S]*beta/);
});

test("consecutive Todo calls collapse to one action summary", () => {
	const children = [
		tool("todo", "t1", { action: "create", subject: "Design API" }, "Created #1"),
		tool("todo", "t2", { action: "create", subject: "Build API" }, "Created #2"),
		tool("todo", "t3", { action: "list" }, "Two tasks"),
	];
	const collapsed = renderPlannedChildren(children, "off", 120, () => false, true).join("\n");
	assert.match(collapsed, /Todo 3 calls/);
	assert.match(collapsed, /2 created · 1 listed/);
	assert.doesNotMatch(collapsed, /Design API|Build API/);

	for (const child of children) child.expanded = true;
	const expanded = renderPlannedChildren(children, "off", 120, () => false, true).join("\n");
	assert.doesNotMatch(expanded, /Todo 3 calls/);
	assert.match(expanded, /todo\(Design API\)[\s\S]*Created #1/);
	assert.match(expanded, /todo\(Build API\)[\s\S]*Created #2/);
});

test("failed Todo calls remain visible outside successful Todo groups", () => {
	const failed = tool("todo", "t3", { action: "update" }, "Error: cycle detected");
	requirePresent(failed.result).details = { error: "cycle detected" };
	const children = [
		tool("todo", "t1", { action: "create", subject: "One" }, "Created #1"),
		tool("todo", "t2", { action: "create", subject: "Two" }, "Created #2"),
		failed,
	];
	const plan = planToolGroups(children, "off", () => false, true);
	assert.deepEqual(plan.map((item) => item.kind), ["group", "single"]);
	const rendered = renderPlannedChildren(children, "off", 120, () => false, true).join("\n");
	assert.match(rendered, /Todo 2 calls/);
	assert.match(rendered, /todo\(update\)[\s\S]*Error: cycle detected/);
});

test("planning and rendering do not alter original tool events", () => {
	const children = [
		tool("grep", "g1", { pattern: "one", path: "src" }, "a.py:1"),
		tool("grep", "g2", { pattern: "two", path: "tests" }, "b.py:2"),
	];
	const snapshot = structuredClone(children.map(({ render: _render, ...event }) => event));
	const plan = planToolGroups(children, "consecutive-same-type");
	renderPlannedChildren(children, "consecutive-same-type", 120);
	assert.deepEqual(children.map(({ render: _render, ...event }) => event), snapshot);
	assert.equal(plan[0]?.kind === "group" ? plan[0].children[0] : undefined, children[0]);
	assert.equal(plan[0]?.kind === "group" ? plan[0].children[1] : undefined, children[1]);
});

test("assistant text, Bash, and mutation tools are hard boundaries", () => {
	const body: ToolComponentLike = { render: () => ["assistant body"] };
	const children = [
		tool("read", "r1", { path: "a.py" }),
		body,
		tool("read", "r2", { path: "b.py" }),
		tool("bash", "b1", { command: "pwd" }),
		tool("bash", "b2", { command: "ls" }),
		tool("write", "w1", { path: "c.py" }),
	];
	assert.ok(planToolGroups(children, "consecutive-same-type").every((item) => item.kind === "single"));
});

test("tool output and following assistant text have one visual spacer", () => {
	const body: ToolComponentLike = { render: () => ["● assistant body"] };
	const rendered = renderPlannedChildren(
		[tool("bash", "b1", { command: "pwd" }), body],
		"consecutive-same-type",
		120,
	);
	assert.match(rendered.join("\n"), /b1 result\n\n● assistant body/);
});

test("Done in line has a spacer above and a two-space visual indent", () => {
	const ansi = "\x1b[38;2;140;140;140m";
	const reset = "\x1b[0m";
	assert.deepEqual(
		formatDoneLineSpacing(["● assistant body", `${ansi}Done in 1m 17s${reset}`]),
		["● assistant body", "", `${ansi}  Done in 1m 17s${reset}`],
	);
});

test("empty assistant tool rounds do not split an otherwise consecutive group", () => {
	const emptyToolRound: ToolComponentLike = { render: () => [] };
	const children = [
		tool("read", "r1", { path: "a.py" }),
		emptyToolRound,
		tool("read", "r2", { path: "b.py" }),
		emptyToolRound,
		tool("read", "r3", { path: "c.py" }),
	];
	const isTransparent = (child: ToolComponentLike) => child === emptyToolRound;
	const plan = planToolGroups(children, "consecutive-same-type", isTransparent);
	assert.equal(plan.length, 1);
	assert.equal(plan[0]?.kind, "group");
	assert.match(
		renderPlannedChildren(children, "consecutive-same-type", 120, isTransparent).join("\n"),
		/Read 3 files/,
	);
});

test("new mode defaults and legacy booleans remain compatible", () => {
	assert.equal(resolveTodoGrouping({}), false);
	assert.equal(resolveTodoGrouping({ todoGrouping: true }), true);
	assert.equal(resolveToolGrouping({}), "consecutive-same-type");
	assert.equal(resolveToolGrouping({ readOnlyToolGrouping: false }), "off");
	assert.equal(resolveToolGrouping({ readOnlyToolGrouping: true }), "all-read-only");
	assert.equal(
		resolveToolGrouping({ toolGrouping: "consecutive-same-type", readOnlyToolGrouping: true }),
		"consecutive-same-type",
	);
});

test("grouped tool lines fit the terminal by visible width", () => {
	const children = [
		tool("grep", "g1", { pattern: "列一个计划测试一下|PLAN_MODE_NEW_SESSION_OK|plan…", path: "/Users/test/项目" }),
		tool("grep", "g2", { pattern: "pi-clipboard-7de757fd|没有反应", path: "/Users/test/项目" }),
	];
	for (const width of [0, 1, 12, 111]) {
		const rendered = renderPlannedChildren(children, "consecutive-same-type", width);
		assert.ok(
			rendered.every((line) => tui.visibleWidth(line) <= width),
			`rendered line exceeded width ${width}: ${JSON.stringify(rendered)}`,
		);
	}
});
