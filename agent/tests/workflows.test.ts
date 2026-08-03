import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { WorkflowArtifacts, aggregateUsage, loadWorkflowHistory, normalizeWorkflowDetails, prepareWorkflowStorage } from "../extensions/workflows/artifacts.ts";
import { WorkflowAdmission, WorkflowController } from "../extensions/workflows/controller.ts";
import { DelegationClient, type AgentCallResult, type DelegationEvents } from "../extensions/workflows/delegation.ts";
import { runWorkflowSandbox } from "../extensions/workflows/sandbox.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-test-"));
}

function sandbox(source: string, options: { args?: unknown; onAgent?: (prompt: string) => Promise<AgentCallResult>; signal?: AbortSignal } = {}) {
	const cwd = tempDir();
	return runWorkflowSandbox({
		source,
		args: options.args,
		cwd,
		signal: options.signal ?? new AbortController().signal,
		onAgent: (prompt) => options.onAgent?.(prompt) ?? Promise.resolve({ ok: true, output: prompt }),
		onPhase: () => {},
	}).finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

class EventBus implements DelegationEvents {
	readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	on(event: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
	listenerCount(): number {
		return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
	}
}

test("sandbox returns JSON data and exposes immutable args", async () => {
	const cwd = tempDir();
	try {
		const result = await runWorkflowSandbox({
			source: "phase('start'); return { value: args.value, nested: args.nested };",
			args: { value: 42, nested: ["ok"] },
			cwd,
			signal: new AbortController().signal,
			onAgent: async () => ({ ok: true, output: "unused" }),
			onPhase: (title) => assert.equal(title, "start"),
		});
		assert.deepEqual(result, { value: 42, nested: ["ok"] });
		await assert.rejects(runWorkflowSandbox({
			source: "args.value = 9; return args;",
			args: { value: 1 },
			cwd,
			signal: new AbortController().signal,
			onAgent: async () => ({ ok: true, output: "unused" }),
			onPhase: () => {},
		}), /read only|Cannot assign/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("sandbox does not expose process, require, fetch, or string code generation", async () => {
	const result = await sandbox("return [typeof process, typeof require, typeof fetch];");
	assert.deepEqual(result, ["undefined", "undefined", "undefined"]);
	await assert.rejects(sandbox("return Function('return 1')();"), /code generation|EvalError/i);
	await assert.rejects(sandbox("return ({}).constructor.constructor('return process')();"), /code generation|EvalError/i);
});

test("sandbox detects unawaited agent calls", async () => {
	await assert.rejects(sandbox("agent('forgotten'); return 'done';"), /unawaited agent/);
});

test("agent promises stay in the VM realm and cannot expose host process", async () => {
	await assert.rejects(sandbox(`
		const exposed = agent("ok").then((value) => value);
		return exposed.constructor.constructor("return process")().pid;
	`), /code generation|EvalError/i);
});

test("host never assimilates a VM promise with host-realm callbacks", async () => {
	const result = await sandbox(`
		const originalThen = Promise.prototype.then;
		Promise.prototype.then = function (resolve, reject) {
			try {
				resolve.constructor.constructor("return process")();
				throw new Error("HOST_PROMISE_ASSIMILATION_ESCAPE");
			} catch (error) {
				if (error && error.message === "HOST_PROMISE_ASSIMILATION_ESCAPE") throw error;
			}
			return originalThen.call(this, resolve, reject);
		};
		return "vm-only";
	`);
	assert.equal(result, "vm-only");
});

test("sandbox caps phase updates before they can grow host artifacts", async () => {
	await assert.rejects(sandbox(`
		for (let index = 0; index < 65; index++) phase("phase-" + index);
		return true;
	`), /64 phase updates|phase update exceeded/i);
});

test("parallel preserves input order and caps concurrency at four", async () => {
	let active = 0;
	let maximum = 0;
	const result = await sandbox(`
		const prompts = ["a", "b", "c", "d", "e", "f"];
		const values = await parallel(prompts.map((prompt) => () => agent(prompt)), { concurrency: 99 });
		return values.map((value) => value.output);
	`, {
		onAgent: async (prompt) => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, prompt.charCodeAt(0) % 4 * 5));
			active--;
			return { ok: true, output: prompt };
		},
	});
	assert.deepEqual(result, ["a", "b", "c", "d", "e", "f"]);
	assert.equal(maximum, 4);
});

test("sandbox rejects more than 32 agent requests", async () => {
	await assert.rejects(sandbox(`
		const tasks = Array.from({ length: 33 }, (_, index) => () => agent(String(index)));
		return await parallel(tasks, { concurrency: 4 });
	`), /32 agent calls|request budget/);
});

test("sandbox abort terminates a pending script", async () => {
	const controller = new AbortController();
	const operation = sandbox("await new Promise(() => {}); return 1;", { signal: controller.signal });
	setTimeout(() => controller.abort(new Error("test abort")), 50);
	await assert.rejects(operation, /test abort/);
});

test("delegation client correlates the full V2 tuple and releases listeners", async () => {
	const bus = new EventBus();
	bus.on("prompt-template:subagent:request", (raw) => {
		const request = raw as Record<string, unknown>;
		bus.emit("prompt-template:subagent:started", { ...request, nodeId: "forged" });
		bus.emit("prompt-template:subagent:response", { ...request, nodeId: "forged", status: "completed", result: { kind: "text", text: "wrong" } });
		bus.emit("prompt-template:subagent:started", request);
		bus.emit("prompt-template:subagent:response", {
			version: 2,
			requestId: request.requestId,
			ownerRunId: request.ownerRunId,
			nodeId: request.nodeId,
			status: "completed",
			runId: "child-1",
			result: { kind: "text", text: "right" },
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, turns: 1, toolCalls: 2, durationMs: 10 },
		});
	});
	const baseline = bus.listenerCount();
	const result = await new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-1",
		nodeId: "agent-1",
		prompt: "work",
		call: { agent: "Explore" },
		signal: new AbortController().signal,
	});
	assert.equal(result.output, "right");
	assert.equal(result.runId, "child-1");
	assert.equal(bus.listenerCount(), baseline);
});

