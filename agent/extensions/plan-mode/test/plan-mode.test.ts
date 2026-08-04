import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createMockContext, createMockPi } from "./support.js";
import { planModeCompleted } from "../src/completion-tool.js";
import planMode, {
	buildPlanModePrompt,
	completePlanArguments,
	extractProposedPlan,
	latestAssistantText,
	parseProposedPlan,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
} from "../src/plan-mode.js";

async function writePlanModeSettings(directory: string, contents: string) {
	const settingsDirectory = join(directory, "extensions", "plan-mode");
	await mkdir(settingsDirectory, { recursive: true });
	const settingsPath = join(settingsDirectory, "config.json");
	await writeFile(settingsPath, contents);
	return settingsPath;
}

test("plan-mode registers flag, question tool, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	assert.ok(mock.flags.has("plan"));
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["plan_mode_question", "plan_mode_complete"],
	);
	assert.ok(mock.commands.has("plan"));
	assert.equal(typeof mock.commands.get("plan")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("plan_mode_complete result renders the plan as Markdown", () => {
	initTheme("dark");
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
	assert.equal(typeof tool?.renderResult, "function");

	const renderResult = tool?.renderResult as (
		result: unknown,
		options: unknown,
	) => { render(width: number): string[] };
	const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const renderMarkdown = (result: unknown) =>
		renderResult(result, { expanded: false, isPartial: false })
			.render(80)
			.map((line) => line.replace(ansiPattern, ""))
			.join("\n");

	const result = planModeCompleted("# Title\n\n- item\n\n```ts\nconst x = 1;\n```");
	const rendered = renderMarkdown(result);
	assert.match(rendered, /Proposed Plan/);
	assert.match(rendered, /const x = 1;/);
	assert.doesNotMatch(rendered, /\*\*Proposed Plan\*\*/);
	assert.doesNotMatch(rendered, /# Title/);

	const fallback = renderMarkdown({ content: [], details: result.details });
	assert.match(fallback, /Proposed Plan/);
	assert.match(fallback, /const x = 1;/);
});

test("completePlanArguments suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.label),
		["show", "finalize", "implement", "implement-new", "exit", "off", "tools"],
	);
	assert.deepEqual(
		completePlanArguments("to")?.map((item) => item.value),
		["tools"],
	);
	assert.equal(completePlanArguments("tools "), null);
	assert.equal(completePlanArguments("write a plan"), null);
	assert.equal(completePlanArguments("unknown"), null);
});

test("missing settings reset a previously loaded fixed thinking level", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-settings-reset-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsPath = await writePlanModeSettings(directory, '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await unlink(settingsPath);
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(mock.thinkingLevel, "low");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed persisted Plan state fails closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-malformed-state-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const malformedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: "yes",
				awaitingAction: 1,
				selectedToolNames: "read",
				previousThinkingLevel: "extreme",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [malformedState],
				getEntries: () => [malformedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), undefined);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("inherit settings clear stale persisted thinking ownership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-inherit-ownership-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "medium" });
		planMode(mock.pi);
		const inheritedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: true,
				awaitingAction: false,
				previousThinkingLevel: "low",
				appliedThinkingLevel: "medium",
			},
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [inheritedState],
				getEntries: () => [inheritedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session resume restores active Plan state and required tools", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const mock = createMockPi({ activeTools: ["read", "write"] });
		planMode(mock.pi);
		const resumedState = {
			type: "custom",
			customType: "plan-mode-state",
			data: { enabled: true, awaitingAction: true, latestPlan: "# Resumed" },
		};
		const context = createMockContext({
			sessionManager: {
				getBranch: () => [resumedState],
				getEntries: () => [resumedState],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan ready");
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"read",
			"plan_mode_question",
			"plan_mode_complete",
		]);
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("session restore uses only the active branch state", async () => {
	const activeBranch = [
		{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				enabled: true,
				awaitingAction: true,
				latestPlan: "# Active branch",
				latestPlanSource: "plan_mode_complete",
			},
		},
	];
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getBranch: () => activeBranch,
			getEntries: () => [
				...activeBranch,
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: false, awaitingAction: false },
				},
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Active branch/,
	);
});

