import { abortError, linkAbortSignal, Semaphore, settleWithin } from "../_shared/runtime/lifecycle.ts";
import type { AgentCallOptions, AgentCallResult, AgentUsage, DelegationClient, DelegationProgress } from "./delegation.ts";

export const MAX_WORKFLOW_AGENT_CALLS = 32;
export const MAX_WORKFLOW_CONCURRENCY = 4;
export const MAX_WORKFLOW_PHASES = 64;
export const WORKFLOW_TIMEOUT_MS = 30 * 60 * 1_000;
export const WORKFLOW_SHUTDOWN_MS = 8_000;

export class WorkflowAdmission {
	readonly limit: number;
	private active = 0;

	constructor(limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Workflow admission limit must be positive");
		this.limit = limit;
	}

	acquire(): () => void {
		if (this.active >= this.limit) throw new Error(`At most ${this.limit} workflows may run concurrently`);
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
		};
	}

	reset(): void {
		this.active = 0;
	}
}

export type WorkflowState = "running" | "completed" | "failed" | "aborted";
export type WorkflowAgentState = "queued" | "running" | "done" | "failed" | "aborted";

export interface WorkflowAgentRecord {
	index: number;
	nodeId: string;
	label: string;
	agent: string;
	phase?: string;
	state: WorkflowAgentState;
	startedAt?: number;
	endedAt?: number;
	runId?: string;
	model?: string;
	currentTool?: string;
	preview?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	lastProgressAt?: number;
	error?: string;
	usage?: AgentUsage;
}

export interface WorkflowDetails {
	runId: string;
	sessionId: string;
	name: string;
	description?: string;
	background: boolean;
	state: WorkflowState;
	startedAt: number;
	endedAt?: number;
	currentPhase?: string;
	phases: string[];
	agents: WorkflowAgentRecord[];
	result?: unknown;
	error?: string;
}

export class WorkflowController {
	readonly details: WorkflowDetails;
	private readonly abortController = new AbortController();
	private readonly semaphore = new Semaphore(MAX_WORKFLOW_CONCURRENCY);
	private readonly tasks = new Set<Promise<unknown>>();
	private readonly timeout: ReturnType<typeof setTimeout>;
	private callCount = 0;
	private sealed = false;
	private detachParent: () => void;
	private readonly delegation: DelegationClient;
	private readonly onChange: () => void;