test("delegation preserves bounded progress fields and rejects invalid counters", async () => {
	const bus = new EventBus();
	const progress: Array<Record<string, unknown>> = [];
	bus.on("prompt-template:subagent:request", (raw) => {
		const request = raw as Record<string, unknown>;
		bus.emit("prompt-template:subagent:started", request);
		bus.emit("prompt-template:subagent:update", {
			...request,
			runId: "child-progress",
			model: "provider/model\u001b[31m",
			currentTool: "read",
			recentOutput: "working",
			toolCount: 3,
			durationMs: 25,
			tokens: 42,
		});
		bus.emit("prompt-template:subagent:update", {
			...request,
			toolCount: -1,
			durationMs: Number.POSITIVE_INFINITY,
			tokens: 1e20,
		});
		bus.emit("prompt-template:subagent:response", {
			...request,
			status: "completed",
			model: "provider/model",
			result: { kind: "text", text: "done" },
		});
	});
	const result = await new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-progress",
		nodeId: "agent-1",
		prompt: "work",
		call: {},
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value as Record<string, unknown>),
	});
	assert.deepEqual(progress[0], {
		runId: "child-progress",
		model: "provider/model",
		currentTool: "read",
		recentOutput: "working",
		toolCount: 3,
		durationMs: 25,
		tokens: 42,
	});
	assert.deepEqual(progress[1], {});
	assert.equal(result.model, "provider/model");
});

test("delegation rejects oversized terminal text before workflow IPC serialization", async () => {
	const bus = new EventBus();
	bus.on("prompt-template:subagent:request", (raw) => {
		const request = raw as Record<string, unknown>;
		bus.emit("prompt-template:subagent:started", request);
		bus.emit("prompt-template:subagent:response", {
			...request,
			status: "completed",
			result: { kind: "text", text: "x".repeat(300 * 1024) },
		});
	});
	await assert.rejects(new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-large-text",
		nodeId: "agent-1",
		prompt: "work",
		call: {},
		signal: new AbortController().signal,
	}), /text output exceeded/);
});

test("delegation rejects oversized structured collections before stringify", async () => {
	const bus = new EventBus();
	bus.on("prompt-template:subagent:request", (raw) => {
		const request = raw as Record<string, unknown>;
		bus.emit("prompt-template:subagent:started", request);
		bus.emit("prompt-template:subagent:response", {
			...request,
			status: "completed",
			result: { kind: "structured", value: Array.from({ length: 5_000 }, (_, index) => index) },
		});
	});
	await assert.rejects(new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-large-structured",
		nodeId: "agent-1",
		prompt: "work",
		call: { schema: { type: "array" } },
		signal: new AbortController().signal,
	}), /collection limit/);
});