test("session restore fails closed for malformed persisted completed plans", async () => {
	for (const data of [
		{
			enabled: true,
			awaitingAction: true,
			latestPlan: "  \n",
			latestPlanSource: "plan_mode_complete",
		},
		{
			enabled: true,
			awaitingAction: true,
			latestPlan: "x".repeat(50_001),
			latestPlanSource: "plan_mode_complete",
		},
	]) {
		const mock = createMockPi({ activeTools: ["read"] });
		planMode(mock.pi);
		const context = createMockContext({
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [{ type: "custom", customType: "plan-mode-state", data }],
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		assert.equal(context.statuses.get("plan-mode"), "plan active");
		await mock.commands.get("plan")?.handler("implement", context.ctx);
		assert.equal(mock.sentUserMessages.length, 0);
	}

	const legacy = createMockPi({ activeTools: ["read"] });
	planMode(legacy.pi);
	const legacyContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: {
						enabled: true,
						awaitingAction: true,
						latestPlan: "# Legacy state",
					},
				},
			],
		},
	});
	await legacy.events.get("session_start")?.[0]?.({}, legacyContext.ctx);
	assert.equal(legacyContext.statuses.get("plan-mode"), "plan ready");
});

test("session restore recovers only valid completion details after the latest state", async () => {
	const completion = {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "plan_mode_complete",
			details: {
				version: 1,
				source: "plan_mode_complete",
				plan: "# Recovered",
			},
		},
	};
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				completion,
			],
		},
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.match(
		(mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "",
		/# Recovered/,
	);

	const discarded = createMockPi({ activeTools: ["read"] });
	planMode(discarded.pi);
	const discardedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				completion,
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
			],
		},
	});
	await discarded.events.get("session_start")?.[0]?.({}, discardedContext.ctx);
	assert.equal(discardedContext.statuses.get("plan-mode"), "plan active");

	const malformed = createMockPi({ activeTools: ["read"] });
	planMode(malformed.pi);
	const malformedContext = createMockContext({
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, awaitingAction: false },
				},
				{
					...completion,
					message: {
						...completion.message,
						details: { version: 2, source: "plan_mode_complete", plan: "# Bad" },
					},
				},
			],
		},
	});
	await malformed.events.get("session_start")?.[0]?.({}, malformedContext.ctx);
	assert.equal(malformedContext.statuses.get("plan-mode"), "plan active");
});

test("Plan thinking level restores only while the extension owns the applied value", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writePlanModeSettings(directory, '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read", "bash"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		assert.equal(mock.thinkingLevel, "medium");
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "low");

		await mock.commands.get("plan")?.handler("", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.commands.get("plan")?.handler("exit", context.ctx);
		assert.equal(mock.thinkingLevel, "high");

		const clamped = createMockPi({
			activeTools: ["read"],
			thinkingLevel: "high",
			clampThinkingLevel: (level) => (level === "medium" ? "low" : level),
		});
		planMode(clamped.pi);
		const clampedContext = createMockContext();
		await clamped.events.get("session_start")?.[0]?.({}, clampedContext.ctx);
		await clamped.commands.get("plan")?.handler("", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "low");
		await clamped.commands.get("plan")?.handler("exit", clampedContext.ctx);
		assert.equal(clamped.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan mode restores an intentionally empty active-tool set", async () => {
	const mock = createMockPi({ activeTools: [], allTools: [] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"read",
		"bash",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	await mock.commands.get("plan")?.handler("exit", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), []);
});

test("manual thinking changes survive active Plan-mode shutdown and resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-manual-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writePlanModeSettings(directory, '{"thinkingLevel":"medium"}');
		const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
		planMode(mock.pi);
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);
		await mock.commands.get("plan")?.handler("", context.ctx);
		mock.rawPi.setThinkingLevel("high");
		await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);

		const persisted = mock.entries.at(-1);
		const persistedEntries = persisted ? [{ type: "custom", ...persisted }] : [];
		const resumedContext = createMockContext({
			sessionManager: {
				getBranch: () => persistedEntries,
				getEntries: () => persistedEntries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
		await mock.commands.get("plan")?.handler("exit", resumedContext.ctx);
		assert.equal(mock.thinkingLevel, "high");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Plan lifecycle prefills approval before handing a valid plan to implementation", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "custom"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.deepEqual(mock.sentUserMessages[0], { text: "design it", options: undefined });
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);

	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Ship it\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
	assert.deepEqual(mock.rawPi.getActiveTools(), [
		"bash",
		"read",
		"plan_mode_question",
		"plan_mode_complete",
	]);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");

	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "custom"]);
	assert.match(
		mock.sentUserMessages.at(-1)?.text ?? "",
		/Implement this proposed plan now:\n\n# Ship it/,
	);
	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
});

