export const SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_TRANSCRIPT_REQUEST_EVENT = "prompt-template:subagent:transcript:request";
export const SUBAGENT_TRANSCRIPT_RESPONSE_EVENT = "prompt-template:subagent:transcript:response";

export type SubagentTranscriptEvent =
	| { kind: "assistant"; text: string; model?: string; timestamp?: number }
	| { kind: "user"; text: string; timestamp?: number }
	| { kind: "tool"; name: string; args?: string; output?: string; status: "running" | "complete" | "error"; error?: string; startedAt?: number; endedAt?: number; timestamp?: number }
	| { kind: "notice"; text: string; tone: "muted" | "warning" | "error"; timestamp?: number };

export interface SubagentTranscriptRequest {
	version: typeof SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION;
	requestId: string;
	runId: string;
	childIndex?: number;
	cursor?: number;
	limit?: number;
}

export interface SubagentTranscriptResponse {
	version: typeof SUBAGENT_TRANSCRIPT_PROTOCOL_VERSION;
	requestId: string;
	runId: string;
	status: "ok" | "not_found" | "invalid_request" | "unavailable";
	error?: string;
	events?: SubagentTranscriptEvent[];
	cursor?: number;
	nextCursor?: number;
	total?: number;
	truncated?: boolean;
	warning?: string;
}
