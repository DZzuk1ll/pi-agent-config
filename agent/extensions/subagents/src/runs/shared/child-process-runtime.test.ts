import { describe, expect, it } from "vitest";
import { resolveRuntimeSignalRoute, runChildProcess } from "./child-process-runtime.ts";

function node(source: string, options: Partial<Parameters<typeof runChildProcess>[0]> = {}) {
	return runChildProcess({
		command: process.execPath,
		args: ["-e", source],
		cwd: process.cwd(),
		env: { ...process.env },
		finalDrainMs: 20,
		termGraceMs: 20,
		hardKillMs: 40,
		...options,
	});
}

const linger = "setInterval(() => {}, 1000)";
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(stopReason: "stop" | "toolUse", text = "") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason,
		timestamp: 1,
	};
}

describe("shared child process runtime", () => {
	it("keeps invalid JSONL values as bounded raw stdout without lifecycle callbacks", async () => {
		const events: string[] = [];
		const raw: string[] = [];
		const lines = [
			"null",
			"[]",
			JSON.stringify("plain"),
			"not-json",
			JSON.stringify({ type: "message_start" }),
			JSON.stringify({ type: "message_update", message: null }),
			JSON.stringify({ type: "message_end", message: { role: 1, content: [] } }),
			JSON.stringify({ type: "message_end", message: assistantMessage("stop") }),
		];
		const result = await node(`for (const line of ${JSON.stringify(lines)}) console.log(line)`, {
			onEvent: (event) => events.push(event.type ?? ""),
			onRawStdoutLine: (line) => raw.push(line),
		});

		expect(events).toEqual(["message_end"]);
		expect(raw).toEqual(lines.slice(0, -1));
		expect(result.turnCount).toBe(1);
		expect(result.terminalSeen).toBe(true);
	});

	it("rejects malformed nested usage and tool events while accepting string user messages", async () => {
		const malformedUsage = {
			...assistantMessage("stop"),
			usage: { ...usage, input: "oops" },
		};
		const lines = [
			JSON.stringify({ type: "message_end", message: malformedUsage }),
			JSON.stringify({ type: "message_end", message: { ...assistantMessage("stop"), content: [{ type: "image", data: "x", mimeType: "image/png" }] } }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "call", toolName: 42, args: {} }),
			JSON.stringify({ type: "agent_end", willRetry: false, messages: [{}] }),
			JSON.stringify({ type: "message_start", message: { role: "user", content: "hello", timestamp: 1 } }),
			JSON.stringify({
				type: "message_end",
				message: { role: "custom", customType: "notice", content: "keep going", display: true, timestamp: 2 },
			}),
		];
		const events: string[] = [];
		const raw: string[] = [];
		const result = await node(`for (const line of ${JSON.stringify(lines)}) console.log(line)`, {
			onEvent: (event) => events.push(event.type ?? ""),
			onRawStdoutLine: (line) => raw.push(line),
		});

		expect(events).toEqual(["message_start", "message_end"]);
		expect(raw).toEqual(lines.slice(0, 4));
		expect(result.turnCount).toBe(0);
	});

	it("keeps malformed non-lifecycle session events out of callbacks", async () => {
		const lines = [
			JSON.stringify({ type: "queue_update", steering: 42, followUp: [] }),
			JSON.stringify({ type: "compaction_start", reason: 42 }),
			JSON.stringify({ type: "auto_retry_start", attempt: "bad", maxAttempts: 3, delayMs: 10, errorMessage: "retry" }),
			JSON.stringify({ type: "bash_execution_update", delta: 42 }),
			JSON.stringify({ type: "queue_update", steering: ["next"], followUp: [] }),
		];
		const events: string[] = [];
		const raw: string[] = [];
		await node(`for (const line of ${JSON.stringify(lines)}) console.log(line)`, {
			onEvent: (event) => events.push(event.type),
			onRawStdoutLine: (line) => raw.push(line),
		});

		expect(events).toEqual(["queue_update"]);
		expect(raw).toEqual(lines.slice(0, 4));
	});

	it("parses events, bounds tails, and completes normal exits", async () => {
		const events: string[] = [];
		const event = { type: "message_end", message: assistantMessage("stop", "done") };
		const result = await node(`console.log(${JSON.stringify(JSON.stringify(event))})`, {
			onEvent: (event) => events.push(event.type ?? ""),
		});
		expect(events).toEqual(["message_end"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("final-drains a child that lingers after a terminal event", async () => {
		const result = await node(`console.log(JSON.stringify({type:"agent_settled"}));${linger}`);
		expect(result.terminationReason).toBe("final-drain");
		expect(result.forcedTermination).toBe(true);
	});

	it("handles parent cancellation and timeout through escalation", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const cancelled = await node(`process.on("SIGINT",()=>{});process.on("SIGTERM",()=>process.exit(0));${linger}`, { signal: controller.signal });
		expect(cancelled.terminationReason).toBe("cancel");
		const timedOut = await node(linger, { timeoutMs: 20 });
		expect(timedOut.terminationReason).toBe("timeout");
	});

	it("enforces turn budgets and stdout protocol limits", async () => {
		const event = { type: "message_end", message: assistantMessage("toolUse", "more") };
		const budgeted = await node(`console.log(${JSON.stringify(JSON.stringify(event))});${linger}`, {
			turnBudget: { maxTurns: 1, graceTurns: 0 },
		});
		expect(budgeted.terminationReason).toBe("turn-budget");
		expect(budgeted.turnBudget?.outcome).toBe("exceeded");
		const overflow = await node(`process.stdout.write("x".repeat(100));${linger}`, { maxStdoutLineBytes: 16 });
		expect(overflow.terminationReason).toBe("protocol");
		expect(overflow.protocolError?.stream).toBe("stdout");
	});

	it("waits for the watchdog tail before final drain", async () => {
		let tailed = false;
		const watchdogEvent = { type: "subagent.watchdog.status", seq: 1, phase: "reviewing", ts: 1, followUpPending: true };
		const result = await node(`console.log(${JSON.stringify(JSON.stringify(watchdogEvent))});console.log(JSON.stringify({type:"agent_settled"}));${linger}`, {
			watchdogTailMs: 20,
			onEvent(event, controls) {
				if (event.type === "subagent.watchdog.status") controls.setWatchdogActive(true);
			},
			onWatchdogTail: () => { tailed = true; },
		});
		expect(tailed).toBe(true);
		expect(result.terminationReason).toBe("final-drain");
	});

	it("selects POSIX process groups and Windows tree termination without changing SIGINT", () => {
		expect(resolveRuntimeSignalRoute("darwin", true, "SIGTERM")).toBe("process-group");
		expect(resolveRuntimeSignalRoute("win32", false, "SIGTERM")).toBe("windows-tree");
		expect(resolveRuntimeSignalRoute("win32", false, "SIGINT")).toBe("direct");
		expect(resolveRuntimeSignalRoute("linux", false, "SIGKILL")).toBe("direct");
	});
});