test("plan implement-new hands the exact plan to a linked replacement session", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash", "write"] });
	planMode(mock.pi);
	let newSessionOptions: Record<string, unknown> | undefined;
	const replacementEntries: Array<{ customType: string; data: unknown }> = [];
	const replacementMessages: string[] = [];
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/parent-session.jsonl",
			getBranch: () => [],
			getEntries: () => [],
		},
		newSession: async (options: Record<string, unknown>) => {
			newSessionOptions = options;
			await (options.setup as (sessionManager: unknown) => Promise<void>)({
				appendCustomEntry(customType: string, data: unknown) {
					replacementEntries.push({ customType, data });
				},
			});
			await (options.withSession as (replacementCtx: unknown) => Promise<void>)({
				async sendUserMessage(message: string) {
					replacementMessages.push(message);
				},
			});
			return { cancelled: false };
		},
	});
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Fresh\n\n- preserve this exact text" }, undefined, undefined, context.ctx);

	await mock.commands.get("plan")?.handler("implement-new", context.ctx);

	assert.equal(newSessionOptions?.parentSession, "/tmp/parent-session.jsonl");
	assert.equal(replacementEntries.length, 1);
	const replacementEntry = replacementEntries[0];
	assert.ok(replacementEntry);
	const implementation = (replacementEntry.data as {
		activeImplementation: { id: string; startedAt: number };
	}).activeImplementation;
	assert.equal(replacementEntry.customType, "plan-mode-state");
	assert.deepEqual(replacementEntry.data, {
		enabled: false,
		awaitingAction: false,
		activeImplementation: {
			id: implementation.id,
			plan: "# Fresh\n\n- preserve this exact text",
			source: "plan_mode_complete",
			startedAt: implementation.startedAt,
		},
	});
	assert.match(implementation.id, /^[A-Za-z0-9-]+$/);
	assert.deepEqual(replacementMessages, [
		"Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n# Fresh\n\n- preserve this exact text",
	]);
	assert.equal(mock.sentUserMessages.length, 0, "the stale parent pi must not send the handoff");
});

test("plan implement-new cancellation leaves the completed plan ready", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/parent-session.jsonl",
			getBranch: () => [],
			getEntries: () => [],
		},
		newSession: async () => ({ cancelled: true }),
	});
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Keep me" }, undefined, undefined, context.ctx);

	await mock.commands.get("plan")?.handler("implement-new", context.ctx);

	assert.match(context.notifications.at(-1)?.message ?? "", /cancelled.*still ready/i);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.match((mock.sentMessages.at(-1)?.message as { content?: string })?.content ?? "", /# Keep me/);
});

test("plan implement-new abandons a stale continuation after session shutdown", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	let releaseIdle: () => void = () => {
		throw new Error("Idle promise was not initialized");
	};
	let newSessionCalls = 0;
	const context = createMockContext({
		hasUI: true,
		waitForIdle: () =>
			new Promise<void>((resolve) => {
				releaseIdle = resolve;
			}),
		sessionManager: {
			getSessionFile: () => "/tmp/parent-session.jsonl",
			getBranch: () => [],
			getEntries: () => [],
		},
		newSession: async () => {
			newSessionCalls += 1;
			return { cancelled: false };
		},
	});
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Stale handoff" }, undefined, undefined, context.ctx);

	const implementation = mock.commands.get("plan")?.handler("implement-new", context.ctx);
	await Promise.resolve();
	await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
	releaseIdle();
	await implementation;

	assert.equal(newSessionCalls, 0);
});

test("the ready /plan menu offers replacement-session implementation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	let newSessionCalls = 0;
	const context = createMockContext({
		hasUI: true,
		select: async () => "Implement in new session",
		sessionManager: {
			getSessionFile: () => "/tmp/parent-session.jsonl",
			getBranch: () => [],
			getEntries: () => [],
		},
		newSession: async (options: Record<string, unknown>) => {
			newSessionCalls += 1;
			await (options.setup as (sessionManager: unknown) => Promise<void>)({
				appendCustomEntry() {},
			});
			await (options.withSession as (replacementCtx: unknown) => Promise<void>)({
				async sendUserMessage() {},
			});
			return { cancelled: false };
		},
	});
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Menu" }, undefined, undefined, context.ctx);

	await mock.commands.get("plan")?.handler("", context.ctx);

	assert.equal(newSessionCalls, 1);
});

