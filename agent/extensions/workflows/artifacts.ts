import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDir, prunePrivateRunDirs, safeStringify, writeFileAtomic, writeJsonAtomic } from "../_shared/runtime/artifacts.ts";
import { sanitizeForDisplay, truncateUtf8 } from "../_shared/runtime/text.ts";
import { omitUndefined } from "../_shared/runtime/omit-undefined.ts";
import type { WorkflowAgentRecord, WorkflowAgentState, WorkflowDetails, WorkflowState } from "./controller.ts";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_COUNT = 100;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_WORKFLOW_SNAPSHOT_BYTES = 1024 * 1024;
const WORKFLOW_STATES = new Set<WorkflowState>(["running", "completed", "failed", "aborted"]);
const AGENT_STATES = new Set<WorkflowAgentState>(["queued", "running", "done", "failed", "aborted"]);
const MAX_PROGRESS_COUNT = 1_000_000_000;
const MAX_PROGRESS_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROGRESS_TOKENS = 1_000_000_000_000;

export function workflowRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "workflows");
}

export function prepareWorkflowStorage(excludeRunIds: readonly string[] = []): void {
	const root = workflowRoot();
	ensurePrivateDir(root);
	prunePrivateRunDirs(root, {
		maxAgeMs: RETENTION_MS,
		maxEntries: RETENTION_COUNT,
		excludeNames: excludeRunIds,
	});
}

export class WorkflowArtifacts {
	readonly runId: string;
	readonly directory: string;
	private lastSnapshotAt = 0;
	private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	private eventBytes = 0;
	private eventsCapped = false;
	private failure?: Error;
	private readonly onError: ((error: Error) => void) | undefined;

	constructor(runId: string, script: string, argsJson?: string, onError?: (error: Error) => void) {
		this.runId = runId;
		this.onError = onError;
		this.directory = path.join(workflowRoot(), runId);
		ensurePrivateDir(this.directory);
		writeFileAtomic(path.join(this.directory, "script.js"), script);
		if (argsJson !== undefined) writeFileAtomic(path.join(this.directory, "args.json"), `${argsJson}\n`);
	}

	get error(): Error | undefined {
		return this.failure;
	}

	event(kind: string, data: unknown = {}): boolean {
		if (this.failure || this.eventsCapped) return false;
		try {
			const line = `${safeStringify({ at: Date.now(), kind, data }, { maxBytes: 128 * 1024, maxDepth: 12, maxNodes: 4_000 })}\n`;
			const bytes = Buffer.byteLength(line, "utf8");
			if (this.eventBytes + bytes > MAX_EVENT_BYTES) {
				this.eventsCapped = true;
				return false;
			}
			const eventPath = path.join(this.directory, "events.jsonl");
			fs.appendFileSync(eventPath, line, { encoding: "utf8", mode: 0o600 });
			fs.chmodSync(eventPath, 0o600);
			this.eventBytes += bytes;
			return true;
		} catch (error) {
			this.recordFailure(error);
			return false;
		}
	}

