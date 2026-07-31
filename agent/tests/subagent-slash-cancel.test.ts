import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": piPackage,
		"@earendil-works/pi-agent-core": join(piPackage, "node_modules/@earendil-works/pi-agent-core"),
		"@earendil-works/pi-ai": join(piPackage, "node_modules/@earendil-works/pi-ai"),
		"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});
const slashCommands = await jiti.import<{
	isSlashSubagentCancelInput: (input: string) => boolean;
	requestSlashRun: (pi: unknown, ctx: unknown, requestId: string, params: unknown) => Promise<unknown>;
}>("../extensions/community/pi-subagents/src/slash/slash-commands.ts");

test("slash subagent cancellation accepts Escape", () => {
	assert.equal(slashCommands.isSlashSubagentCancelInput("\u001b"), true);
});

test("slash subagent cancellation accepts Ctrl+C", () => {
	assert.equal(slashCommands.isSlashSubagentCancelInput("\u0003"), true);
});

test("slash subagent cancellation ignores ordinary input", () => {
	assert.equal(slashCommands.isSlashSubagentCancelInput("c"), false);
	assert.equal(slashCommands.isSlashSubagentCancelInput("x"), false);
});

test("Ctrl+C emits slash cancellation and releases input and event listeners", async () => {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const events = {
		on(name: string, handler: (value: unknown) => void) {
			const handlers = listeners.get(name) ?? new Set<(value: unknown) => void>();
			handlers.add(handler);
			listeners.set(name, handlers);
			return () => handlers.delete(handler);
		},
		emit(name: string, value: unknown) {
			for (const handler of [...(listeners.get(name) ?? [])]) handler(value);
		},
	};
	let terminalInput: ((input: string) => { consume: true } | undefined) | undefined;
	let inputDisposed = false;
	let cancelPayload: unknown;
	events.on("subagent:slash:request", (value) => {
		const requestId = (value as { requestId: string }).requestId;
		events.emit("subagent:slash:started", { requestId });
	});
	events.on("subagent:slash:cancel", (value) => {
		cancelPayload = value;
	});
	const promise = slashCommands.requestSlashRun(
		{ events },
		{
			hasUI: true,
			ui: {
				onTerminalInput(handler: typeof terminalInput) {
					terminalInput = handler;
					return () => { inputDisposed = true; };
				},
				setStatus() {},
			},
		},
		"slash-request-1",
		{ agent: "Explore", task: "wait" },
	);

	assert.ok(terminalInput);
	assert.deepEqual(terminalInput("\u0003"), { consume: true });
	await assert.rejects(promise, /Cancelled/);
	assert.deepEqual(cancelPayload, { requestId: "slash-request-1" });
	assert.equal(inputDisposed, true);
	assert.equal(listeners.get("subagent:slash:started")?.size, 0);
	assert.equal(listeners.get("subagent:slash:response")?.size, 0);
	assert.equal(listeners.get("subagent:slash:update")?.size, 0);
});