test("plan show displays only a stored plan without triggering a model turn", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/i);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Show me" }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("show", context.ctx);
	assert.equal(mock.sentMessages.length, 1);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Show me/);
});

test("plan show keeps a completed plan ready when display delivery fails", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Still ready" }, undefined, undefined, context.ctx);
	mock.rawPi.sendMessage = () => {
		throw new Error("display unavailable");
	};

	await assert.doesNotReject(async () => {
		await mock.commands.get("plan")?.handler("show", context.ctx);
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /display unavailable/);
});

test("plan finalize requires active mode and uses idle-safe delivery", async () => {
	let idle = true;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ isIdle: () => idle });
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /not active/i);

	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /plan_mode_complete/);
	assert.equal(mock.sentUserMessages.at(-1)?.options, undefined);

	idle = false;
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.deepEqual(mock.sentUserMessages.at(-1)?.options, { deliverAs: "followUp" });
});

test("plan implement fails closed without a plan and hands off a stored plan", async () => {
	const mock = createMockPi({ activeTools: ["read", "custom"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/i);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Implement me" }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan implementing");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "custom"]);
	assert.match(mock.sentUserMessages.at(-1)?.text ?? "", /# Implement me/);
});

test("failed finalize delivery keeps Plan mode active", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("inline prompt delivery failure rolls back newly entered Plan mode", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("Extension context is no longer active");
	};
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("design it", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /no longer active/);
});

test("invalid proposed plans remain unready and notify the user", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>unfinished" }] },
		context.ctx,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /closing tag is missing/);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("prose-only promise to present a plan remains active without false readiness", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);

	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: "Now I have a complete understanding. Let me present the plan.",
				},
			],
		},
		context.ctx,
	);

	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.equal(mock.sentMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /did not submit a completed plan/i);
});

test("explicit finalization retries once and then fails visibly", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	const agentEnd = mock.events.get("agent_end")?.[0];
	assert.ok(agentEnd);

	const proseOnly = {
		messages: [{ role: "assistant", content: "Here is the final plan in ordinary prose." }],
	};
	await agentEnd(proseOnly, context.ctx);
	assert.equal(mock.sentMessages.length, 1);
	assert.deepEqual(mock.sentMessages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
	assert.deepEqual(mock.sentMessages[0]?.message, {
		customType: "plan-mode-recovery",
		content:
			"The previous explicit Plan-mode finalization turn ended without a valid completion signal. If a material decision remains, call plan_mode_question. Otherwise call plan_mode_complete alone with the complete decision-ready plan. Do not answer with ordinary prose.",
		display: false,
	});
	assert.match(context.notifications.at(-1)?.message ?? "", /retrying finalization once/i);

	await agentEnd(proseOnly, context.ctx);
	assert.equal(mock.sentMessages.length, 1);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.match(context.notifications.at(-1)?.message ?? "", /stopped after one recovery attempt/i);
});