	checkpoint(details: WorkflowDetails, immediate = false): boolean {
		if (this.failure) return false;
		if (immediate || Date.now() - this.lastSnapshotAt >= 250) return this.tryFlush(details);
		if (this.snapshotTimer) return true;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			this.tryFlush(details);
		}, 250 - (Date.now() - this.lastSnapshotAt));
		this.snapshotTimer.unref?.();
		return true;
	}

	finish(details: WorkflowDetails): void {
		this.cancelPending();
		if (this.failure) throw this.failure;
		this.flush(details);
		writeJsonAtomic(path.join(this.directory, "result.json"), {
			runId: details.runId,
			state: details.state,
			result: details.result,
			error: details.error,
			usage: aggregateUsage(details),
		}, { maxBytes: 1024 * 1024, maxDepth: 16, maxNodes: 10_000 });
		this.event("workflow.finished", { state: details.state, error: details.error });
		if (this.failure) throw this.failure;
	}

	dispose(): void {
		this.cancelPending();
	}

	private tryFlush(details: WorkflowDetails): boolean {
		try {
			this.flush(details);
			return true;
		} catch (error) {
			this.recordFailure(error);
			return false;
		}
	}

	private flush(details: WorkflowDetails): void {
		this.lastSnapshotAt = Date.now();
		writeJsonAtomic(path.join(this.directory, "workflow.json"), details, {
			maxBytes: 1024 * 1024,
			maxDepth: 16,
			maxNodes: 20_000,
			maxStringBytes: 128 * 1024,
		});
	}

	private cancelPending(): void {
		if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
		this.snapshotTimer = undefined;
	}

	private recordFailure(error: unknown): void {
		if (this.failure) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.cancelPending();
		try { this.onError?.(this.failure); } catch {}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = truncateUtf8(sanitizeForDisplay(value), maxBytes).trim();
	return result || undefined;
}

function boundedNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : undefined;
}

function boundedJsonValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
	try {
		return {
			ok: true,
			value: JSON.parse(safeStringify(value, {
				maxBytes: 512 * 1024,
				maxDepth: 16,
				maxNodes: 10_000,
				maxStringBytes: 64 * 1024,
			})),
		};
	} catch {
		return { ok: false };
	}
}

function normalizeUsage(value: unknown): WorkflowAgentRecord["usage"] {
	if (!isRecord(value)) return undefined;
	const limits = {
		input: MAX_PROGRESS_TOKENS,
		output: MAX_PROGRESS_TOKENS,
		cacheRead: MAX_PROGRESS_TOKENS,
		cacheWrite: MAX_PROGRESS_TOKENS,
		cost: MAX_PROGRESS_COUNT,
		turns: MAX_PROGRESS_COUNT,
		toolCalls: MAX_PROGRESS_COUNT,
		durationMs: MAX_PROGRESS_DURATION_MS,
	};
	const usage = {} as NonNullable<WorkflowAgentRecord["usage"]>;
	for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
		const number = boundedNumber(value[key], limits[key]);
		if (number === undefined) return undefined;
		usage[key] = number;
	}
	return usage;
}

