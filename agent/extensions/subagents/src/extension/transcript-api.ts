import * as path from "node:path";
import {
	SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION,
	SUBAGENT_TRANSCRIPT_REQUEST_EVENT,
	SUBAGENT_TRANSCRIPT_RESPONSE_EVENT,
	type SubagentTranscriptEvent,
	type SubagentTranscriptResponse,
} from "../api/transcript.ts";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { readFleetTranscript, type FleetTranscriptEvent } from "../shared/transcript-reader.ts";
import type { SubagentState } from "../shared/types.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EVENT_TEXT = 8 * 1024;

interface TranscriptEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | undefined;
	emit(event: string, data: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number | undefined {
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function clip(value: string | undefined, maximum = MAX_EVENT_TEXT): string | undefined {
	if (!value) return undefined;
	return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function uniquePaths(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value)))];
}

function artifactsRoot(state: SubagentState, cwd: string): string {
	return getArtifactsDir(state.parentSessionFile ?? null, cwd, state.artifactDirPreference ?? "project");
}

function transcriptTarget(state: SubagentState, runId: string, childIndex: number): { filePath: string; trustedRoots: string[]; live: boolean } | undefined {
	const active = state.foregroundControls.get(runId);
	if (active && active.sessionId === state.currentSessionId) {
		const cwd = active.cwd ?? state.baseCwd;
		const child = active.activeChildren?.get(childIndex);
		const agent = child?.agent ?? (childIndex === 0 ? active.currentAgent : undefined);
		if (!agent) return undefined;
		const root = artifactsRoot(state, cwd);
		return {
			filePath: getArtifactPaths(root, runId, agent, childIndex).transcriptPath,
			trustedRoots: [root],
			live: true,
		};
	}
	const recent = state.foregroundRuns?.get(runId);
	if (!recent || recent.sessionId !== state.currentSessionId) return undefined;
	const child = recent.children[childIndex];
	if (!child) return undefined;
	const root = artifactsRoot(state, recent.cwd);
	return {
		// Re-derive the run-owned path instead of trusting a persisted transcriptPath.
		filePath: getArtifactPaths(root, runId, child.agent, childIndex).transcriptPath,
		trustedRoots: uniquePaths([root, artifactsRoot(state, state.baseCwd)]),
		live: false,
	};
}

function projectEvent(event: FleetTranscriptEvent): SubagentTranscriptEvent | undefined {
	if (event.kind === "assistant") {
		const text = clip(event.text);
		if (!text) return undefined;
		const model = clip(event.model, 256);
		return { kind: "assistant", text, ...(model ? { model } : {}), ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) };
	}
	if (event.kind === "user") {
		const text = clip(event.text);
		return text ? { kind: "user", text, ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) } : undefined;
	}
	if (event.kind === "notice") {
		const text = clip(event.text);
		return text ? { kind: "notice", text, tone: event.tone, ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) } : undefined;
	}
	const name = clip(event.name, 160) ?? "tool";
	const args = clip(event.args ?? event.argsPayload, 4 * 1024);
	const output = clip(event.output);
	const error = clip(event.error, 4 * 1024);
	return {
		kind: "tool",
		name,
		...(args ? { args } : {}),
		...(output ? { output } : {}),
		status: event.status,
		...(error ? { error } : {}),
		...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
		...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}),
		...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
	};
}

function fitResponseEvents(events: SubagentTranscriptEvent[]): SubagentTranscriptEvent[] {
	const selected: SubagentTranscriptEvent[] = [];
	let bytes = 0;
	for (const event of events) {
		const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		if (bytes + eventBytes > MAX_RESPONSE_BYTES) break;
		selected.push(event);
		bytes += eventBytes;
	}
	return selected;
}

export function registerSubagentTranscriptApi(events: TranscriptEvents, state: SubagentState): { dispose(): void } {
	const unsubscribe = events.on(SUBAGENT_TRANSCRIPT_REQUEST_EVENT, (raw) => {
		if (!isRecord(raw)) return;
		const requestId = raw.requestId;
		const runId = raw.runId;
		if (!validId(requestId) || !validId(runId)) return;
		const respond = (response: Omit<SubagentTranscriptResponse, "version" | "requestId" | "runId">) => {
			events.emit(SUBAGENT_TRANSCRIPT_RESPONSE_EVENT, {
				version: SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION,
				requestId,
				runId,
				...response,
			} satisfies SubagentTranscriptResponse);
		};
		const allowed = new Set(["version", "requestId", "runId", "childIndex", "cursor", "limit"]);
		const childIndex = boundedInteger(raw.childIndex, 0, 31);
		const cursor = boundedInteger(raw.cursor, 0, MAX_CURSOR);
		const limit = boundedInteger(raw.limit, DEFAULT_LIMIT, MAX_LIMIT);
		if (raw.version !== SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION || Object.keys(raw).some((key) => !allowed.has(key)) || childIndex === undefined || cursor === undefined || limit === undefined) {
			respond({ status: "invalid_request", error: "Invalid transcript request." });
			return;
		}
		if (!state.currentSessionId) {
			respond({ status: "unavailable", error: "No active subagent session." });
			return;
		}
		const target = transcriptTarget(state, runId, childIndex);
		if (!target) {
			respond({ status: "not_found", error: "The requested current-session subagent run was not found." });
			return;
		}
		const transcript = readFleetTranscript(target.filePath, {
			trustedRoots: target.trustedRoots,
			maxRecords: 1_000,
			maxBytes: 2 * 1024 * 1024,
		});
		const projected = transcript.events.flatMap((event) => projectEvent(event) ?? []);
		// A live bounded tail shifts as new records arrive, so offset cursors are intentionally disabled.
		// Live consumers receive the latest page and refresh it; completed runs use stable pagination.
		const pageStart = target.live ? Math.max(0, projected.length - limit) : cursor;
		const page = fitResponseEvents(projected.slice(pageStart, pageStart + limit));
		const nextCursor = !target.live && cursor + page.length < projected.length ? cursor + page.length : undefined;
		const warning = transcript.warning ? clip(transcript.warning, 2_000) : undefined;
		respond({
			status: "ok",
			events: page,
			cursor: target.live ? 0 : cursor,
			...(nextCursor !== undefined ? { nextCursor } : {}),
			total: projected.length,
			truncated: transcript.truncated || target.live && pageStart > 0 || page.length < Math.min(limit, Math.max(0, projected.length - pageStart)),
			...(warning === undefined ? {} : { warning }),
		});
	});
	return {
		dispose: () => {
			if (typeof unsubscribe === "function") unsubscribe();
		},
	};
}
