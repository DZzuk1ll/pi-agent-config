import { randomUUID } from "node:crypto";
import { abortError } from "../shared/lifecycle.ts";
import { sanitizeForDisplay } from "../shared/text.ts";

const VERSION = 2 as const;
const REQUEST_EVENT = "prompt-template:subagent:request";
const STARTED_EVENT = "prompt-template:subagent:started";
const UPDATE_EVENT = "prompt-template:subagent:update";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const CANCEL_EVENT = "prompt-template:subagent:cancel";
const BRIDGE_START_TIMEOUT_MS = 1_000;
const CANCEL_SETTLE_TIMEOUT_MS = 2_000;

export type WorkflowThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DelegationEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export interface AgentCallResult {
	ok: boolean;
	output: string;
	structured?: unknown;
	error?: string;
	usage?: AgentUsage;
	runId?: string;
}

export interface AgentCallOptions {
	agent?: string;
	label?: string;
	phase?: string;
	model?: string;
	thinking?: WorkflowThinking;
	schema?: Record<string, unknown>;
}

export interface DelegationProgress {
	runId?: string;
	currentTool?: string;
	recentOutput?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

interface DelegationRequest {
	version: typeof VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh";
	cwd: string;
	model?: string;
	thinking?: WorkflowThinking;
	artifacts: true;
	result: { kind: "text" } | { kind: "structured"; schema: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(value: unknown, request: DelegationRequest): value is Record<string, unknown> {
	return isRecord(value)
		&& value.version === VERSION
		&& value.requestId === request.requestId
		&& value.ownerRunId === request.ownerRunId
		&& value.nodeId === request.nodeId;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanAgentOutput(value: string): string {
	const lines = sanitizeForDisplay(value).trimEnd().split("\n");
	while (lines.length > 0 && (!lines.at(-1)?.trim() || /^[✻*]\s+(?:Done|Worked)\s+(?:for|in)\s+\d/i.test(lines.at(-1)!.trim()))) {
		lines.pop();
	}
	return lines.join("\n").trimEnd();
}

function usageField(value: unknown): AgentUsage | undefined {
	if (!isRecord(value)) return undefined;
	const keys: Array<keyof AgentUsage> = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns", "toolCalls", "durationMs"];
	if (!keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) return undefined;
	return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as AgentUsage;
}

function terminalResult(value: Record<string, unknown>): AgentCallResult {
	const status = stringField(value.status) ?? "failed";
	if (status === "invalid_request" || status === "unavailable_context" || status === "duplicate_node") {
		throw new Error(stringField(value.error) ?? `Subagent delegation protocol failed: ${status}`);
	}
	const runId = stringField(value.runId);
	const usage = usageField(value.usage);
	if (status !== "completed") {
		return {
			ok: false,
			output: "",
			error: sanitizeForDisplay(stringField(value.error) ?? `Subagent ended with status ${status}`),
			...(usage ? { usage } : {}),
			...(runId ? { runId } : {}),
		};
	}
	if (!isRecord(value.result)) throw new Error("Subagent delegation completed without a result envelope");
	if (value.result.kind === "text" && typeof value.result.text === "string") {
		return { ok: true, output: cleanAgentOutput(value.result.text), ...(usage ? { usage } : {}), ...(runId ? { runId } : {}) };
	}
	if (value.result.kind === "structured" && Object.hasOwn(value.result, "value")) {
		return { ok: true, output: JSON.stringify(value.result.value), structured: value.result.value, ...(usage ? { usage } : {}), ...(runId ? { runId } : {}) };
	}
	throw new Error("Subagent delegation returned a malformed result envelope");
}

export class DelegationClient {
	private readonly events: DelegationEvents;
	private readonly cwd: string;

	constructor(events: DelegationEvents, cwd: string) {
		this.events = events;
		this.cwd = cwd;
	}

	run(options: {
		ownerRunId: string;
		nodeId: string;
		prompt: string;
		call: AgentCallOptions;
		signal: AbortSignal;
		onProgress?: (progress: DelegationProgress) => void;
	}): Promise<AgentCallResult> {
		if (!options.prompt.trim()) return Promise.reject(new Error("agent() requires a non-empty prompt"));
		const request: DelegationRequest = {
			version: VERSION,
			requestId: randomUUID(),
			ownerRunId: options.ownerRunId,
			nodeId: options.nodeId,
			agent: options.call.agent?.trim() || "general-purpose",
			task: options.prompt,
			context: "fresh",
			cwd: this.cwd,
			...(options.call.model ? { model: options.call.model } : {}),
			...(options.call.thinking ? { thinking: options.call.thinking } : {}),
			artifacts: true,
			result: options.call.schema ? { kind: "structured", schema: options.call.schema } : { kind: "text" },
		};

		return new Promise<AgentCallResult>((resolve, reject) => {
			let settled = false;
			let started = false;
			let bridgeTimer: ReturnType<typeof setTimeout> | undefined;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanups: Array<() => void> = [];
			const subscribe = (event: string, handler: (data: unknown) => void) => {
				const cleanup = this.events.on(event, handler);
				if (typeof cleanup === "function") cleanups.push(cleanup);
			};
			const cleanup = () => {
				if (bridgeTimer) clearTimeout(bridgeTimer);
				if (cancelTimer) clearTimeout(cancelTimer);
				options.signal.removeEventListener("abort", onAbort);
				for (const dispose of cleanups.splice(0)) dispose();
			};
			const finish = (error?: unknown, result?: AgentCallResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error instanceof Error ? error : new Error(String(error)));
				else resolve(result!);
			};
			const onAbort = () => {
				this.events.emit(CANCEL_EVENT, {
					version: VERSION,
					requestId: request.requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
				});
				cancelTimer = setTimeout(() => finish(abortError(options.signal)), CANCEL_SETTLE_TIMEOUT_MS);
				cancelTimer.unref?.();
			};

			subscribe(STARTED_EVENT, (value) => {
				if (!matches(value, request) || settled) return;
				started = true;
				if (bridgeTimer) clearTimeout(bridgeTimer);
			});
			subscribe(UPDATE_EVENT, (value) => {
				if (!matches(value, request) || settled || !options.onProgress) return;
				options.onProgress({
					...(stringField(value.runId) ? { runId: stringField(value.runId) } : {}),
					...(stringField(value.currentTool) ? { currentTool: stringField(value.currentTool) } : {}),
					...(stringField(value.recentOutput) ? { recentOutput: sanitizeForDisplay(stringField(value.recentOutput)!) } : {}),
					...(typeof value.toolCount === "number" ? { toolCount: value.toolCount } : {}),
					...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
					...(typeof value.tokens === "number" ? { tokens: value.tokens } : {}),
				});
			});
			subscribe(RESPONSE_EVENT, (value) => {
				if (!matches(value, request) || settled) return;
				try {
					finish(undefined, terminalResult(value));
				} catch (error) {
					finish(error);
				}
			});
			options.signal.addEventListener("abort", onAbort, { once: true });
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			bridgeTimer = setTimeout(() => {
				if (!started) finish(new Error("pi-subagents V2 delegation bridge is unavailable; run /subagents-doctor"));
			}, BRIDGE_START_TIMEOUT_MS);
			bridgeTimer.unref?.();
			try {
				this.events.emit(REQUEST_EVENT, request);
			} catch (error) {
				finish(error);
			}
		});
	}
}