function normalizeAgent(value: unknown, fallbackIndex: number): WorkflowAgentRecord | undefined {
	if (!isRecord(value)) return undefined;
	const rawState = boundedString(value.state, 32);
	const state = rawState && AGENT_STATES.has(rawState as WorkflowAgentState) ? rawState as WorkflowAgentState : undefined;
	if (!state) return undefined;
	const indexValue = boundedNumber(value.index, 1_000_000);
	const index = indexValue !== undefined && Number.isInteger(indexValue) && indexValue >= 1 ? indexValue : fallbackIndex;
	const nodeId = boundedString(value.nodeId, 160) ?? `agent-${index}`;
	const label = boundedString(value.label, 160) ?? nodeId;
	const agent = boundedString(value.agent, 160) ?? "general-purpose";
	const startedAt = boundedNumber(value.startedAt);
	const endedAt = boundedNumber(value.endedAt);
	const toolCount = boundedNumber(value.toolCount, MAX_PROGRESS_COUNT);
	const durationMs = boundedNumber(value.durationMs, MAX_PROGRESS_DURATION_MS);
	const tokens = boundedNumber(value.tokens, MAX_PROGRESS_TOKENS);
	const lastProgressAt = boundedNumber(value.lastProgressAt);
	const usage = normalizeUsage(value.usage);
	return omitUndefined({
		index,
		nodeId,
		label,
		agent,
		state,
		...(boundedString(value.phase, 160) ? { phase: boundedString(value.phase, 160) } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(boundedString(value.runId, 256) ? { runId: boundedString(value.runId, 256) } : {}),
		...(boundedString(value.model, 256) ? { model: boundedString(value.model, 256) } : {}),
		...(boundedString(value.currentTool, 160) ? { currentTool: boundedString(value.currentTool, 160) } : {}),
		...(boundedString(value.preview, 16 * 1024) ? { preview: boundedString(value.preview, 16 * 1024) } : {}),
		...(toolCount !== undefined ? { toolCount } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
		...(boundedString(value.error, 16 * 1024) ? { error: boundedString(value.error, 16 * 1024) } : {}),
		...(usage ? { usage } : {}),
	});
}

export function normalizeWorkflowDetails(value: unknown, directoryRunId?: string): WorkflowDetails | undefined {
	if (!isRecord(value)) return undefined;
	const rawState = boundedString(value.state, 32);
	const state = rawState && WORKFLOW_STATES.has(rawState as WorkflowState) ? rawState as WorkflowState : undefined;
	const runId = boundedString(directoryRunId, 256) ?? boundedString(value.runId, 256);
	const startedAt = boundedNumber(value.startedAt);
	if (!state || !runId || startedAt === undefined) return undefined;
	const name = boundedString(value.name, 320) ?? runId;
	const endedAt = boundedNumber(value.endedAt);
	const phases: string[] = [];
	if (Array.isArray(value.phases)) {
		for (const item of value.phases.slice(0, 64)) {
			const phase = boundedString(item, 160);
			if (phase && !phases.includes(phase)) phases.push(phase);
		}
	}
	const agents = Array.isArray(value.agents)
		? value.agents.slice(0, 32).flatMap((agent, index) => normalizeAgent(agent, index + 1) ?? [])
		: [];
	const result = Object.hasOwn(value, "result") ? boundedJsonValue(value.result) : { ok: false as const };
	return omitUndefined({
		runId,
		sessionId: boundedString(value.sessionId, 256) ?? "",
		name,
		...(boundedString(value.description, 2_000) ? { description: boundedString(value.description, 2_000) } : {}),
		background: value.background === true,
		state,
		startedAt,
		...(endedAt !== undefined ? { endedAt } : {}),
		...(boundedString(value.currentPhase, 160) ? { currentPhase: boundedString(value.currentPhase, 160) } : {}),
		phases,
		agents,
		...(result.ok ? { result: result.value } : {}),
		...(boundedString(value.error, 16 * 1024) ? { error: boundedString(value.error, 16 * 1024) } : {}),
	});
}

export function aggregateUsage(details: WorkflowDetails): Record<string, number> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, durationMs: 0 };
	for (const record of details.agents) {
		if (!record.usage) continue;
		for (const key of Object.keys(total) as Array<keyof typeof total>) {
			const value = boundedNumber(record.usage[key]);
			if (value !== undefined) total[key] += value;
		}
	}
	return total;
}

export function loadWorkflowHistory(): WorkflowDetails[] {
	const root = workflowRoot();
	if (!fs.existsSync(root)) return [];
	const realRoot = fs.realpathSync(root);
	return fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			let descriptor: number | undefined;
			try {
				const snapshotPath = path.join(root, entry.name, "workflow.json");
				const linkStat = fs.lstatSync(snapshotPath);
				if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > MAX_WORKFLOW_SNAPSHOT_BYTES) return [];
				const realSnapshot = fs.realpathSync(snapshotPath);
				if (realSnapshot !== path.join(realRoot, entry.name, "workflow.json")) return [];
				const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
				descriptor = fs.openSync(snapshotPath, fs.constants.O_RDONLY | noFollow);
				const openedStat = fs.fstatSync(descriptor);
				if (!openedStat.isFile() || openedStat.size > MAX_WORKFLOW_SNAPSHOT_BYTES) return [];
				const value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
				const details = normalizeWorkflowDetails(value, entry.name);
				return details ? [details] : [];
			} catch {
				return [];
			} finally {
				if (descriptor !== undefined) fs.closeSync(descriptor);
			}
		})
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, RETENTION_COUNT);
}
