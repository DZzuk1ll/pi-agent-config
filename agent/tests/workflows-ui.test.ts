import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";
import type { WorkflowDetails } from "../extensions/workflows/controller.ts";
import {
	findWorkflowEntry,
	groupWorkflowAgents,
	mergeWorkflowDashboardEntries,
	moveWorkflowSelection,
} from "../extensions/workflows/dashboard-model.ts";
import { getArtifactPaths, getArtifactsDir } from "../extensions/community/pi-subagents/src/shared/artifacts.ts";
import { registerSubagentTranscriptApi } from "../extensions/community/pi-subagents/src/extension/transcript-api.ts";
import { WorkflowTranscriptClient } from "../extensions/workflows/transcript.ts";
import { formatWorkflowCall, formatWorkflowResult, type WorkflowTheme } from "../extensions/workflows/view.ts";
import { claimInteractiveWidgetFocus, releaseInteractiveWidgetFocus } from "../extensions/shared/interactive-widget-focus.ts";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = path.join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": piPackage,
		"@earendil-works/pi-tui": path.join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});
const liveStatusModule = await jiti.import<{
	WorkflowLiveStatus: new (source: unknown, openInspector: (ctx: unknown, target: unknown) => Promise<void> | void) => {
		setContext(ctx: unknown): void;
		runInspector<T>(action: () => Promise<T> | T): Promise<T>;
		dispose(): void;
	};
	collectWorkflowLiveStatusEntries(active: ReadonlyMap<string, WorkflowDetails>): Array<Record<string, unknown>>;
}>("../extensions/workflows/live-status.ts");
const fleetStatusModule = await jiti.import<{
	SubagentFleetStatus: new (state: unknown, openInspector: (itemKey: string) => Promise<void> | void) => {
		setContext(ctx: unknown): void;
		setWorkflowPanelVisible(visible: boolean): void;
		handleKey(data: string): { consume?: boolean } | undefined;
		dispose(): void;
	};
	collectFleetStatusEntries(state: unknown): Array<Record<string, unknown>>;
}>("../extensions/community/pi-subagents/src/tui/fleet-status.ts");
const delegationAdaptersModule = await jiti.import<{
	toSubagentDelegationV2ExecutionParams(request: Record<string, unknown>): Record<string, unknown>;
}>("../extensions/community/pi-subagents/src/slash/delegation-adapters.ts");
const dashboardModule = await jiti.import<{
	WorkflowDashboard: new (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		source: unknown,
		close: () => void,
		lifetimeSignal?: AbortSignal,
		initialRunId?: string,
		initialNodeId?: string,
		openInitialTranscript?: boolean,
		closeOnBack?: boolean,
	) => { handleInput(data: string): void; render(width: number): string[]; dispose(): void };
}>("../extensions/workflows/dashboard.ts");

const theme: WorkflowTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};

function details(overrides: Partial<WorkflowDetails> = {}): WorkflowDetails {
	return {
		runId: "wf_test",
		sessionId: "session",
		name: "Preview workflow",
		description: "Exercise the renderer",
		background: false,
		state: "running",
		startedAt: Date.now() - 1_000,
		currentPhase: "Gather",
		phases: ["Gather"],
		agents: [
			{
				index: 1,
				nodeId: "agent-1",
				label: "Research",
				agent: "Explore",
				phase: "Gather",
				state: "running",
				startedAt: Date.now() - 500,
				currentTool: "read",
				preview: "Inspecting files\nFound renderer gap",
			},
		],
		...overrides,
	};
}

test("workflow call renderer stays bounded and hides script arguments", () => {
	const output = formatWorkflowCall({
		name: "Render check",
		description: "A\u001b[31m safe\nsummary",
		background: true,
		// Runtime callers can carry additional tool arguments; they must not render.
		script: "secret script",
		argsJson: "secret args",
	} as never, theme);
	assert.match(output, /workflow Render check \(background\)/);
	assert.match(output, /A safe summary/);
	assert.doesNotMatch(output, /secret script|secret args|\u001b/);
});

test("workflow result renderer shows live progress and expanded preview", () => {
	const value = details();
	const collapsed = formatWorkflowResult({ content: [], details: value }, { expanded: false, isPartial: true }, theme);
	assert.match(collapsed, /Preview workflow/);
	assert.match(collapsed, /0\/1 agents/);
	assert.match(collapsed, /Research · Explore · read/);
	assert.doesNotMatch(collapsed, /Found renderer gap/);

	const expanded = formatWorkflowResult({ content: [], details: value }, { expanded: true, isPartial: true }, theme);
	assert.match(expanded, /── Gather ──/);
	assert.match(expanded, /Inspecting files · Found renderer gap/);
});

