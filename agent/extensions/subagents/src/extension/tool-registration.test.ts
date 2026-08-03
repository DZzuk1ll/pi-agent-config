import {
	ExtensionRunner,
	type Extension,
	type ExtensionAPI,
	type ExtensionRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { registerSubagentTool } from "./tool-registration.ts";

function fakePi() {
	const tools = new Map<string, ToolDefinition>();
	const hooks: Array<(event: { toolCallId: string; toolName: string }) => unknown> = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(name: string, hook: (event: { toolCallId: string; toolName: string }) => unknown) {
			if (name === "tool_result") hooks.push(hook);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, hooks };
}

describe("registerSubagentTool", () => {
	it("marks the final host tool result as an error without replacing its payload", async () => {
		const fake = fakePi();
		registerSubagentTool(fake.pi, {
			name: "subagent",
			label: "Subagent",
			description: "test",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "failed" }], details: { reason: "boom" }, isError: true };
			},
		});
		const tool = fake.tools.get("subagent")!;
		const internal = await tool.execute("host-id", {}, undefined, undefined, {} as never);
		const extension = {
			path: "test",
			resolvedPath: "test",
			sourceInfo: { source: "path", path: "test" },
			handlers: new Map([["tool_result", fake.hooks]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		} as unknown as Extension;
		const runner = new ExtensionRunner([extension], {} as ExtensionRuntime, process.cwd(), {} as never, {} as never);
		const hostResult = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "host-id",
			toolName: "subagent",
			input: {},
			content: internal.content,
			details: internal.details,
			isError: false,
		});
		expect(hostResult).toEqual({
			content: [{ type: "text", text: "failed" }],
			details: { reason: "boom" },
			isError: true,
			usage: undefined,
		});
	});

	it("restores failures by toolCallId while preserving host content and details", async () => {
		const fake = fakePi();
		const schema = Type.Object({ fail: Type.Boolean(), delay: Type.Integer() });
		registerSubagentTool(fake.pi, {
			name: "subagent",
			label: "Subagent",
			description: "test",
			parameters: schema,
			async execute(_id, params) {
				await new Promise((resolve) => setTimeout(resolve, params.delay));
				return {
					content: [{ type: "text", text: params.fail ? "failed" : "ok" }],
					details: { value: params.delay },
					...(params.fail ? { isError: true } : {}),
				};
			},
		});
		const tool = fake.tools.get("subagent")!;
		const signal = new AbortController().signal;
		const [failed, ok] = await Promise.all([
			tool.execute("failure-id", { fail: true, delay: 5 }, signal, undefined, {} as never),
			tool.execute("success-id", { fail: false, delay: 0 }, signal, undefined, {} as never),
		]);
		expect(failed).toEqual({ content: [{ type: "text", text: "failed" }], details: { value: 5 } });
		expect(ok).toEqual({ content: [{ type: "text", text: "ok" }], details: { value: 0 } });
		expect(fake.hooks[0]!({ toolCallId: "success-id", toolName: "subagent" })).toBeUndefined();
		expect(fake.hooks[0]!({ toolCallId: "failure-id", toolName: "subagent" })).toEqual({ isError: true });
		expect(fake.hooks[0]!({ toolCallId: "failure-id", toolName: "subagent" })).toBeUndefined();
	});

	it("does not leak partial, thrown, or superseded failure state", async () => {
		const fake = fakePi();
		const schema = Type.Object({ mode: Type.String() });
		registerSubagentTool(fake.pi, {
			name: "subagent_wait",
			label: "Wait",
			description: "test",
			parameters: schema,
			async execute(_id, params, _signal, onUpdate) {
				const partial = { content: [{ type: "text" as const, text: "partial" }], details: {}, isError: true };
				onUpdate?.(partial);
				if (params.mode === "throw") throw new Error("boom");
				return { content: [{ type: "text", text: params.mode }], details: {}, ...(params.mode === "fail" ? { isError: true } : {}) };
			},
		});
		const tool = fake.tools.get("subagent_wait")!;
		const updates: unknown[] = [];
		await tool.execute("same", { mode: "fail" }, undefined, (result) => updates.push(result), {} as never);
		await tool.execute("same", { mode: "ok" }, undefined, (result) => updates.push(result), {} as never);
		expect(updates).toEqual([
			{ content: [{ type: "text", text: "partial" }], details: {} },
			{ content: [{ type: "text", text: "partial" }], details: {} },
		]);
		expect(fake.hooks[0]!({ toolCallId: "same", toolName: "subagent_wait" })).toBeUndefined();
		await expect(tool.execute("thrown", { mode: "throw" }, undefined, undefined, {} as never)).rejects.toThrow("boom");
		expect(fake.hooks[0]!({ toolCallId: "thrown", toolName: "subagent_wait" })).toBeUndefined();
	});
});
