import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDir, prunePrivateRunDirs, safeStringify, writeFileAtomic, writeJsonAtomic } from "../shared/artifacts.ts";
import type { WorkflowDetails } from "./controller.ts";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_COUNT = 100;
const MAX_EVENT_BYTES = 1024 * 1024;

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
	private snapshotTimer?: ReturnType<typeof setTimeout>;
	private eventBytes = 0;
	private eventsCapped = false;
	private failure?: Error;
	private readonly onError?: (error: Error) => void;

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

export function aggregateUsage(details: WorkflowDetails): Record<string, number> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, durationMs: 0 };
	for (const record of details.agents) {
		if (!record.usage) continue;
		for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += record.usage[key];
	}
	return total;
}

export function loadWorkflowHistory(): WorkflowDetails[] {
	const root = workflowRoot();
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			try {
				const value = JSON.parse(fs.readFileSync(path.join(root, entry.name, "workflow.json"), "utf8"));
				if (!value || typeof value !== "object" || typeof value.runId !== "string" || typeof value.name !== "string") return [];
				return [value as WorkflowDetails];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, RETENTION_COUNT);
}