test("workflow result renderer falls back to text for old or missing details", () => {
	const output = formatWorkflowResult({
		content: [{ type: "text", text: "legacy workflow result" }],
		details: { unexpected: true },
	}, { expanded: false }, theme);
	assert.equal(output, "legacy workflow result");
});

test("workflow result renderer sanitizes dynamic control sequences", () => {
	const value = details({
		name: "bad\u001b[31mname",
		agents: [{
			index: 1,
			nodeId: "agent-1",
			label: "agent\u0007label",
			agent: "Explore",
			state: "failed",
			error: "oops\u001b[2J",
		}],
	});
	const output = formatWorkflowResult({ content: [], details: value }, { expanded: true }, theme);
	assert.doesNotMatch(output, /\u001b/);
	assert.match(output, /badname/);
	assert.match(output, /agent�label/);
});

test("live workflow status lists the workflow and every agent in execution order", () => {
	const value = details({
		agents: [
			{ index: 2, nodeId: "agent-2", label: "Verify", agent: "general-purpose", phase: "Verify", state: "queued" },
			{ index: 1, nodeId: "agent-1", label: "Research", agent: "Explore", phase: "Gather", state: "done", tokens: 1_200 },
		],
	});
	const entries = liveStatusModule.collectWorkflowLiveStatusEntries(new Map([[value.runId, value]]));
	assert.deepEqual(entries.map((entry) => entry.key), ["workflow:wf_test", "agent:wf_test:agent-1", "agent:wf_test:agent-2"]);
	assert.equal(entries[0]?.done, 1);
	assert.equal(entries[0]?.total, 2);
	assert.equal(entries[1]?.tokens, 1_200);
});

test("live workflow status renders below the editor and opens the selected agent transcript", async () => {
	const value = details({
		agents: [{
			index: 1,
			nodeId: "agent-1",
			label: "Research",
			agent: "Explore",
			phase: "Gather",
			state: "running",
			startedAt: Date.now() - 500,
			runId: "child-1",
			currentTool: "read",
			tokens: 1_500,
		}],
	});
	let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let component: { render(width: number): string[] } | undefined;
	let opened: Record<string, unknown> | undefined;
	const focusedComponent = {
		render: () => [],
		invalidate: () => {},
		handleInput: () => {},
		getText: () => "",
		setText: () => {},
	};
	const tui = { requestRender: () => {}, focusedComponent };
	const ui = {
		theme,
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			input = handler;
			return () => { input = undefined; };
		},
		setWidget(_key: string, value: unknown) {
			component = typeof value === "function"
				? (value as (target: unknown, targetTheme: WorkflowTheme) => { render(width: number): string[] })(tui, theme)
				: undefined;
		},
		getEditorText: () => "draft input",
		notify: () => {},
	};
	const status = new liveStatusModule.WorkflowLiveStatus({
		getActive: () => new Map([[value.runId, value]]),
		cancel: () => true,
	}, async (_ctx, target) => {
		opened = target as Record<string, unknown>;
	});
	let hasUi = true;
	const context = { get hasUI() { return hasUi; }, ui };
	try {
		status.setContext(context);
		assert.match(component?.render(120).join("\n") ?? "", /Workflow Preview workflow/);
		assert.match(component?.render(120).join("\n") ?? "", /Research · Explore · read/);
		let finishInspector: (() => void) | undefined;
		const suspended = status.runInspector(() => new Promise<void>((resolve) => { finishInspector = resolve; }));
		await Promise.resolve();
		assert.equal(component, undefined);
		finishInspector?.();
		await suspended;
		assert.ok(component);
		assert.equal(input?.("\x1b[B")?.consume, true);
		assert.equal(input?.("\x1b[B")?.consume, true);
		assert.equal(input?.("\r")?.consume, true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(opened, { runId: "wf_test", nodeId: "agent-1", openTranscript: true });
		hasUi = false;
		input?.("x");
		assert.equal(input, undefined);
		assert.equal(component, undefined);
	} finally {
		status.dispose();
	}
});