test("plan completion cancels a pending finalization recovery", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("finalize", context.ctx);
	const agentEnd = mock.events.get("agent_end")?.[0];
	assert.ok(agentEnd);
	const proseOnly = { messages: [{ role: "assistant", content: "Final plan follows." }] };
	await agentEnd(proseOnly, context.ctx);

	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Recovered plan" }, undefined, undefined, context.ctx);
	await agentEnd(proseOnly, context.ctx);

	assert.equal(mock.sentMessages.length, 1);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("plan_mode_complete stores a visible terminating plan contract", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);

	const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
	assert.ok(tool);
	const execute = tool.execute as
		| ((...args: unknown[]) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: { version?: number; plan?: string; source?: string };
				terminate?: boolean;
		  }>)
		| undefined;
	assert.ok(execute);

	const result = await execute(
		"call-complete",
		{ plan: "# Ship it\n\n## Test Plan\n\n- Run checks." },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content[0]?.text ?? "", /# Ship it/);
	assert.deepEqual(result.details, {
		version: 1,
		source: "plan_mode_complete",
		plan: "# Ship it\n\n## Test Plan\n\n- Run checks.",
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("plan completion prefills approval once after agent_settled", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("complete", { plan: "# Ready" }, undefined, undefined, context.ctx);
	assert.deepEqual(context.editorTextUpdates, []);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
	assert.equal(mock.sentMessages.length, 0);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("legacy plan completion is presented and prefilled once only after settlement", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{ messages: [{ role: "assistant", content: "<proposed_plan>\n# Legacy\n</proposed_plan>" }] },
		context.ctx,
	);
	assert.deepEqual(context.editorTextUpdates, []);
	assert.equal(mock.sentMessages.length, 0);

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
	assert.equal(mock.sentMessages.length, 1);
	assert.match((mock.sentMessages[0]?.message as { content?: string })?.content ?? "", /# Legacy/);
});

test("settled plan presentation waits for idle without pending messages", async () => {
	let idle = false;
	let pending = false;
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	});
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Wait" }, undefined, undefined, context.ctx);

	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	idle = true;
	pending = true;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, []);
	pending = false;
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
});

test("duplicate and replacement completions present only the latest plan once", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await execute("first", { plan: "# First" }, undefined, undefined, context.ctx);
	await execute("duplicate", { plan: "# First" }, undefined, undefined, context.ctx);
	await execute("replacement", { plan: "# Replacement" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
	assert.equal((mock.entries.at(-1)?.data as { latestPlan?: string })?.latestPlan, "# Replacement");
});

test("repeated legacy agent_end events produce one settled presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const event = {
		messages: [{ role: "assistant", content: "<proposed_plan>\n# Retry\n</proposed_plan>" }],
	};
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_end")?.[0]?.(event, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, ["/plan"]);
	assert.equal(mock.sentMessages.length, 1);
});

test("no-UI completion remains ready without opening or duplicating presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Headless" }, undefined, undefined, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
	assert.equal(mock.sentMessages.length, 0);
});