test("delegation cancellation uses the same tuple and returns a typed failure", async () => {
	const bus = new EventBus();
	let cancel: Record<string, unknown> | undefined;
	bus.on("prompt-template:subagent:request", (raw) => bus.emit("prompt-template:subagent:started", raw));
	bus.on("prompt-template:subagent:cancel", (raw) => {
		cancel = raw as Record<string, unknown>;
		bus.emit("prompt-template:subagent:response", { ...cancel, status: "cancelled" });
	});
	const controller = new AbortController();
	const operation = new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-2",
		nodeId: "agent-9",
		prompt: "wait",
		call: {},
		signal: controller.signal,
	});
	controller.abort(new Error("stop"));
	const result = await operation;
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /cancelled/);
	assert.equal(cancel?.ownerRunId, "wf-2");
	assert.equal(cancel?.nodeId, "agent-9");
});

test("delegation cancellation settles when the event bridge throws", async () => {
	const bus = new EventBus();
	bus.on("prompt-template:subagent:request", (raw) => bus.emit("prompt-template:subagent:started", raw));
	const originalEmit = bus.emit.bind(bus);
	bus.emit = (event: string, data: unknown) => {
		if (event === "prompt-template:subagent:cancel") throw new Error("bridge failed");
		originalEmit(event, data);
	};
	const controller = new AbortController();
	const operation = new DelegationClient(bus, process.cwd()).run({
		ownerRunId: "wf-cancel-error",
		nodeId: "agent-1",
		prompt: "wait",
		call: {},
		signal: controller.signal,
	});
	controller.abort(new Error("stop"));
	await assert.rejects(operation, /stop|aborted/i);
	assert.equal(bus.listenerCount(), 1);
});

test("workflow admission atomically caps active workflow runs", () => {
	const admission = new WorkflowAdmission(4);
	const releases = Array.from({ length: 4 }, () => admission.acquire());
	assert.throws(() => admission.acquire(), /At most 4/);
	const firstRelease = releases[0];
	assert.ok(firstRelease);
	firstRelease();
	const release = admission.acquire();
	release();
	for (const dispose of releases) dispose();
});

test("workflow controller deduplicates progress and records its display fields", async () => {
	let changes = 0;
	const delegation = {
		run: async ({ onProgress }: { onProgress: (value: Record<string, unknown>) => void }) => {
			const update = { runId: "child-1", model: "provider/model", currentTool: "read", recentOutput: "working", toolCount: 2, durationMs: 50, tokens: 100 };
			onProgress(update);
			onProgress(update);
			return { ok: true, output: "done", runId: "child-1", model: "provider/model" };
		},
	} as unknown as DelegationClient;
	const controller = new WorkflowController({
		runId: "wf-progress-controller",
		sessionId: "session",
		name: "controller",
		background: false,
		delegation,
		onChange: () => { changes++; },
	});
	await controller.runAgent("work", { model: "requested/model" });
	assert.equal(changes, 4);
	assert.match(controller.details.agents[0]?.lastProgressAt?.toString() ?? "", /^\d+$/);
	assert.deepEqual({ ...controller.details.agents[0], startedAt: 0, endedAt: 0, lastProgressAt: 0 }, {
		index: 1,
		nodeId: "agent-1",
		label: "agent-1",
		agent: "general-purpose",
		model: "provider/model",
		state: "done",
		startedAt: 0,
		endedAt: 0,
		runId: "child-1",
		currentTool: "read",
		preview: "done",
		toolCount: 2,
		durationMs: 50,
		tokens: 100,
		lastProgressAt: 0,
	});
	await controller.finalize({ result: true });
});

test("workflow controller records business failures without failing the protocol", async () => {
	const delegation = {
		run: async ({ prompt }: { prompt: string }) => prompt === "bad"
			? { ok: false, output: "", error: "child failed" }
			: { ok: true, output: prompt },
	} as unknown as DelegationClient;
	const controller = new WorkflowController({
		runId: "wf-controller",
		sessionId: "session",
		name: "controller",
		background: false,
		delegation,
		onChange: () => {},
	});
	const [good, bad] = await Promise.all([controller.runAgent("good"), controller.runAgent("bad")]);
	assert.equal(good.ok, true);
	assert.equal(bad.ok, false);
	await controller.finalize({ result: { good, bad } });
	assert.equal(controller.details.state, "completed");
	assert.deepEqual(controller.details.agents.map((item) => item.state), ["done", "failed"]);
});