test("framed workflow inspectors close directly from workflow or agent selection", async () => {
	const value = details({
		agents: [{
			index: 1,
			nodeId: "agent-1",
			label: "Research",
			agent: "Explore",
			state: "running",
			runId: "child-1",
		}],
	});
	const source = {
		getActive: () => new Map([[value.runId, value]]),
		loadHistory: () => [],
		cancel: () => false,
		loadTranscript: async () => ({
			status: "ok",
			events: [{
				kind: "tool",
				name: "grep",
				args: "search workflow implementation",
				output: [...Array.from({ length: 90 }, (_, index) => `result-line-${index + 1}`), "final-expanded-marker"].join("\n"),
				status: "complete",
				startedAt: 1_000,
				endedAt: 2_250,
			}],
			cursor: 0,
			truncated: false,
		}),
	};
	const tui = { requestRender: () => {}, terminal: { rows: 40 } };
	const keybindings = {
		matches: (data: string, action: string) => action === "tui.select.cancel" && data === "\x1b",
	};

	let closed = 0;
	const detail = new dashboardModule.WorkflowDashboard(
		tui, theme, keybindings, source, () => { closed++; }, undefined, value.runId, undefined, false, true,
	);
	tui.terminal.rows = 10;
	assert.equal(detail.render(120).length, 1);
	tui.terminal.rows = 40;
	const frame = detail.render(120);
	assert.equal(frame.length, 34);
	assert.match(frame[0] ?? "", /^╭─+╮$/);
	assert.match(frame.join("\n"), /Workflow fleet inspector/);
	assert.match(frame[2] ?? "", /^├─+┬─+┤$/);
	detail.handleInput("\x1b");
	assert.equal(closed, 1);

	closed = 0;
	const transcript = new dashboardModule.WorkflowDashboard(
		tui, theme, keybindings, source, () => { closed++; }, undefined, value.runId, "agent-1", true, true,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const compactTranscript = transcript.render(120).join("\n");
	assert.match(compactTranscript, /grep/);
	assert.match(compactTranscript, /x to expand/);
	assert.doesNotMatch(compactTranscript, /final-expanded-marker/);
	transcript.handleInput("x");
	const expandedTranscript = transcript.render(120).join("\n");
	assert.match(expandedTranscript, /final-expanded-marker/);
	assert.match(expandedTranscript, /x collapse tools/);
	transcript.handleInput("\x1b");
	assert.equal(closed, 1);

	closed = 0;
	const historyNavigation = new dashboardModule.WorkflowDashboard(
		tui, theme, keybindings, source, () => { closed++; }, undefined, value.runId,
	);
	historyNavigation.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("V2 delegation tags children with their orchestrator UI owner", () => {
	const params = delegationAdaptersModule.toSubagentDelegationV2ExecutionParams({
		version: 2,
		requestId: "request-1",
		ownerRunId: "wf_test",
		nodeId: "agent-1",
		agent: "Explore",
		task: "Inspect",
		context: "fresh",
		cwd: "/tmp/project",
		artifacts: true,
		result: { kind: "text" },
	});
	assert.equal(params.delegatedUiOwnerRunId, "wf_test");
});

test("workflow-owned children are omitted from the automatic fleet status", () => {
	const entries = fleetStatusModule.collectFleetStatusEntries({
		foregroundControls: new Map([["child-1", {
			runId: "child-1",
			uiOwnerRunId: "wf_test",
			startedAt: Date.now() - 1_000,
			activeChildren: new Map([[0, { index: 0, agent: "Explore", startedAt: Date.now() - 1_000 }]]),
		}]]),
		asyncJobs: new Map(),
	});
	assert.deepEqual(entries, []);
});

test("workflow focus prevents the subagent panel from stealing navigation keys", () => {
	const focusedComponent = {
		render: () => [],
		invalidate: () => {},
		handleInput: () => {},
		getText: () => "",
		setText: () => {},
	};
	const tui = { requestRender: () => {}, focusedComponent };
	const ui = {
		theme,
		onTerminalInput: () => () => {},
		setWidget(_key: string, value: unknown) {
			if (typeof value === "function") (value as (target: unknown, targetTheme: WorkflowTheme) => unknown)(tui, theme);
		},
		getEditorText: () => "",
		notify: () => {},
	};
	const status = new fleetStatusModule.SubagentFleetStatus({
		foregroundControls: new Map([["run-1", {
			runId: "run-1",
			startedAt: Date.now() - 1_000,
			activeChildren: new Map([[0, { index: 0, agent: "Explore", startedAt: Date.now() - 1_000 }]]),
		}]]),
		asyncJobs: new Map(),
		fleetInspectorOpen: false,
	}, async () => {});
	try {
		status.setContext({ hasUI: true, ui });
		status.setWorkflowPanelVisible(true);
		assert.equal(status.handleKey("\x1b[B"), undefined);
		assert.equal(status.handleKey("\x1b[D")?.consume, true);
		assert.equal(status.handleKey("\x1b")?.consume, true);
		status.setWorkflowPanelVisible(false);
		assert.equal(claimInteractiveWidgetFocus("workflow-test"), true);
		assert.equal(status.handleKey("\x1b[B"), undefined);
		releaseInteractiveWidgetFocus("workflow-test");
		assert.equal(status.handleKey("\x1b[B")?.consume, true);
	} finally {
		releaseInteractiveWidgetFocus("workflow-test");
		status.dispose();
	}
});

test("dashboard merges live and history while marking orphaned running runs stale", () => {
	const live = details({ runId: "wf_live", startedAt: 30 });
	const stale = details({ runId: "wf_stale", startedAt: 20 });
	const complete = details({ runId: "wf_done", state: "completed", startedAt: 10, endedAt: 15 });
	const entries = mergeWorkflowDashboardEntries(new Map([[live.runId, live]]), [live, stale, complete]);
	assert.deepEqual(entries.map((entry) => entry.runId), ["wf_live", "wf_stale", "wf_done"]);
	assert.equal(entries[0]?.live, true);
	assert.equal(entries[1]?.stale, true);
	assert.equal(findWorkflowEntry(entries, "done")?.runId, "wf_done");
});

test("dashboard groups agents by phase and wraps selection", () => {
	const value = details({
		phases: ["Gather", "Verify"],
		agents: [
			{ index: 1, nodeId: "agent-1", label: "One", agent: "Explore", phase: "Gather", state: "done" },
			{ index: 2, nodeId: "agent-2", label: "Two", agent: "Plan", state: "queued" },
		],
	});
	const groups = groupWorkflowAgents(value);
	assert.deepEqual(groups.map((group) => [group.title, group.agents.length]), [["Gather", 1], ["Verify", 0], ["Unphased", 1]]);
	assert.equal(moveWorkflowSelection(0, -1, 3), 2);
	assert.equal(moveWorkflowSelection(2, 1, 3), 0);
});

test("workflow transcript client correlates and sanitizes paged API responses", async () => {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		on(event: string, handler: (data: unknown) => void) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, data: unknown) {
			if (event === "prompt-template:subagent:transcript:request") {
				const request = data as Record<string, unknown>;
				for (const handler of handlers.get("prompt-template:subagent:transcript:response") ?? []) {
					handler({ ...request, requestId: "forged", status: "ok", events: [{ kind: "user", text: "wrong" }] });
					handler({
						version: 1,
						requestId: request.requestId,
						runId: request.runId,
						status: "ok",
						cursor: 0,
						nextCursor: 1,
						total: 2,
						events: [{ kind: "assistant", text: "safe\u001b[31m output", model: "provider/model" }],
					});
				}
			}
		},
	};
	const page = await new WorkflowTranscriptClient(bus, 20).query({ runId: "child-1" });
	assert.equal(page.status, "ok");
	assert.equal(page.events[0]?.kind, "assistant");
	assert.equal((page.events[0] as { text?: string }).text, "safe output");
	assert.equal(page.nextCursor, 1);
});

test("workflow transcript client rejects fractional pagination cursors", async () => {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		on(event: string, handler: (data: unknown) => void) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, data: unknown) {
			if (event !== "prompt-template:subagent:transcript:request") return;
			const request = data as Record<string, unknown>;
			for (const handler of handlers.get("prompt-template:subagent:transcript:response") ?? []) {
				handler({ version: 1, requestId: request.requestId, runId: request.runId, status: "ok", cursor: 0, nextCursor: 1.5, total: 2, events: [] });
			}
		},
	};
	const page = await new WorkflowTranscriptClient(bus, 20).query({ runId: "child-cursor" });
	assert.equal(page.status, "unavailable");
	assert.match(page.error ?? "", /invalid pagination cursor/);
});

