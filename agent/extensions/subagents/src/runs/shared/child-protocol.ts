import { Buffer } from "node:buffer";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ProtocolOutputLimit } from "../../shared/types.ts";
import { requirePresent } from "../../../../_shared/runtime/require-present.ts";


export type { ProtocolOutputLimit } from "../../shared/types.ts";

export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;

export interface DecodedChildEvent {
	[key: string]: unknown;
	type: string;
	willRetry?: boolean;
	message?: AgentMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

const STOP_REASONS = new Set(["pending", "stop", "length", "toolUse", "error", "aborted"]);
const WATCHDOG_PHASES = new Set(["idle", "reviewing", "autofollow", "settling", "stale", "failed"]);
const COMPACTION_REASONS = new Set(["manual", "threshold", "overflow"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalString(record: Record<string, unknown>, field: string): boolean {
	return record[field] === undefined || typeof record[field] === "string";
}

function isUsage(value: unknown): boolean {
	const usage = recordValue(value);
	if (!usage) return false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (!finiteNumber(usage[field])) return false;
	}
	for (const field of ["cacheWrite1h", "reasoning"] as const) {
		if (usage[field] !== undefined && !finiteNumber(usage[field])) return false;
	}
	const cost = recordValue(usage.cost);
	return cost !== undefined
		&& ["input", "output", "cacheRead", "cacheWrite", "total"].every((field) => finiteNumber(cost[field]));
}

function isTextContent(value: unknown): boolean {
	const content = recordValue(value);
	return content?.type === "text"
		&& typeof content.text === "string"
		&& optionalString(content, "textSignature");
}

function isImageContent(value: unknown): boolean {
	const content = recordValue(value);
	return content?.type === "image"
		&& typeof content.data === "string"
		&& typeof content.mimeType === "string";
}

function isThinkingContent(value: unknown): boolean {
	const content = recordValue(value);
	return content?.type === "thinking"
		&& typeof content.thinking === "string"
		&& optionalString(content, "thinkingSignature")
		&& (content.redacted === undefined || typeof content.redacted === "boolean");
}

function isToolCall(value: unknown): boolean {
	const content = recordValue(value);
	return content?.type === "toolCall"
		&& typeof content.id === "string"
		&& typeof content.name === "string"
		&& recordValue(content.arguments) !== undefined
		&& optionalString(content, "thoughtSignature");
}

function isAssistantDiagnostic(value: unknown): boolean {
	const diagnostic = recordValue(value);
	if (!diagnostic || typeof diagnostic.type !== "string" || !finiteNumber(diagnostic.timestamp)) return false;
	if (diagnostic.details !== undefined && !recordValue(diagnostic.details)) return false;
	if (diagnostic.error === undefined) return true;
	const error = recordValue(diagnostic.error);
	return error !== undefined
		&& typeof error.message === "string"
		&& optionalString(error, "name")
		&& optionalString(error, "stack")
		&& (error.code === undefined || typeof error.code === "string" || finiteNumber(error.code));
}

function isUserMessage(value: unknown): value is Extract<Message, { role: "user" }> {
	const message = recordValue(value);
	if (message?.role !== "user" || !finiteNumber(message.timestamp)) return false;
	return typeof message.content === "string"
		|| (Array.isArray(message.content) && message.content.every((content) => isTextContent(content) || isImageContent(content)));
}

function isAssistantMessage(value: unknown): value is Extract<Message, { role: "assistant" }> {
	const message = recordValue(value);
	return message?.role === "assistant"
		&& Array.isArray(message.content)
		&& message.content.every((content) => isTextContent(content) || isThinkingContent(content) || isToolCall(content))
		&& typeof message.api === "string"
		&& typeof message.provider === "string"
		&& typeof message.model === "string"
		&& isUsage(message.usage)
		&& typeof message.stopReason === "string"
		&& STOP_REASONS.has(message.stopReason)
		&& finiteNumber(message.timestamp)
		&& optionalString(message, "responseModel")
		&& optionalString(message, "responseId")
		&& optionalString(message, "errorMessage")
		&& optionalString(message, "rawStopReason")
		&& (message.diagnostics === undefined || (Array.isArray(message.diagnostics) && message.diagnostics.every(isAssistantDiagnostic)));
}

function isToolResultMessage(value: unknown): value is Extract<Message, { role: "toolResult" }> {
	const message = recordValue(value);
	return message?.role === "toolResult"
		&& typeof message.toolCallId === "string"
		&& typeof message.toolName === "string"
		&& Array.isArray(message.content)
		&& message.content.every((content) => isTextContent(content) || isImageContent(content))
		&& typeof message.isError === "boolean"
		&& finiteNumber(message.timestamp)
		&& (message.usage === undefined || isUsage(message.usage))
		&& (message.addedToolNames === undefined || (Array.isArray(message.addedToolNames) && message.addedToolNames.every((name) => typeof name === "string")));
}

export function isDecodedLlmMessage(value: unknown): value is Message {
	return isUserMessage(value) || isAssistantMessage(value) || isToolResultMessage(value);
}

function isAgentMessage(value: unknown): value is AgentMessage {
	if (isDecodedLlmMessage(value)) return true;
	const message = recordValue(value);
	if (!message || typeof message.role !== "string" || !finiteNumber(message.timestamp)) return false;
	switch (message.role) {
		case "custom":
			return typeof message.customType === "string"
				&& typeof message.display === "boolean"
				&& (typeof message.content === "string"
					|| (Array.isArray(message.content) && message.content.every((content) => isTextContent(content) || isImageContent(content))));
		case "bashExecution":
			return typeof message.command === "string"
				&& typeof message.output === "string"
				&& (message.exitCode === undefined || finiteNumber(message.exitCode))
				&& typeof message.cancelled === "boolean"
				&& typeof message.truncated === "boolean"
				&& optionalString(message, "fullOutputPath")
				&& (message.excludeFromContext === undefined || typeof message.excludeFromContext === "boolean");
		case "branchSummary":
			return typeof message.summary === "string" && typeof message.fromId === "string";
		case "compactionSummary":
			return typeof message.summary === "string" && finiteNumber(message.tokensBefore);
		default:
			return false;
	}
}

function isAssistantMessageEvent(value: unknown): boolean {
	const event = recordValue(value);
	if (!event || typeof event.type !== "string") return false;
	if (event.type === "done") return (event.reason === "stop" || event.reason === "length" || event.reason === "toolUse") && isAssistantMessage(event.message);
	if (event.type === "error") return (event.reason === "aborted" || event.reason === "error") && isAssistantMessage(event.error);
	if (!isAssistantMessage(event.partial)) return false;
	if (event.type === "start") return true;
	if (!Number.isInteger(event.contentIndex) || (event.contentIndex as number) < 0) return false;
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") return typeof event.delta === "string";
	if (event.type === "text_end" || event.type === "thinking_end") return typeof event.content === "string";
	if (event.type === "toolcall_end") return isToolCall(event.toolCall);
	return event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start";
}

function isWatchdogEvent(event: Record<string, unknown>): boolean {
	if (event.type !== "subagent.watchdog.status") return false;
	for (const field of ["runId", "agent", "reason"] as const) {
		if (event[field] !== undefined && typeof event[field] !== "string") return false;
	}
	for (const field of ["childIndex", "stepIndex", "seq"] as const) {
		if (event[field] !== undefined && (!Number.isInteger(event[field]) || (event[field] as number) < 0)) return false;
	}
	return Number.isInteger(event.seq)
		&& finiteNumber(event.ts)
		&& typeof event.phase === "string"
		&& WATCHDOG_PHASES.has(event.phase)
		&& typeof event.followUpPending === "boolean";
}

function isSessionEntry(value: unknown): boolean {
	const entry = recordValue(value);
	if (!entry
		|| typeof entry.type !== "string"
		|| typeof entry.id !== "string"
		|| (entry.parentId !== null && typeof entry.parentId !== "string")
		|| typeof entry.timestamp !== "string") return false;
	switch (entry.type) {
		case "message":
			return isAgentMessage(entry.message);
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string";
		case "model_change":
			return typeof entry.provider === "string" && typeof entry.modelId === "string";
		case "compaction":
			return typeof entry.summary === "string"
				&& typeof entry.firstKeptEntryId === "string"
				&& finiteNumber(entry.tokensBefore)
				&& (entry.usage === undefined || isUsage(entry.usage))
				&& (entry.fromHook === undefined || typeof entry.fromHook === "boolean");
		case "branch_summary":
			return typeof entry.fromId === "string"
				&& typeof entry.summary === "string"
				&& (entry.usage === undefined || isUsage(entry.usage))
				&& (entry.fromHook === undefined || typeof entry.fromHook === "boolean");
		case "custom":
			return typeof entry.customType === "string";
		case "custom_message":
			return typeof entry.customType === "string"
				&& typeof entry.display === "boolean"
				&& (typeof entry.content === "string"
					|| (Array.isArray(entry.content) && entry.content.every((content) => isTextContent(content) || isImageContent(content))));
		case "label":
			return typeof entry.targetId === "string" && (entry.label === undefined || typeof entry.label === "string");
		case "session_info":
			return entry.name === undefined || typeof entry.name === "string";
		default:
			return false;
	}
}

function isCompactionResult(value: unknown): boolean {
	const result = recordValue(value);
	return result !== undefined
		&& typeof result.summary === "string"
		&& typeof result.firstKeptEntryId === "string"
		&& finiteNumber(result.tokensBefore)
		&& (result.estimatedTokensAfter === undefined || finiteNumber(result.estimatedTokensAfter))
		&& (result.usage === undefined || isUsage(result.usage));
}

function isIgnoredSessionEvent(event: Record<string, unknown>): boolean {
	switch (event.type) {
		case "queue_update":
			return Array.isArray(event.steering)
				&& event.steering.every((item) => typeof item === "string")
				&& Array.isArray(event.followUp)
				&& event.followUp.every((item) => typeof item === "string");
		case "compaction_start":
			return typeof event.reason === "string" && COMPACTION_REASONS.has(event.reason);
		case "compaction_end":
			return typeof event.reason === "string"
				&& COMPACTION_REASONS.has(event.reason)
				&& (event.result === undefined || isCompactionResult(event.result))
				&& typeof event.aborted === "boolean"
				&& typeof event.willRetry === "boolean"
				&& optionalString(event, "errorMessage");
		case "entry_appended":
			return isSessionEntry(event.entry);
		case "session_info_changed":
			return event.name === undefined || typeof event.name === "string";
		case "thinking_level_changed":
			return typeof event.level === "string" && THINKING_LEVELS.has(event.level);
		case "auto_retry_start":
		case "summarization_retry_scheduled":
			return Number.isInteger(event.attempt)
				&& Number.isInteger(event.maxAttempts)
				&& finiteNumber(event.delayMs)
				&& typeof event.errorMessage === "string";
		case "auto_retry_end":
			return typeof event.success === "boolean" && Number.isInteger(event.attempt) && optionalString(event, "finalError");
		case "summarization_retry_attempt_start":
			return event.source === "branchSummary"
				|| (event.source === "compaction" && typeof event.reason === "string" && COMPACTION_REASONS.has(event.reason));
		case "summarization_retry_finished":
			return true;
		case "bash_execution_update":
			return optionalString(event, "id") && typeof event.delta === "string";
		default:
			return false;
	}
}

/** Decode one JSONL protocol value. Invalid values stay raw stdout. */
export function decodeEvent(value: unknown): DecodedChildEvent | undefined {
	const event = recordValue(value);
	if (!event) return undefined;
	if (typeof event.type !== "string" || event.type.length === 0) return undefined;
	let valid = false;
	switch (event.type) {
		case "agent_start":
		case "turn_start":
		case "agent_settled":
			valid = true;
			break;
		case "agent_end":
			valid = typeof event.willRetry === "boolean" && Array.isArray(event.messages) && event.messages.every(isAgentMessage);
			break;
		case "turn_end":
			valid = isAgentMessage(event.message) && Array.isArray(event.toolResults) && event.toolResults.every(isToolResultMessage);
			break;
		case "message_start":
		case "message_end":
			valid = isAgentMessage(event.message);
			break;
		case "message_update":
			valid = isAssistantMessage(event.message) && isAssistantMessageEvent(event.assistantMessageEvent);
			break;
		case "tool_result_end":
			valid = isToolResultMessage(event.message);
			break;
		case "tool_execution_start":
			valid = typeof event.toolCallId === "string" && typeof event.toolName === "string" && recordValue(event.args) !== undefined;
			break;
		case "tool_execution_update":
			valid = typeof event.toolCallId === "string" && typeof event.toolName === "string" && recordValue(event.args) !== undefined && Object.hasOwn(event, "partialResult");
			break;
		case "tool_execution_end":
			valid = typeof event.toolCallId === "string" && typeof event.toolName === "string" && typeof event.isError === "boolean" && Object.hasOwn(event, "result");
			break;
		default:
			valid = isIgnoredSessionEvent(event) || isWatchdogEvent(event);
	}
	return valid ? event as DecodedChildEvent : undefined;
}

export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
	return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

export function createBoundedLineReader(options: {
	stream?: "stdout" | "stderr";
	maxPendingLineBytes?: number;
	onLine: (line: string) => void;
	onLimit: (limit: ProtocolOutputLimit) => void;
}): {
	push(chunk: Buffer | string): void;
	end(): void;
	exceeded(): boolean;
} {
	const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_PENDING_LINE_BYTES;
	if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
		throw new Error("maxPendingLineBytes must be a positive integer.");
	}
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let limitExceeded = false;

	const emitPending = (): void => {
		if (pendingBytes === 0) return;
		options.onLine(Buffer.concat(pending, pendingBytes).toString("utf8"));
		pending = [];
		pendingBytes = 0;
	};

	const append = (segment: Buffer): boolean => {
		if (segment.length === 0) return true;
		const observedBytes = pendingBytes + segment.length;
		if (observedBytes > maxPendingLineBytes) {
			const prior = pendingBytes > 0 ? Buffer.concat(pending, pendingBytes) : Buffer.alloc(0);
			const prefixFromPrior = prior.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
			const prefix = prefixFromPrior.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
				? prefixFromPrior
				: Buffer.concat([prefixFromPrior, segment.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES - prefixFromPrior.length)]);
			const tailFromSegment = segment.subarray(Math.max(0, segment.length - MAX_PROTOCOL_DIAGNOSTIC_BYTES));
			const tail = tailFromSegment.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
				? tailFromSegment
				: Buffer.concat([prior.subarray(Math.max(0, prior.length - (MAX_PROTOCOL_DIAGNOSTIC_BYTES - tailFromSegment.length))), tailFromSegment]);
			limitExceeded = true;
			pending = [];
			pendingBytes = 0;
			options.onLimit({
				code: "protocol_output_limit",
				stream: options.stream ?? "stdout",
				limitBytes: maxPendingLineBytes,
				observedBytes,
				diagnosticPrefix: prefix.toString("utf8"),
				diagnosticTail: tail.toString("utf8"),
			});
			return false;
		}
		pending.push(segment);
		pendingBytes = observedBytes;
		return true;
	};

	return {
		push(chunk) {
			if (limitExceeded) return;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index++) {
				if (bytes[index] !== 0x0a) continue;
				if (!append(bytes.subarray(start, index))) return;
				emitPending();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!limitExceeded) emitPending();
		},
		exceeded: () => limitExceeded,
	};
}

function trimToUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (requirePresent(buffer[start]) & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES): {
	push(chunk: Buffer | string): void;
	text(): string;
	byteLength(): number;
} {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	return {
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			tail = trimToUtf8Boundary(Buffer.concat([tail, bytes]), maxBytes);
		},
		text: () => tail.toString("utf8"),
		byteLength: () => tail.length,
	};
}

export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false): ChildLifecycleAction {
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	if (event.type === "agent_settled") return "start-drain";
	if (terminalAssistantStop) return "start-drain";
	return "none";
}
