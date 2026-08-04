import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { abortError } from "../_shared/runtime/lifecycle.ts";
import { sanitizeForDisplay, truncateUtf8, utf8ByteLength } from "../_shared/runtime/text.ts";
import { requirePresent } from "../_shared/runtime/require-present.ts";


const VERSION = 2 as const;
const REQUEST_EVENT = "prompt-template:subagent:request";
const STARTED_EVENT = "prompt-template:subagent:started";
const UPDATE_EVENT = "prompt-template:subagent:update";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const CANCEL_EVENT = "prompt-template:subagent:cancel";
const BRIDGE_START_TIMEOUT_MS = 1_000;
const CANCEL_SETTLE_TIMEOUT_MS = 2_000;
const MAX_AGENT_OUTPUT_BYTES = 256 * 1024;
const MAX_AGENT_ERROR_BYTES = 16 * 1024;
const MAX_PROGRESS_BYTES = 16 * 1024;
const MAX_STRUCTURED_RAW_BYTES = 48 * 1024;
const MAX_STRUCTURED_NODES = 4_096;
const MAX_PROGRESS_COUNT = 1_000_000_000;
const MAX_PROGRESS_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROGRESS_TOKENS = 1_000_000_000_000;
const MAX_AGENT_CWD_BYTES = 4_096;

export type WorkflowThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DelegationEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | undefined;
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
	model?: string;
}

export interface AgentCallOptions {
	agent?: string;
	label?: string;
	phase?: string;
	model?: string;
	thinking?: WorkflowThinking;
	schema?: Record<string, unknown>;
	cwd?: string;
}

export interface DelegationProgress {
	runId?: string;
	model?: string;
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

function progressNumber(value: unknown, maximum: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
}

function requireBoundedString(value: string, maxBytes: number, label: string): string {
	if (value.length > maxBytes || utf8ByteLength(value) > maxBytes) {
		throw new Error(`${label} exceeded ${maxBytes} bytes`);
	}
	return value;
}

function boundedDisplay(value: string, maxBytes: number): string {
	const prefix = value.length > maxBytes ? value.slice(0, maxBytes) : value;
	return truncateUtf8(sanitizeForDisplay(truncateUtf8(prefix, maxBytes)), maxBytes);
}

function cleanAgentOutput(value: string): string {
	requireBoundedString(value, MAX_AGENT_OUTPUT_BYTES, "Subagent text output");
	const sanitized = sanitizeForDisplay(value);
	requireBoundedString(sanitized, MAX_AGENT_OUTPUT_BYTES, "Sanitized subagent text output");
	const lines = sanitized.trimEnd().split("\n");
	while (lines.length > 0 && (!lines.at(-1)?.trim() || /^[✻*]\s+(?:Done|Worked)\s+(?:for|in)\s+\d/i.test(requirePresent(lines.at(-1)).trim()))) {
		lines.pop();
	}
	return lines.join("\n").trimEnd();
}

function stringifyStructured(value: unknown): string {
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	let nodes = 0;
	let rawBytes = 0;
	while (pending.length > 0) {
		const item = pending.pop();
		if (++nodes > MAX_STRUCTURED_NODES) throw new Error("Subagent structured result exceeded its node limit");
		if (typeof item === "string") {
			rawBytes += utf8ByteLength(item);
		} else if (item === null || typeof item === "boolean") {
			rawBytes += 5;
		} else if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new Error("Subagent structured result contains a non-finite number");
			rawBytes += 32;
		} else if (typeof item === "object") {
			if (seen.has(item)) throw new Error("Subagent structured result contains a cycle");
			seen.add(item);
			if (Array.isArray(item)) {
				rawBytes += item.length + 2;
				if (rawBytes > MAX_STRUCTURED_RAW_BYTES || item.length + nodes + pending.length > MAX_STRUCTURED_NODES) {
					throw new Error("Subagent structured result exceeded its collection limit");
				}
				for (const child of item) pending.push(child);
			} else {
				const prototype = Object.getPrototypeOf(item);
				if (prototype !== Object.prototype && prototype !== null) throw new Error("Subagent structured result is not plain JSON");
				rawBytes += 2;
				for (const key in item) {
					if (!Object.hasOwn(item, key)) continue;
					if (nodes + pending.length >= MAX_STRUCTURED_NODES) throw new Error("Subagent structured result exceeded its collection limit");
					rawBytes += utf8ByteLength(key) + 2;
					if (rawBytes > MAX_STRUCTURED_RAW_BYTES) throw new Error("Subagent structured result exceeded its raw byte limit");
					pending.push((item as Record<string, unknown>)[key]);
				}
			}
		} else {
			throw new Error(`Subagent structured result contains unsupported ${typeof item}`);
		}
		if (rawBytes > MAX_STRUCTURED_RAW_BYTES) throw new Error("Subagent structured result exceeded its raw byte limit");
	}
	const json = JSON.stringify(value);
	requireBoundedString(json, MAX_AGENT_OUTPUT_BYTES, "Subagent structured result");
	return json;
}

