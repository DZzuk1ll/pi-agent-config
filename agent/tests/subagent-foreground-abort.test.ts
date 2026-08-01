import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = path.join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": piPackage,
		"@earendil-works/pi-agent-core": path.join(piPackage, "node_modules/@earendil-works/pi-agent-core"),
		"@earendil-works/pi-ai": path.join(piPackage, "node_modules/@earendil-works/pi-ai"),
		"@earendil-works/pi-tui": path.join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});
const execution = await jiti.import<{
	runSync: (runtimeCwd: string, agents: unknown[], agentName: string, task: string, options: Record<string, unknown>) => Promise<{ exitCode: number; stopped?: boolean; error?: string }>;
}>("../extensions/subagents/src/runs/foreground/execution.ts");
const chainExecution = await jiti.import<{
	executeChain: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}>("../extensions/subagents/src/runs/foreground/chain-execution.ts");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFiles(directory: string, count: number, timeoutMs = 5_000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const files = fs.readdirSync(directory).filter((file) => file.endsWith(".json"));
		if (files.length >= count) return files;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${count} foreground fixture process(es)`);
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true;
		await delay(20);
	}
	return false;
}

function writeFixture(root: string): string {
	const fixture = path.join(root, "stubborn-pi-fixture.cjs");
	fs.writeFileSync(fixture, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const descendantSource = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
const descendant = spawn(process.execPath, ["-e", descendantSource], { stdio: ["ignore", "pipe", "ignore"] });
descendant.stdout.once("data", () => {
  fs.writeFileSync(path.join(process.env.PI_SUBAGENT_TEST_PID_DIR, process.pid + ".json"), JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
	return fixture;
}

function writeIntercomFixture(root: string): string {
	const fixture = path.join(root, "intercom-pi-fixture.cjs");
	fs.writeFileSync(fixture, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => {});
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "intercom", args: {} }));
fs.writeFileSync(path.join(process.env.PI_SUBAGENT_TEST_PID_DIR, process.pid + ".json"), JSON.stringify({ leader: process.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
	return fixture;
}

function writeCooperativeFixture(root: string): string {
	const fixture = path.join(root, "cooperative-pi-fixture.cjs");
	fs.writeFileSync(fixture, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => process.exit(0));
fs.writeFileSync(path.join(process.env.PI_SUBAGENT_TEST_PID_DIR, process.pid + ".json"), JSON.stringify({ leader: process.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
	return fixture;
}

function fixtureAgent(filePath: string): Record<string, unknown> {
	return {
		name: "fixture",
		description: "foreground cancellation fixture",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "",
		source: "project",
		filePath,
	};
}

test("runSync Ctrl+C abort hard-kills a stubborn child tree", { skip: process.platform === "win32" }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;
	let pids: { leader: number; descendant: number } | undefined;

	try {
		const controller = new AbortController();
		const running = execution.runSync(root, [fixtureAgent(fixture)], "fixture", "wait", {
			runId: "foreground-abort-test",
			cwd: root,
			signal: controller.signal,
			acceptance: false,
		});
		const [pidFile] = await waitForFiles(pidDir, 1);
		pids = JSON.parse(fs.readFileSync(path.join(pidDir, pidFile!), "utf8")) as { leader: number; descendant: number };
		assert.equal(processExists(pids.leader), true);
		assert.equal(processExists(pids.descendant), true);

		const abortedAt = Date.now();
		controller.abort();
		const result = await Promise.race([
			running,
			delay(6_000).then(() => { throw new Error("runSync did not settle after Ctrl+C abort"); }),
		]);
		const elapsed = Date.now() - abortedAt;
		assert.notEqual(result.exitCode, 0);
		assert.ok(elapsed >= 2_500 && elapsed < 5_500, `expected hard-kill escalation near 3s, got ${elapsed}ms`);
		assert.equal(await waitForExit(pids.leader), true);
		assert.equal(await waitForExit(pids.descendant), true);
	} finally {
		if (pids) {
			try { process.kill(-pids.leader, "SIGKILL"); } catch {}
			try { process.kill(pids.descendant, "SIGKILL"); } catch {}
		}
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a shared foreground abort terminates every active parallel child", { skip: process.platform === "win32" }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-parallel-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;
	const observed: Array<{ leader: number; descendant: number }> = [];

	try {
		const controller = new AbortController();
		const agents = [fixtureAgent(fixture)];
		const runs = [0, 1].map((index) => execution.runSync(root, agents, "fixture", `wait-${index}`, {
			runId: `parallel-abort-test-${index}`,
			index,
			cwd: root,
			signal: controller.signal,
			acceptance: false,
		}));
		const pidFiles = await waitForFiles(pidDir, 2);
		for (const pidFile of pidFiles) {
			observed.push(JSON.parse(fs.readFileSync(path.join(pidDir, pidFile), "utf8")) as { leader: number; descendant: number });
		}
		controller.abort();
		const results = await Promise.race([
			Promise.all(runs),
			delay(6_000).then(() => { throw new Error("Parallel foreground children did not settle after abort"); }),
		]);
		assert.equal(results.length, 2);
		assert.ok(results.every((result) => result.exitCode !== 0));
		for (const pids of observed) {
			assert.equal(await waitForExit(pids.leader), true);
			assert.equal(await waitForExit(pids.descendant), true);
		}
	} finally {
		for (const pids of observed) {
			try { process.kill(-pids.leader, "SIGKILL"); } catch {}
			try { process.kill(pids.descendant, "SIGKILL"); } catch {}
		}
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an already-aborted foreground chain does not start its first step", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-chain-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;

	try {
		const controller = new AbortController();
		controller.abort();
		const result = await chainExecution.executeChain({
			chain: [
				{ agent: "fixture", task: "first" },
				{ agent: "fixture", task: "second" },
			],
			agents: [fixtureAgent(fixture)],
			ctx: {
				cwd: root,
				hasUI: false,
				model: undefined,
				modelRegistry: { getAvailable: () => [] },
			},
			signal: controller.signal,
			runId: "pre-aborted-chain",
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(root, "artifacts"),
			artifactConfig: { enabled: false },
			controlConfig: { enabled: false },
			maxSubagentDepth: 1,
		});
		assert.equal(result.content[0]?.text, "Chain cancelled");
		await delay(100);
		assert.deepEqual(fs.readdirSync(pidDir), []);
	} finally {
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a cooperative SIGTERM exit is still reported as parent cancellation", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cooperative-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeCooperativeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;

	try {
		const controller = new AbortController();
		const running = execution.runSync(root, [fixtureAgent(fixture)], "fixture", "wait", {
			runId: "cooperative-abort-test",
			cwd: root,
			signal: controller.signal,
			acceptance: false,
		});
		await waitForFiles(pidDir, 1);
		controller.abort();
		const result = await running;
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopped, true);
		assert.match(result.error ?? "", /cancelled by parent/i);
	} finally {
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an already-aborted runSync does not spawn a child", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-pre-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;

	try {
		const controller = new AbortController();
		controller.abort();
		const result = await execution.runSync(root, [fixtureAgent(fixture)], "fixture", "wait", {
			runId: "pre-aborted-run",
			cwd: root,
			signal: controller.signal,
			acceptance: false,
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopped, true);
		assert.deepEqual(fs.readdirSync(pidDir), []);
	} finally {
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a cooperative active chain returns cancellation instead of completion", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-chain-cooperative-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeCooperativeFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;

	try {
		const controller = new AbortController();
		const running = chainExecution.executeChain({
			chain: [{ agent: "fixture", task: "first", acceptance: false }],
			agents: [fixtureAgent(fixture)],
			ctx: {
				cwd: root,
				hasUI: false,
				model: undefined,
				modelRegistry: { getAvailable: () => [] },
				sessionManager: { getSessionId: () => "parent-test-session" },
			},
			signal: controller.signal,
			runId: "cooperative-chain-abort",
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(root, "artifacts"),
			artifactConfig: { enabled: false },
			controlConfig: { enabled: false },
			maxSubagentDepth: 1,
		});
		await waitForFiles(pidDir, 1);
		controller.abort();
		const result = await running;
		assert.equal(result.content[0]?.text, "Chain cancelled");
	} finally {
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("parent abort wins an intercom detach race", { skip: process.platform === "win32" }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-intercom-abort-test-"));
	const pidDir = path.join(root, "pids");
	fs.mkdirSync(pidDir);
	const fixture = writeIntercomFixture(root);
	const previousBinary = process.env.PI_SUBAGENT_PI_BINARY;
	const previousPidDir = process.env.PI_SUBAGENT_TEST_PID_DIR;
	process.env.PI_SUBAGENT_PI_BINARY = fixture;
	process.env.PI_SUBAGENT_TEST_PID_DIR = pidDir;
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const responses: unknown[] = [];
	const events = {
		on(name: string, handler: (payload: unknown) => void) {
			const handlers = listeners.get(name) ?? new Set<(payload: unknown) => void>();
			handlers.add(handler);
			listeners.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, payload: unknown) {
			if (name === "pi-intercom:detach-response") responses.push(payload);
			for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
		},
	};
	let leaderPid: number | undefined;

	try {
		const controller = new AbortController();
		const running = execution.runSync(root, [fixtureAgent(fixture)], "fixture", "wait", {
			runId: "intercom-abort-race",
			cwd: root,
			signal: controller.signal,
			acceptance: false,
			allowIntercomDetach: true,
			intercomEvents: events,
		});
		const [pidFile] = await waitForFiles(pidDir, 1);
		leaderPid = (JSON.parse(fs.readFileSync(path.join(pidDir, pidFile!), "utf8")) as { leader: number }).leader;
		controller.abort();
		events.emit("pi-intercom:detach-request", {
			requestId: "detach-after-abort",
			runId: "intercom-abort-race",
			agent: "fixture",
			childIndex: 0,
		});
		const result = await running;
		assert.equal(result.stopped, true);
		assert.deepEqual(responses, [{
			requestId: "detach-after-abort",
			accepted: false,
			runId: "intercom-abort-race",
			agent: "fixture",
			childIndex: 0,
		}]);
		assert.equal(await waitForExit(leaderPid), true);
	} finally {
		if (leaderPid) {
			try { process.kill(-leaderPid, "SIGKILL"); } catch {}
		}
		if (previousBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
		else process.env.PI_SUBAGENT_PI_BINARY = previousBinary;
		if (previousPidDir === undefined) delete process.env.PI_SUBAGENT_TEST_PID_DIR;
		else process.env.PI_SUBAGENT_TEST_PID_DIR = previousPidDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
