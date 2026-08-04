import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import {
	createEscalatingTermination,
	isChildProcessTreeAlive,
	trySignalChildTree,
} from "../extensions/subagents/src/shared/post-exit-stdio-guard.ts";
import { requirePresent } from "../extensions/_shared/runtime/require-present.ts";


function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await delay(20);
	}
	return false;
}

test("abort escalation sends SIGTERM immediately and SIGKILL after the grace period", async () => {
	const signals: NodeJS.Signals[] = [];
	const termination = createEscalatingTermination({
		signal: (signal) => {
			signals.push(signal);
			return true;
		},
		isInactive: () => false,
		hardKillMs: 20,
	});

	termination.terminate();
	assert.deepEqual(signals, ["SIGTERM"]);
	await delay(50);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("abort escalation is idempotent while a termination sequence is armed", async () => {
	const signals: NodeJS.Signals[] = [];
	const termination = createEscalatingTermination({
		signal: (signal) => {
			signals.push(signal);
			return true;
		},
		isInactive: () => false,
		hardKillMs: 20,
	});

	termination.terminate();
	termination.terminate();
	termination.terminate();
	await delay(50);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("abort escalation does nothing when the child is already inactive", async () => {
	const signals: NodeJS.Signals[] = [];
	const termination = createEscalatingTermination({
		signal: (signal) => {
			signals.push(signal);
			return true;
		},
		isInactive: () => true,
		hardKillMs: 10,
	});

	termination.terminate();
	await delay(30);
	assert.deepEqual(signals, []);
});

test("abort escalation suppresses SIGKILL when the child settles during grace", async () => {
	const signals: NodeJS.Signals[] = [];
	let inactive = false;
	const termination = createEscalatingTermination({
		signal: (signal) => {
			signals.push(signal);
			return true;
		},
		isInactive: () => inactive,
		hardKillMs: 20,
	});

	termination.terminate();
	inactive = true;
	await delay(50);
	assert.deepEqual(signals, ["SIGTERM"]);
});

test("disposing abort escalation clears a pending hard kill", async () => {
	const signals: NodeJS.Signals[] = [];
	const termination = createEscalatingTermination({
		signal: (signal) => {
			signals.push(signal);
			return true;
		},
		isInactive: () => false,
		hardKillMs: 20,
	});

	termination.terminate();
	termination.dispose();
	await delay(50);
	assert.deepEqual(signals, ["SIGTERM"]);
});

test("direct SIGINT signaling remains available without a process group", () => {
	const signals: Array<NodeJS.Signals | number | undefined> = [];
	const child = {
		pid: 123,
		kill(signal?: NodeJS.Signals | number) {
			signals.push(signal);
			return true;
		},
	};

	assert.equal(trySignalChildTree(child, "SIGINT"), true);
	assert.deepEqual(signals, ["SIGINT"]);
});

test("POSIX escalation kills a stubborn foreground process group and its descendant", {
	skip: process.platform === "win32",
}, async () => {
	const descendantSource = [
		'process.on("SIGTERM", () => {});',
		'console.log("ready");',
		'setInterval(() => {}, 1000);',
	].join("");
	const leaderSource = [
		'const { spawn } = require("node:child_process");',
		'process.on("SIGTERM", () => {});',
		`const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", "pipe", "ignore"] });`,
		'descendant.stdout.once("data", () => console.log(descendant.pid));',
		'setInterval(() => {}, 1000);',
	].join("");
	const leader = spawn(process.execPath, ["-e", leaderSource], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	let descendantPid: number | undefined;

	try {
		const [chunk] = await once(requirePresent(leader.stdout), "data") as [Buffer];
		descendantPid = Number(chunk.toString("utf8").trim());
		assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
		assert.equal(isChildProcessTreeAlive(leader, { processGroup: true }), true);

		const termination = createEscalatingTermination({
			signal: (signal) => trySignalChildTree(leader, signal, { processGroup: true }),
			isInactive: () => !isChildProcessTreeAlive(leader, { processGroup: true }),
			hardKillMs: 40,
		});
		termination.terminate();

		const [code, signal] = await Promise.race([
			once(leader, "close"),
			delay(2_000).then(() => { throw new Error("Timed out waiting for process-group termination"); }),
		]) as [number | null, NodeJS.Signals | null];
		assert.equal(code, null);
		assert.equal(signal, "SIGKILL");
		assert.equal(await waitForProcessExit(descendantPid), true);
		assert.equal(isChildProcessTreeAlive(leader, { processGroup: true }), false);
	} finally {
		if (leader.pid) {
			try { process.kill(-leader.pid, "SIGKILL"); } catch {}
		}
		if (descendantPid) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
	}
});