test("asynchronous artifact checkpoint failures are captured instead of escaping timers", async () => {
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		prepareWorkflowStorage();
		let captured: Error | undefined;
		const artifacts = new WorkflowArtifacts("wf_timer", "return 1;", undefined, (error) => { captured = error; });
		const details = {
			runId: "wf_timer",
			sessionId: "session",
			name: "timer",
			background: false,
			state: "running" as const,
			startedAt: Date.now(),
			phases: [],
			agents: [],
		};
		artifacts.checkpoint(details, true);
		(details as typeof details & { result: string[] }).result = Array.from({ length: 20 }, () => "x".repeat(100 * 1024));
		artifacts.checkpoint(details);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.match(captured?.message ?? "", /exceeds/);
		assert.equal(artifacts.error, captured);
		artifacts.dispose();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("workflow artifact normalization is additive, bounded, and rejects malformed states", () => {
	const normalized = normalizeWorkflowDetails({
		runId: "forged",
		sessionId: "session",
		name: "old\u001b[31m run",
		background: true,
		state: "running",
		startedAt: 10,
		phases: ["Gather", "Gather", 42],
		result: { nested: { value: "ok" } },
		agents: [
			{
				index: 1,
				nodeId: "agent-1",
				label: "Research",
				agent: "Explore",
				state: "running",
				toolCount: -1,
				tokens: 12,
				usage: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1, durationMs: 1 },
			},
			{ state: "unknown" },
		],
	}, "wf_directory");
	assert.equal(normalized?.runId, "wf_directory");
	assert.equal(normalized?.name, "old run");
	assert.deepEqual(normalized?.phases, ["Gather"]);
	assert.equal(normalized?.agents.length, 1);
	assert.equal(normalized?.agents[0]?.toolCount, undefined);
	assert.equal(normalized?.agents[0]?.tokens, 12);
	assert.equal(normalized?.agents[0]?.usage, undefined);
	assert.deepEqual(normalized?.result, { nested: { value: "ok" } });
	assert.equal(normalizeWorkflowDetails({ state: "unknown", runId: "wf_bad", startedAt: 1 }), undefined);

	const totals = aggregateUsage({
		...normalized!,
		agents: [{ ...normalized!.agents[0]!, usage: { input: Number.NaN, output: -1, cacheRead: 2, cacheWrite: 3, cost: 0.5, turns: 1, toolCalls: 1, durationMs: 10 } }],
	});
	assert.deepEqual(totals, { input: 0, output: 0, cacheRead: 2, cacheWrite: 3, cost: 0.5, turns: 1, toolCalls: 1, durationMs: 10 });
});

test("workflow history refuses symlinked snapshots", () => {
	const agentDir = tempDir();
	const outside = path.join(tempDir(), "outside.json");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		prepareWorkflowStorage();
		const runDir = path.join(agentDir, "workflows", "wf_link");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(outside, JSON.stringify({ runId: "wf_link", sessionId: "session", name: "link", background: false, state: "completed", startedAt: 1, phases: [], agents: [] }));
		fs.symlinkSync(outside, path.join(runDir, "workflow.json"));
		assert.equal(loadWorkflowHistory().some((run) => run.runId === "wf_link"), false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(path.dirname(outside), { recursive: true, force: true });
	}
});

test("workflow retention keeps active runs while capping completed history", () => {
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		prepareWorkflowStorage();
		const root = path.join(agentDir, "workflows");
		const active = path.join(root, "wf_active");
		fs.mkdirSync(active, { mode: 0o700 });
		fs.utimesSync(active, new Date(1), new Date(1));
		const now = Date.now();
		for (let index = 0; index < 101; index++) {
			const directory = path.join(root, `wf_history_${String(index).padStart(3, "0")}`);
			fs.mkdirSync(directory, { mode: 0o700 });
			fs.utimesSync(directory, new Date(now - 10_000 + index), new Date(now - 10_000 + index));
		}
		prepareWorkflowStorage(["wf_active"]);
		const names = fs.readdirSync(root);
		assert.equal(names.includes("wf_active"), true);
		assert.equal(names.length, 101);
		assert.equal(names.includes("wf_history_000"), false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("workflow artifacts are private and discoverable", () => {
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		prepareWorkflowStorage();
		const artifacts = new WorkflowArtifacts("wf_artifact", "return 1;", "{\"value\":1}");
		const details = {
			runId: "wf_artifact",
			sessionId: "session",
			name: "artifact",
			background: false,
			state: "completed" as const,
			startedAt: Date.now(),
			endedAt: Date.now(),
			phases: [],
			agents: [],
			result: { ok: true },
		};
		artifacts.checkpoint(details, true);
		artifacts.event("test", { ok: true });
		artifacts.finish(details);
		assert.equal(fs.statSync(artifacts.directory).mode & 0o777, 0o700);
		for (const file of ["script.js", "args.json", "workflow.json", "events.jsonl", "result.json"]) {
			assert.equal(fs.statSync(path.join(artifacts.directory, file)).mode & 0o777, 0o600);
		}
		assert.equal(loadWorkflowHistory()[0]?.runId, "wf_artifact");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
