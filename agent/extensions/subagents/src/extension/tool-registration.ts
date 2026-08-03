import type { AgentToolResult as CoreAgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const failuresByApi = new WeakMap<ExtensionAPI, Map<string, string>>();

function stripInternalError<T>(result: CoreAgentToolResult<T>): CoreAgentToolResult<T> {
	if (!Object.hasOwn(result, "isError")) return result;
	const clean = { ...result };
	Reflect.deleteProperty(clean, "isError");
	return clean;
}

function failuresFor(pi: ExtensionAPI): Map<string, string> {
	const existing = failuresByApi.get(pi);
	if (existing) return existing;
	const failures = new Map<string, string>();
	failuresByApi.set(pi, failures);
	pi.on("tool_result", (event) => {
		if (failures.get(event.toolCallId) !== event.toolName) return;
		failures.delete(event.toolCallId);
		return { isError: true };
	});
	return failures;
}

/** Register a subagents-owned tool while translating its internal error flag to Pi's event API. */
export function registerSubagentTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	const failures = failuresFor(pi);
	const execute = tool.execute.bind(tool);
	pi.registerTool({
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			failures.delete(toolCallId);
			const forwardUpdate = onUpdate
				? (result: CoreAgentToolResult<TDetails>) => onUpdate(stripInternalError(result))
				: undefined;
			try {
				const result = await execute(toolCallId, params, signal, forwardUpdate, ctx);
				if (Reflect.get(result, "isError") === true) failures.set(toolCallId, tool.name);
				return stripInternalError(result);
			} catch (error) {
				failures.delete(toolCallId);
				throw error;
			}
		},
	});
}