function usageField(value: unknown): AgentUsage | undefined {
	if (!isRecord(value)) return undefined;
	const limits: Record<keyof AgentUsage, number> = {
		input: MAX_PROGRESS_TOKENS,
		output: MAX_PROGRESS_TOKENS,
		cacheRead: MAX_PROGRESS_TOKENS,
		cacheWrite: MAX_PROGRESS_TOKENS,
		cost: MAX_PROGRESS_COUNT,
		turns: MAX_PROGRESS_COUNT,
		toolCalls: MAX_PROGRESS_COUNT,
		durationMs: MAX_PROGRESS_DURATION_MS,
	};
	const parsed = {} as AgentUsage;
	for (const key of Object.keys(limits) as Array<keyof AgentUsage>) {
		const number = progressNumber(value[key], limits[key]);
		if (number === undefined) return undefined;
		parsed[key] = number;
	}
	return parsed;
}

function terminalResult(value: Record<string, unknown>): AgentCallResult {
	const rawStatus = stringField(value.status);
	const status = rawStatus ? boundedDisplay(rawStatus, 128) : "failed";
	if (status === "invalid_request" || status === "unavailable_context" || status === "duplicate_node") {
		throw new Error(boundedDisplay(stringField(value.error) ?? `Subagent delegation protocol failed: ${status}`, MAX_AGENT_ERROR_BYTES));
	}
	const rawRunId = stringField(value.runId);
	const runId = rawRunId ? boundedDisplay(rawRunId, 256) : undefined;
	const rawModel = stringField(value.model);
	const model = rawModel ? boundedDisplay(rawModel, 256) : undefined;
	const usage = usageField(value.usage);
	if (status !== "completed") {
		return {
			ok: false,
			output: "",
			error: boundedDisplay(stringField(value.error) ?? `Subagent ended with status ${status}`, MAX_AGENT_ERROR_BYTES),
			...(usage ? { usage } : {}),
			...(runId ? { runId } : {}),
			...(model ? { model } : {}),
		};
	}
	if (!isRecord(value.result)) throw new Error("Subagent delegation completed without a result envelope");
	if (value.result.kind === "text" && typeof value.result.text === "string") {
		return { ok: true, output: cleanAgentOutput(value.result.text), ...(usage ? { usage } : {}), ...(runId ? { runId } : {}), ...(model ? { model } : {}) };
	}
	if (value.result.kind === "structured" && Object.hasOwn(value.result, "value")) {
		return { ok: true, output: stringifyStructured(value.result.value), structured: value.result.value, ...(usage ? { usage } : {}), ...(runId ? { runId } : {}), ...(model ? { model } : {}) };
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
		const requestedCwd = options.call.cwd?.trim();
		if (requestedCwd?.includes("\0") || (requestedCwd && utf8ByteLength(requestedCwd) > MAX_AGENT_CWD_BYTES)) {
			return Promise.reject(new Error(`agent() cwd must be at most ${MAX_AGENT_CWD_BYTES} UTF-8 bytes and contain no NUL`));
		}
		const request: DelegationRequest = {
			version: VERSION,
			requestId: randomUUID(),
			ownerRunId: options.ownerRunId,
			nodeId: options.nodeId,
			agent: options.call.agent?.trim() || "general-purpose",
			task: options.prompt,
			context: "fresh",
			cwd: requestedCwd ? path.resolve(this.cwd, requestedCwd) : this.cwd,
			...(options.call.model ? { model: options.call.model } : {}),
			...(options.call.thinking ? { thinking: options.call.thinking } : {}),
			artifacts: true,
			result: options.call.schema ? { kind: "structured", schema: options.call.schema } : { kind: "text" },
		};

		return new Promise<AgentCallResult>((resolve, reject) => {
			let settled = false;
			let started = false;
			let cancelStarted = false;
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
				else resolve(requirePresent(result));
			};
			const onAbort = () => {
				if (settled || cancelStarted) return;
				cancelStarted = true;
				try {
					this.events.emit(CANCEL_EVENT, {
						version: VERSION,
						requestId: request.requestId,
						ownerRunId: request.ownerRunId,
						nodeId: request.nodeId,
					});
				} catch {
					finish(abortError(options.signal));
					return;
				}
				if (settled) return;
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
				const runId = stringField(value.runId);
				const model = stringField(value.model);
				const currentTool = stringField(value.currentTool);
				const recentOutput = stringField(value.recentOutput);
				const toolCount = progressNumber(value.toolCount, MAX_PROGRESS_COUNT);
				const durationMs = progressNumber(value.durationMs, MAX_PROGRESS_DURATION_MS);
				const tokens = progressNumber(value.tokens, MAX_PROGRESS_TOKENS);
				options.onProgress({
					...(runId ? { runId: boundedDisplay(runId, 256) } : {}),
					...(model ? { model: boundedDisplay(model, 256) } : {}),
					...(currentTool ? { currentTool: boundedDisplay(currentTool, 512) } : {}),
					...(recentOutput ? { recentOutput: boundedDisplay(recentOutput, MAX_PROGRESS_BYTES) } : {}),
					...(toolCount !== undefined ? { toolCount } : {}),
					...(durationMs !== undefined ? { durationMs } : {}),
					...(tokens !== undefined ? { tokens } : {}),
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