test("workflow transcript client capability-gates missing providers", async () => {
	const bus = { on: () => () => {}, emit: () => {} };
	const page = await new WorkflowTranscriptClient(bus, 5).query({ runId: "child-missing" });
	assert.equal(page.status, "unavailable");
	assert.match(page.error ?? "", /subagents transcript API is unavailable/);
});

test("pi-subagents transcript API returns bounded current-session pages without exposing paths", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-transcript-api-"));
	try {
		const runId = "child-live";
		const root = getArtifactsDir(null, cwd, "project");
		const transcriptPath = getArtifactPaths(root, runId, "Explore", 0).transcriptPath;
		fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
		fs.writeFileSync(transcriptPath, [
			JSON.stringify({ recordType: "message", role: "assistant", text: "inspecting", ts: 1 }),
			JSON.stringify({ recordType: "tool_start", toolName: "read", toolCallId: "tool-1", argsPreview: "file.ts", ts: 2 }),
			JSON.stringify({ recordType: "tool_end", toolName: "read", toolCallId: "tool-1", ts: 3 }),
		].join("\n") + "\n");
		const handlers = new Map<string, Set<(value: unknown) => void>>();
		let response: Record<string, unknown> | undefined;
		const bus = {
			on(event: string, handler: (value: unknown) => void) {
				const set = handlers.get(event) ?? new Set();
				set.add(handler);
				handlers.set(event, set);
				return () => set.delete(handler);
			},
			emit(event: string, value: unknown) {
				if (event === "prompt-template:subagent:transcript:response") response = value as Record<string, unknown>;
				for (const handler of handlers.get(event) ?? []) handler(value);
			},
		};
		const api = registerSubagentTranscriptApi(bus, {
			baseCwd: cwd,
			currentSessionId: "session",
			artifactDirPreference: "project",
			parentSessionFile: null,
			foregroundControls: new Map([[runId, {
				runId,
				sessionId: "session",
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				cwd,
				currentAgent: "Explore",
			}]]),
		} as never);
		bus.emit("prompt-template:subagent:transcript:request", {
			version: 1,
			requestId: "request-1",
			runId,
			childIndex: 0,
			cursor: 0,
			limit: 1,
		});
		assert.equal(response?.status, "ok");
		assert.equal((response?.events as unknown[])?.length, 1);
		assert.equal(response?.nextCursor, undefined);
		assert.equal(response?.truncated, true);
		assert.equal(Object.hasOwn(response ?? {}, "path"), false);
		api.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("pi-subagents transcript API derives completed-run paths and paginates stable snapshots", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-transcript-history-"));
	try {
		const runId = "child-done";
		const root = getArtifactsDir(null, cwd, "project");
		const expectedPath = getArtifactPaths(root, runId, "Explore", 0).transcriptPath;
		fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
		fs.writeFileSync(expectedPath, [
			JSON.stringify({ recordType: "message", role: "assistant", text: "first", ts: 1 }),
			JSON.stringify({ recordType: "message", role: "assistant", text: "second", ts: 2 }),
		].join("\n") + "\n");
		const handlers = new Map<string, Set<(value: unknown) => void>>();
		let response: Record<string, unknown> | undefined;
		const bus = {
			on(event: string, handler: (value: unknown) => void) {
				const set = handlers.get(event) ?? new Set();
				set.add(handler);
				handlers.set(event, set);
				return () => set.delete(handler);
			},
			emit(event: string, value: unknown) {
				if (event === "prompt-template:subagent:transcript:response") response = value as Record<string, unknown>;
				for (const handler of handlers.get(event) ?? []) handler(value);
			},
		};
		const api = registerSubagentTranscriptApi(bus, {
			baseCwd: cwd,
			currentSessionId: "session",
			artifactDirPreference: "project",
			parentSessionFile: null,
			foregroundControls: new Map(),
			foregroundRuns: new Map([[runId, {
				runId,
				mode: "single",
				cwd,
				sessionId: "session",
				updatedAt: 2,
				children: [{ agent: "Explore", index: 0, status: "complete", transcriptPath: "/tmp/should-not-be-read" }],
			}]]),
		} as never);
		bus.emit("prompt-template:subagent:transcript:request", { version: 1, requestId: "request-2", runId, childIndex: 0, cursor: 0, limit: 1 });
		assert.equal(response?.status, "ok");
		assert.equal(response?.nextCursor, 1);
		assert.equal(((response?.events as Array<{ text?: string }>)[0]?.text), "first");
		api.dispose();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