test("stale settled legacy presentation is ignored without losing ready state", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	mock.rawPi.sendMessage = () => {
		throw new Error("This extension ctx is stale after session replacement or reload");
	};
	planMode(mock.pi);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.events.get("agent_end")?.[0]?.(
		{
			messages: [{ role: "assistant", content: "<proposed_plan>\n# Persisted\n</proposed_plan>" }],
		},
		context.ctx,
	);
	await assert.doesNotReject(async () => {
		await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	});
	assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("a newer Plan turn cancels stale ready presentation", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext({ hasUI: true });
	await mock.commands.get("plan")?.handler("", context.ctx);
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);
	await execute("complete", { plan: "# Stale" }, undefined, undefined, context.ctx);
	await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
	await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
	assert.deepEqual(context.editorTextUpdates, []);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("plan_mode_complete rejects inactive and invalid submissions", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	const execute = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")
		?.execute as ((...args: unknown[]) => Promise<unknown>) | undefined;
	assert.ok(execute);

	await assert.rejects(
		execute("inactive", { plan: "# Plan" }, undefined, undefined, context.ctx),
		/only available while Plan mode is active/,
	);
	await mock.commands.get("plan")?.handler("", context.ctx);
	await assert.rejects(
		execute("empty", { plan: "  \n" }, undefined, undefined, context.ctx),
		/must not be empty/,
	);
	await assert.rejects(
		execute("large", { plan: "x".repeat(50_001) }, undefined, undefined, context.ctx),
		/must not exceed 50000 characters/,
	);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("proposed-plan parser distinguishes valid and malformed output", () => {
	assert.deepEqual(parseProposedPlan("No plan"), { kind: "absent" });
	assert.deepEqual(parseProposedPlan("<proposed_plan>\n# Plan\n</proposed_plan>"), {
		kind: "valid",
		plan: "# Plan",
	});
	assert.equal(parseProposedPlan("<proposed_plan>\n\n</proposed_plan>").kind, "empty");
	assert.equal(
		parseProposedPlan("<proposed_plan>a</proposed_plan><proposed_plan>b</proposed_plan>").kind,
		"multiple",
	);
	assert.equal(parseProposedPlan("before <proposed_plan>bad</proposed_plan>").kind, "malformed");
	assert.equal(parseProposedPlan("<proposed_plan>unfinished").kind, "unclosed");
	assert.equal(parseProposedPlan("<PROPOSED_PLAN>\n# Plan\n</PROPOSED_PLAN>").kind, "malformed");
});

test("active Plan UI advertises the completion tool rather than legacy XML", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	await mock.commands.get("plan")?.handler("", context.ctx);
	const widget = context.widgets.get("plan-mode-plan") as string[];
	assert.match(widget.join("\n"), /plan_mode_complete/);
	assert.doesNotMatch(widget.join("\n"), /proposed_plan/);
	await mock.commands.get("plan")?.handler("", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /plan_mode_complete/);
	assert.doesNotMatch(context.notifications.at(-1)?.message ?? "", /proposed_plan/);
});

test("inactive context discards completed-plan tool results", async () => {
	const mock = createMockPi({ activeTools: ["read"] });
	planMode(mock.pi);
	const context = createMockContext();
	const contextHook = mock.events.get("context")?.[0];
	assert.ok(contextHook);
	const assistantWithCalls = {
		role: "assistant",
		content: [
			{ type: "text", text: "keep explanation" },
			{ type: "toolCall", id: "plan-call", name: "plan_mode_complete", arguments: {} },
			{ type: "toolCall", id: "read-call", name: "read", arguments: {} },
		],
	};
	const assistantWithOnlyCompletion = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "only-plan-call", name: "plan_mode_complete", arguments: {} },
		],
	};
	const completionResult = {
		role: "toolResult",
		toolCallId: "plan-call",
		toolName: "plan_mode_complete",
		content: [{ type: "text", text: "**Proposed Plan**\n\n# Discarded" }],
		details: { version: 1, source: "plan_mode_complete", plan: "# Discarded" },
	};
	const unrelatedResult = {
		role: "toolResult",
		toolCallId: "read-call",
		toolName: "read",
		content: [{ type: "text", text: "keep me" }],
	};
	const recoveryMessage = {
		role: "custom",
		customType: "plan-mode-recovery",
		content: "retry finalization",
		display: false,
	};
	const allMessages = [
		assistantWithCalls,
		assistantWithOnlyCompletion,
		completionResult,
		recoveryMessage,
		unrelatedResult,
	];

	const inactive = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(inactive.messages, [
		{
			...assistantWithCalls,
			content: [assistantWithCalls.content[0], assistantWithCalls.content[2]],
		},
		unrelatedResult,
	]);

	await mock.commands.get("plan")?.handler("", context.ctx);
	const active = (await contextHook({ messages: allMessages }, context.ctx)) as {
		messages: unknown[];
	};
	assert.deepEqual(active.messages, allMessages);
});

test("Plan prompt requires the standalone completion contract", () => {
	const prompt = buildPlanModePrompt();
	assert.match(prompt, /recommended option.*assumption/i);
	assert.match(prompt, /plan_mode_complete/i);
	assert.match(prompt, /alone as (?:your )?(?:final|last) action/i);
	assert.match(prompt, /end.*plan_mode_question.*plan_mode_complete/is);
	assert.match(prompt, /clarification.*plan_mode_complete.*unchanged/is);
	assert.match(prompt, /behavior-level/i);
	assert.doesNotMatch(prompt, /<proposed_plan>/i);
});

test("proposed-plan helpers extract and remove plan blocks", () => {
	assert.equal(extractProposedPlan("Intro\n<proposed_plan>\n# Plan\n</proposed_plan>"), "# Plan");
	assert.equal(
		stripProposedPlanBlocks("A\n<proposed_plan>\nsecret\n</proposed_plan>\nB"),
		"A\n\nB",
	);
	assert.equal(
		stripProposedPlanBlocks("A<proposed_plan>malformed</proposed_plan>B"),
		"A<proposed_plan>malformed</proposed_plan>B",
	);
	assert.deepEqual(
		stripProposedPlanBlocksFromMessage({
			role: "assistant",
			content: [{ type: "text", text: "Keep\n<proposed_plan>\nremove\n</proposed_plan>" }],
		}),
		{ role: "assistant", content: [{ type: "text", text: "Keep\n" }] },
	);
	assert.equal(
		latestAssistantText([
			{ role: "user", content: "ignore" },
			{ message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		]),
		"answer",
	);
});