	constructor(options: {
		runId: string;
		sessionId: string;
		name: string;
		description?: string;
		background: boolean;
		parentSignal?: AbortSignal;
		delegation: DelegationClient;
		onChange: () => void;
	}) {
		this.details = {
			runId: options.runId,
			sessionId: options.sessionId,
			name: options.name,
			...(options.description ? { description: options.description } : {}),
			background: options.background,
			state: "running",
			startedAt: Date.now(),
			phases: [],
			agents: [],
		};
		this.delegation = options.delegation;
		this.onChange = options.onChange;
		this.detachParent = linkAbortSignal(options.parentSignal, this.abortController);
		this.timeout = setTimeout(() => this.abort("Workflow exceeded the 30 minute wall-clock limit"), WORKFLOW_TIMEOUT_MS);
		this.timeout.unref?.();
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	phase(title: unknown): void {
		const value = String(title ?? "").trim().slice(0, 160);
		if (!value || value === this.details.currentPhase) return;
		if (!this.details.phases.includes(value)) {
			if (this.details.phases.length >= MAX_WORKFLOW_PHASES) {
				throw new Error(`Workflow exceeded ${MAX_WORKFLOW_PHASES} distinct phases`);
			}
			this.details.phases.push(value);
		}
		this.details.currentPhase = value;
		this.onChange();
	}

	runAgent(prompt: string, options: AgentCallOptions = {}, invocationSignal?: AbortSignal): Promise<AgentCallResult> {
		if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
		if (this.signal.aborted) return Promise.reject(abortError(this.signal));
		if (++this.callCount > MAX_WORKFLOW_AGENT_CALLS) return Promise.reject(new Error(`Workflow exceeded ${MAX_WORKFLOW_AGENT_CALLS} agent calls`));
		const index = this.callCount;
		const nodeId = `agent-${index}`;
		const agent = options.agent?.trim() || "general-purpose";
		const record: WorkflowAgentRecord = {
			index,
			nodeId,
			label: options.label?.trim().slice(0, 160) || nodeId,
			agent,
			...(options.phase?.trim() ? { phase: options.phase.trim().slice(0, 160) } : this.details.currentPhase ? { phase: this.details.currentPhase } : {}),
			...(options.model?.trim() ? { model: options.model.trim().slice(0, 256) } : {}),
			state: "queued",
		};
		this.details.agents.push(record);
		this.onChange();

		const running = (async () => {
			const taskController = new AbortController();
			const detachRun = linkAbortSignal(this.signal, taskController);
			const detachInvocation = linkAbortSignal(invocationSignal, taskController);
			let release: (() => void) | undefined;
			try {
				release = await this.semaphore.acquire(taskController.signal);
				record.state = "running";
				record.startedAt = Date.now();
				this.onChange();
				const result = await this.delegation.run({
					ownerRunId: this.details.runId,
					nodeId,
					prompt,
					call: { ...options, agent },
					signal: taskController.signal,
					onProgress: (progress) => this.updateProgress(record, progress),
				});
				record.state = result.ok ? "done" : "failed";
				delete record.currentTool;
				record.endedAt = Date.now();
				if (result.runId !== undefined) record.runId = result.runId;
				if (result.model !== undefined) record.model = result.model;
				if (result.error) record.error = result.error;
				if (result.usage) record.usage = result.usage;
				record.preview = (result.output || record.preview || "").slice(-2_000);
				this.onChange();
				return result;
			} catch (error) {
				record.state = taskController.signal.aborted ? "aborted" : "failed";
				delete record.currentTool;
				record.endedAt = Date.now();
				record.error = error instanceof Error ? error.message : String(error);
				this.onChange();
				throw error;
			} finally {
				release?.();
				detachRun();
				detachInvocation();
			}
		})();
		this.tasks.add(running);
		void running.finally(() => this.tasks.delete(running)).catch(() => {});
		return running;
	}

	abort(reason = "Workflow aborted"): void {
		if (!this.signal.aborted) this.abortController.abort(new Error(reason));
		this.semaphore.clear(reason);
		if (this.details.state === "running") {
			this.details.state = "aborted";
			this.details.error ??= reason;
			this.onChange();
		}
	}

	async finalize(options: { result?: unknown; error?: unknown }): Promise<boolean> {
		if (this.sealed) return false;
		this.sealed = true;
		const abortedBeforeFailure = this.signal.aborted;
		if (options.error && !abortedBeforeFailure) this.abort(options.error instanceof Error ? options.error.message : String(options.error));
		const settled = await settleWithin(Promise.allSettled([...this.tasks]).then(() => true), WORKFLOW_SHUTDOWN_MS);
		if (!settled) {
			this.abort("Agent shutdown deadline exceeded");
			this.details.state = "failed";
			this.details.error = "Agent shutdown deadline exceeded";
		} else if (options.error) {
			this.details.state = abortedBeforeFailure ? "aborted" : "failed";
			this.details.error = options.error instanceof Error ? options.error.message : String(options.error);
		} else if (this.signal.aborted) {
			this.details.state = "aborted";
			this.details.error ??= this.signal.reason instanceof Error ? this.signal.reason.message : "Workflow aborted";
		} else {
			this.details.state = "completed";
			this.details.result = options.result;
		}
		this.details.endedAt = Date.now();
		for (const record of this.details.agents) {
			if (record.state === "queued" || record.state === "running") {
				record.state = this.signal.aborted ? "aborted" : "failed";
				delete record.currentTool;
				record.endedAt = Date.now();
				record.error ??= "Agent did not settle before workflow cleanup";
			}
		}
		clearTimeout(this.timeout);
		this.detachParent();
		this.onChange();
		return Boolean(settled);
	}

	private updateProgress(record: WorkflowAgentRecord, progress: DelegationProgress): void {
		let changed = false;
		const update = <Key extends keyof WorkflowAgentRecord>(key: Key, value: WorkflowAgentRecord[Key] | undefined) => {
			if (value === undefined || record[key] === value) return;
			record[key] = value;
			changed = true;
		};
		update("runId", progress.runId);
		update("model", progress.model?.slice(0, 256));
		update("currentTool", progress.currentTool?.slice(0, 160));
		update("preview", progress.recentOutput?.slice(-2_000));
		update("toolCount", progress.toolCount);
		update("durationMs", progress.durationMs);
		update("tokens", progress.tokens);
		if (!changed) return;
		record.lastProgressAt = Date.now();
		this.onChange();
	}
}
