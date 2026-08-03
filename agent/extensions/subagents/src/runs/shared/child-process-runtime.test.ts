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

describe("shared child process runtime", () => {
	it("parses events, bounds tails, and completes normal exits", async () => {
		const events: string[] = [];
		const result = await node(`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"done"}]}}))`, {
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
		const budgeted = await node(`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"toolUse",content:[{type:"text",text:"more"}]}}));${linger}`, {
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
		const result = await node(`console.log(JSON.stringify({type:"watchdog"}));console.log(JSON.stringify({type:"agent_settled"}));${linger}`, {
			watchdogTailMs: 20,
			onEvent(event, controls) {
				if (event.type === "watchdog") controls.setWatchdogActive(true);
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
