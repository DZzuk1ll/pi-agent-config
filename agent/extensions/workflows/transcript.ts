import { randomUUID } from "node:crypto";
import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { omitUndefined } from "../_shared/runtime/omit-undefined.ts";
import type { DelegationEvents } from "./delegation.ts";

const VERSION = 1 as const;
const REQUEST_EVENT = "prompt-template:subagent:transcript:request";
const RESPONSE_EVENT = "prompt-template:subagent:transcript:response";
const API_TIMEOUT_MS = 750;
const MAX_EVENTS = 100;
const MAX_TEXT = 8 * 1024;

export type WorkflowTranscriptEvent =
	| { kind: "assistant"; text: string; model?: string; timestamp?: number }
	| { kind: "user"; text: string; timestamp?: number }
	| { kind: "tool"; name: string; args?: string; output?: string; status: "running" | "complete" | "error"; error?: string; startedAt?: number; endedAt?: number; timestamp?: number }
	| { kind: "notice"; text: string; tone: "muted" | "warning" | "error"; timestamp?: number };

export interface WorkflowTranscriptPage {
	status: "ok" | "not_found" | "unavailable";
	events: WorkflowTranscriptEvent[];
	cursor: number;
	nextCursor?: number;
	total?: number;
	truncated: boolean;
	warning?: string;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = MAX_TEXT): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const clean = sanitizeForDisplay(value);
	return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(0, maximum - 1))}…`;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
	const parsed = number(value);
	return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function parseEvent(value: unknown): WorkflowTranscriptEvent | undefined {
	if (!isRecord(value)) return undefined;
	const timestamp = number(value.timestamp);
	if (value.kind === "assistant") {
		const content = text(value.text);
		if (!content) return undefined;
		return omitUndefined({ kind: "assistant", text: content, model: text(value.model, 256), timestamp });
	}
	if (value.kind === "user") {
		const content = text(value.text);
		return content ? { kind: "user", text: content, ...(timestamp !== undefined ? { timestamp } : {}) } : undefined;
	}
	if (value.kind === "notice") {
		const content = text(value.text);
		const tone = value.tone === "warning" || value.tone === "error" ? value.tone : "muted";
		return content ? { kind: "notice", text: content, tone, ...(timestamp !== undefined ? { timestamp } : {}) } : undefined;
	}
	if (value.kind !== "tool") return undefined;
	const name = text(value.name, 160);
	const status = value.status === "running" || value.status === "complete" || value.status === "error" ? value.status : undefined;
	if (!name || !status) return undefined;
	const startedAt = number(value.startedAt);
	const endedAt = number(value.endedAt);
	return omitUndefined({
		kind: "tool",
		name,
		...(text(value.args, 4 * 1024) ? { args: text(value.args, 4 * 1024) } : {}),
		...(text(value.output) ? { output: text(value.output) } : {}),
		status,
		...(text(value.error, 4 * 1024) ? { error: text(value.error, 4 * 1024) } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
	});
}

export class WorkflowTranscriptClient {
	private readonly events: DelegationEvents;
	private readonly timeoutMs: number;

	constructor(events: DelegationEvents, timeoutMs = API_TIMEOUT_MS) {
		this.events = events;
		this.timeoutMs = timeoutMs;
	}

	query(options: { runId: string; childIndex?: number; cursor?: number; limit?: number; signal?: AbortSignal }): Promise<WorkflowTranscriptPage> {
		const requestId = randomUUID();
		const runId = options.runId.trim();
		const childIndex = Math.max(0, Math.min(31, Math.floor(options.childIndex ?? 0)));
		const cursor = Math.max(0, Math.floor(options.cursor ?? 0));
		const limit = Math.max(1, Math.min(MAX_EVENTS, Math.floor(options.limit ?? 50)));
		if (!runId) return Promise.resolve({ status: "not_found", events: [], cursor, truncated: false, error: "Missing child run ID." });
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const finish = (page: WorkflowTranscriptPage) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				options.signal?.removeEventListener("abort", onAbort);
				resolve(page);
			};
			const onAbort = () => finish({ status: "unavailable", events: [], cursor, truncated: false, error: "Transcript request cancelled." });
			const cleanup = this.events.on(RESPONSE_EVENT, (raw) => {
				if (!isRecord(raw) || raw.version !== VERSION || raw.requestId !== requestId || raw.runId !== runId) return;
				const status = raw.status === "ok" || raw.status === "not_found" ? raw.status : "unavailable";
				const events = Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS).flatMap((event) => parseEvent(event) ?? []) : [];
				const responseCursor = integer(raw.cursor) ?? cursor;
				const nextCursor = integer(raw.nextCursor);
				const total = integer(raw.total);
				const invalidCursorField = Object.hasOwn(raw, "cursor") && integer(raw.cursor) === undefined
					|| Object.hasOwn(raw, "nextCursor") && nextCursor === undefined
					|| Object.hasOwn(raw, "total") && total === undefined;
				if (invalidCursorField || responseCursor !== cursor || nextCursor !== undefined && (nextCursor <= responseCursor || total !== undefined && nextCursor > total)) {
					finish({ status: "unavailable", events: [], cursor, truncated: false, error: "Transcript API returned an invalid pagination cursor." });
					return;
				}
				finish(omitUndefined({
					status,
					events,
					cursor: responseCursor,
					...(nextCursor !== undefined ? { nextCursor } : {}),
					...(total !== undefined ? { total } : {}),
					truncated: raw.truncated === true,
					...(text(raw.warning, 2_000) ? { warning: text(raw.warning, 2_000) } : {}),
					...(text(raw.error, 2_000) ? { error: text(raw.error, 2_000) } : {}),
				}));
			});
			if (typeof cleanup === "function") unsubscribe = cleanup;
			const timer = setTimeout(() => finish({
				status: "unavailable",
				events: [],
				cursor,
				truncated: false,
				error: "pi-subagents transcript API is unavailable; use /subagents-fleet.",
			}), this.timeoutMs);
			timer.unref?.();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			try {
				this.events.emit(REQUEST_EVENT, { version: VERSION, requestId, runId, childIndex, cursor, limit });
			} catch {
				finish({ status: "unavailable", events: [], cursor, truncated: false, error: "Transcript request could not be emitted." });
			}
		});
	}
}
