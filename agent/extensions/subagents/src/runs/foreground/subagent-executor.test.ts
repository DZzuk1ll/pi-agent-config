import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../agents/agents.ts";
import type { SubagentState } from "../../shared/types.ts";

const asyncExecutionMocks = vi.hoisted(() => ({
	executeAsyncSingle: vi.fn<typeof import("../background/async-execution.ts").executeAsyncSingle>(() => ({
		content: [{ type: "text" as const, text: "started" }],
		details: { mode: "single" as const, results: [] },
	})),
}));

vi.mock("../background/async-execution.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../background/async-execution.ts")>(),
	executeAsyncSingle: asyncExecutionMocks.executeAsyncSingle,
}));

vi.mock("../../watchdog/tool-actions.ts", () => ({
	WATCHDOG_TOOL_ACTIONS: [],
	handleWatchdogToolAction: vi.fn(),
}));

import { createSubagentExecutor } from "./subagent-executor.ts";

type ExecutorDeps = Parameters<typeof createSubagentExecutor>[0];
type ExecuteContext = Parameters<ReturnType<typeof createSubagentExecutor>["execute"]>[4];

const roots: string[] = [];

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		parentSessionFile: null,
		subagentInProgress: false,
		subagentSpawns: { sessionId: null, count: 0, configuredLimit: null, granted: 0, grantHistory: [] },
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => undefined },
	};
}

function createAgent(defaultReads: string[]): AgentConfig {
	return {
		name: "worker",
		description: "test worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "work",
		source: "project",
		filePath: "/agents/worker.md",
		defaultReads,
	};
}

function createHarness(defaultReads: string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-single-"));
	roots.push(root);
	const agent = createAgent(defaultReads);
	const events = { on: () => () => undefined, emit: () => undefined };
	const deps: ExecutorDeps = {
		pi: {
			events,
			getSessionName: () => "parent",
		} as unknown as ExecutorDeps["pi"],
		state: createState(),
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: path.join(root, "artifacts"),
		getSubagentSessionRoot: () => path.join(root, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
	};
	const ctx = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session",
		},
		modelRegistry: { getAvailable: () => [] },
	} as unknown as ExecuteContext;
	return { executor: createSubagentExecutor(deps), ctx };
}

beforeEach(() => {
	asyncExecutionMocks.executeAsyncSingle.mockClear();
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("direct async single reads overrides", () => {
	it.each([
		{ label: "inherits agent defaults", reads: true, expected: true },
		{ label: "disables reads", reads: false, expected: false },
		{ label: "uses explicit paths", reads: ["explicit.txt"] as string[], expected: ["explicit.txt"] },
	] as const)("$label", async ({ reads, expected }) => {
		const { executor, ctx } = createHarness(["default.txt"]);
		await executor.execute("request", {
			agent: "worker",
			task: "inspect the project",
			async: true,
			reads,
		}, new AbortController().signal, undefined, ctx);

		const call = asyncExecutionMocks.executeAsyncSingle.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) throw new Error("executeAsyncSingle was not called");
		expect(call[1].reads).toEqual(expected);
	});
});
