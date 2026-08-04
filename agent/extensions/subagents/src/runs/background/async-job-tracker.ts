import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { omitUndefined, } from "../../../../_shared/runtime/omit-undefined.ts";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SteeringNotice,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";
import { isOwnedByOrchestratorUi } from "../../shared/ui-ownership.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { requirePresent } from "../../../../_shared/runtime/require-present.ts";


interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	widgetEnabled?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_FLEET_JOBS = 20;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function decodeSteeringNotice(value: unknown): SteeringNotice | undefined {
	const notice = recordValue(value);
	if (!notice) return undefined;
	if (notice.type !== "subagent.steering.notice" || typeof notice.ts !== "number" || typeof notice.runId !== "string" || typeof notice.requestId !== "string" || (notice.state !== "failed" && notice.state !== "partial" && notice.state !== "recovered") || typeof notice.message !== "string" || (notice.currentSessionId !== undefined && typeof notice.currentSessionId !== "string")) return undefined;
	return omitUndefined({
		type: "subagent.steering.notice" as const,
		ts: notice.ts,
		runId: notice.runId,
		requestId: notice.requestId,
		state: notice.state,
		message: notice.message,
		currentSessionId: typeof notice.currentSessionId === "string" ? notice.currentSessionId : undefined,
	});
}

function decodeControlEvent(value: unknown): ControlEvent | undefined {
	const event = recordValue(value);
	if (!event || (event.type !== "active_long_running" && event.type !== "needs_attention") || (event.to !== "active_long_running" && event.to !== "needs_attention") || typeof event.ts !== "number" || typeof event.agent !== "string" || typeof event.runId !== "string" || typeof event.message !== "string") return undefined;
	if (event.from !== undefined && event.from !== "active_long_running" && event.from !== "needs_attention") return undefined;
	const stringFields = ["nestedRunId", "currentTool", "currentPath", "recentFailureSummary"] as const;
	if (stringFields.some((field) => event[field] !== undefined && typeof event[field] !== "string")) return undefined;
	const numberFields = ["index", "turns", "tokens", "toolCount", "currentToolDurationMs", "elapsedMs"] as const;
	if (numberFields.some((field) => event[field] !== undefined && typeof event[field] !== "number")) return undefined;
	const reasons = new Set(["idle", "completion_guard", "active_long_running", "tool_failures", "supervisor_request", "time_threshold", "turn_threshold", "token_threshold"]);
	if (event.reason !== undefined && (typeof event.reason !== "string" || !reasons.has(event.reason))) return undefined;
	let nestingPath: NonNullable<ControlEvent["nestingPath"]> | undefined;
	if (event.nestingPath !== undefined) {
		if (!Array.isArray(event.nestingPath)) return undefined;
		nestingPath = [];
		for (const value of event.nestingPath) {
			const entry = recordValue(value);
			if (!entry || typeof entry.runId !== "string" || (entry.stepIndex !== undefined && typeof entry.stepIndex !== "number") || (entry.agent !== undefined && typeof entry.agent !== "string")) return undefined;
			nestingPath.push(omitUndefined({ runId: entry.runId, stepIndex: typeof entry.stepIndex === "number" ? entry.stepIndex : undefined, agent: typeof entry.agent === "string" ? entry.agent : undefined }));
		}
	}
	return omitUndefined({
		type: event.type,
		from: event.from,
		to: event.to,
		ts: event.ts,
		agent: event.agent,
		index: typeof event.index === "number" ? event.index : undefined,
		runId: event.runId,
		nestedRunId: typeof event.nestedRunId === "string" ? event.nestedRunId : undefined,
		nestingPath,
		message: event.message,
		reason: event.reason as ControlEvent["reason"],
		turns: typeof event.turns === "number" ? event.turns : undefined,
		tokens: typeof event.tokens === "number" ? event.tokens : undefined,
		toolCount: typeof event.toolCount === "number" ? event.toolCount : undefined,
		currentTool: typeof event.currentTool === "string" ? event.currentTool : undefined,
		currentToolDurationMs: typeof event.currentToolDurationMs === "number" ? event.currentToolDurationMs : undefined,
		currentPath: typeof event.currentPath === "string" ? event.currentPath : undefined,
		elapsedMs: typeof event.elapsedMs === "number" ? event.elapsedMs : undefined,
		recentFailureSummary: typeof event.recentFailureSummary === "string" ? event.recentFailureSummary : undefined,
	});
}

function rememberFleetJob(state: SubagentState, job: AsyncJobState): void {
	state.fleetJobs ??= new Map();
	state.fleetJobs.set(job.asyncId, job);
	const terminal = [...state.fleetJobs.values()]
		.filter((candidate) => candidate.status === "complete" || candidate.status === "failed" || candidate.status === "paused" || candidate.status === "stopped")
		.sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
	for (const stale of terminal.slice(MAX_RECENT_FLEET_JOBS)) state.fleetJobs.delete(stale.asyncId);
}

export function collectSubagentWidgetJobs(state: SubagentState): AsyncJobState[] {
	const asyncJobs = [...state.asyncJobs.values()].map((job) => ({ ...job, source: job.source ?? "async" as const }));
	const foregroundJobs = [...state.foregroundControls.values()]
		.filter((control) => !isOwnedByOrchestratorUi(control))
		.filter((control) => state.currentSessionId ? control.sessionId === state.currentSessionId : control.sessionId === undefined)
		.map((control): AsyncJobState => {
			const children = [...(control.activeChildren?.values() ?? [])].sort((left, right) => left.index - right.index);
			const agents = children.length > 0
				? children.map((child) => child.agent)
				: control.currentAgent ? [control.currentAgent] : [];
			const steps = children.map((child) => omitUndefined({
				agent: child.agent,
				index: child.index,
				status: "running" as const,
				activityState: child.currentActivityState,
				lastActivityAt: child.lastActivityAt,
				currentTool: child.currentTool,
				currentToolStartedAt: child.currentToolStartedAt,
				currentPath: child.currentPath,
				turnCount: child.turnCount,
				toolCount: child.toolCount,
				startedAt: child.startedAt,
				durationMs: Math.max(0, Date.now() - child.startedAt),
				model: child.model,
				thinking: child.thinking,
				...(child.tokens !== undefined ? {
					tokens: {
						input: child.inputTokens ?? 0,
						output: child.outputTokens ?? 0,
						total: child.tokens,
					},
				} : {}),
			}));
			return omitUndefined({
				asyncId: `foreground:${control.runId}`,
				asyncDir: "",
				source: "foreground",
				cwd: control.cwd,
				sessionId: control.sessionId,
				status: "running",
				mode: control.mode,
				description: control.description,
				agents,
				steps,
				stepsTotal: steps.length || undefined,
				runningSteps: steps.length,
				completedSteps: 0,
				hasParallelGroups: control.mode === "parallel",
				activeParallelGroup: control.mode === "parallel",
				currentStep: control.currentIndex,
				startedAt: control.startedAt,
				updatedAt: control.updatedAt,
				activityState: control.currentActivityState,
				lastActivityAt: control.lastActivityAt,
				currentTool: control.currentTool,
				currentToolStartedAt: control.currentToolStartedAt,
				currentPath: control.currentPath,
				turnCount: control.turnCount,
				toolCount: control.toolCount,
				...(control.tokens !== undefined ? {
					totalTokens: {
						input: control.inputTokens ?? 0,
						output: control.outputTokens ?? 0,
						total: control.tokens,
					},
				} : {}),
				nestedRoute: control.nestedRoute,
				nestedChildren: control.nestedChildren,
			});
		});
	return [...asyncJobs, ...foregroundJobs];
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	refreshWidget: (ctx: ExtensionContext) => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	restoreActiveJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const steeringNoticeSeen = new Map<string, number>();
	const rerenderWidget = (ctx: ExtensionContext, jobs = collectSubagentWidgetJobs(state)) => {
		renderWidget(ctx, options.widgetEnabled === false ? [] : jobs);
	};
	const rerenderLastWidget = (jobs = collectSubagentWidgetJobs(state)) => {
		const ctx = state.lastUiContext;
		if (!ctx) return;
		try {
			if (ctx.hasUI) rerenderWidget(ctx, jobs);
		} catch (error) {
			if (error instanceof Error && error.message.includes("extension ctx is stale")) {
				state.lastUiContext = null;
				return;
			}
			throw error;
		}
	};
	const refreshWidget = (ctx: ExtensionContext) => rerenderWidget(ctx);
	const restoredControlEventCursor = (asyncDir: string) => {
		try {
			return fs.statSync(path.join(asyncDir, "events.jsonl")).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	};
	const summaryToJob = (run: AsyncRunSummary): AsyncJobState => {
		const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, run.chainStepCount ?? run.steps.length);
		const activeGroup = run.currentStep !== undefined
			? groups.find((group) => requirePresent(run.currentStep) >= group.start && requirePresent(run.currentStep) < group.start + group.count)
			: undefined;
		const visibleSteps = activeGroup
			? run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => omitUndefined({ ...step, index: activeGroup.start + index }))
			: run.steps.map((step, index) => omitUndefined({ ...step, index }));
		return omitUndefined({
			asyncId: run.id,
			asyncDir: run.asyncDir,
			status: run.state,
			sessionId: run.sessionId,
			activityState: run.activityState,
			lastActivityAt: run.lastActivityAt,
			currentTool: run.currentTool,
			currentToolStartedAt: run.currentToolStartedAt,
			currentPath: run.currentPath,
			turnCount: run.turnCount,
			toolCount: run.toolCount,
			steering: run.steering,
			mode: run.mode,
			context: run.context,
			cwd: run.cwd,
			agents: visibleSteps.map((step) => step.agent),
			currentStep: run.currentStep,
			chainStepCount: run.chainStepCount,
			parallelGroups: groups,
			steps: visibleSteps,
			stepsTotal: visibleSteps.length,
			runningSteps: visibleSteps.filter((step) => step.status === "running").length,
			completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
			hasParallelGroups: groups.length > 0,
			activeParallelGroup: Boolean(activeGroup),
			startedAt: run.startedAt,
			updatedAt: run.lastUpdate ?? run.startedAt,
			timeoutMs: run.timeoutMs,
			deadlineAt: run.deadlineAt,
			timedOut: run.timedOut,
			stopped: run.stopped,
			turnBudget: run.turnBudget,
			turnBudgetExceeded: run.turnBudgetExceeded,
			wrapUpRequested: run.wrapUpRequested,
			sessionDir: run.sessionDir,
			outputFile: run.outputFile,
			totalTokens: run.totalTokens,
			sessionFile: run.sessionFile,
			controlEventCursor: restoredControlEventCursor(run.asyncDir),
			nestedChildren: run.nestedChildren,
		});
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			rerenderLastWidget();
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const savedCursor = job.controlEventCursor;
			let cursor = stat.size < (savedCursor ?? 0) ? 0 : (savedCursor ?? 0);
			const startedFromTail = savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (stat.size <= cursor) return;
			const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					return;
				}
				const parsedRecord = recordValue(parsed);
				if (!parsedRecord) return;
				if (parsedRecord.type === "subagent.steering.notice") {
					const notice = decodeSteeringNotice(parsedRecord);
					if (!notice) return;
					if (typeof state.currentSessionId === "string" && notice.currentSessionId !== state.currentSessionId) return;
					const key = `${notice.runId}:${notice.requestId}:${notice.state}`;
					if (steeringNoticeSeen.has(key)) return;
					const now = Date.now();
					steeringNoticeSeen.set(key, now);
					if (steeringNoticeSeen.size > 200) {
						for (const [seenKey, seenAt] of steeringNoticeSeen) {
							if (now - seenAt > 10 * 60 * 1000 || steeringNoticeSeen.size > 200) steeringNoticeSeen.delete(seenKey);
						}
					}
					pi.events.emit(SUBAGENT_STEERING_NOTICE_EVENT, { ...notice, source: "async", asyncDir: job.asyncDir, noticeText: notice.message });
					return;
				}
				if (parsedRecord.type !== "subagent.control") return;
				const event = decodeControlEvent(parsedRecord.event);
				if (!event || !Array.isArray(parsedRecord.channels) || parsedRecord.channels.some((channel) => typeof channel !== "string")) return;
				if (parsedRecord.childIntercomTarget !== undefined && typeof parsedRecord.childIntercomTarget !== "string") return;
				if (parsedRecord.noticeText !== undefined && typeof parsedRecord.noticeText !== "string") return;
				const intercom = recordValue(parsedRecord.intercom);
				const childIntercomTarget = typeof parsedRecord.childIntercomTarget === "string" ? parsedRecord.childIntercomTarget : undefined;
				const payload = {
					event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget,
					noticeText: typeof parsedRecord.noticeText === "string" ? parsedRecord.noticeText : formatControlNoticeMessage(event, childIntercomTarget),
				};
				if (parsedRecord.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (event.type !== "active_long_running" && parsedRecord.channels.includes("intercom") && typeof intercom?.to === "string" && typeof intercom.message === "string") {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: intercom.to,
						message: intercom.message,
					});
				}
			};
			let readCursor = cursor;
			let lastCompleteCursor = cursor;
			let lineParts: Buffer[] = [];
			let lineBytes = 0;
			let skippingOversizedLine = startedFromTail;
			const appendLineSegment = (segment: Buffer) => {
				if (segment.length === 0 || skippingOversizedLine) return;
				if (lineBytes + segment.length > MAX_CONTROL_EVENT_LINE_BYTES) {
					lineParts = [];
					lineBytes = 0;
					skippingOversizedLine = true;
					return;
				}
				lineParts.push(segment);
				lineBytes += segment.length;
			};
			while (readCursor < scanEnd) {
				const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, scanEnd - readCursor);
				const buffer = Buffer.alloc(toRead);
				const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
				if (bytesRead <= 0) break;
				const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
				let lineStart = 0;
				for (let index = 0; index < chunk.length; index++) {
					if (chunk[index] !== 0x0a) continue;
					appendLineSegment(chunk.subarray(lineStart, index));
					if (!skippingOversizedLine && lineBytes > 0) {
						handleLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
					}
					lineParts = [];
					lineBytes = 0;
					skippingOversizedLine = false;
					lastCompleteCursor = readCursor + index + 1;
					lineStart = index + 1;
				}
				appendLineSegment(chunk.subarray(lineStart));
				readCursor += bytesRead;
				if (skippingOversizedLine) job.controlEventCursor = readCursor;
			}
			if (lastCompleteCursor > cursor) job.controlEventCursor = lastCompleteCursor;
			else if (scanEnd < stat.size || startedFromTail) job.controlEventCursor = scanEnd;
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				rerenderLastWidget();
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			let widgetChanged = false;
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, omitUndefined({ resultsDir, kill: options.kill, now: options.now }));
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, omitUndefined({
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: omitUndefined({
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						}),
					}));
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "stopped") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.steering = status.steering ?? job.steering;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => requirePresent(status.currentStep) >= group.start && requirePresent(status.currentStep) < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
						job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
						job.timedOut = status.timedOut ?? job.timedOut;
						job.stopped = status.stopped ?? job.stopped;
						job.turnBudget = status.turnBudget ?? job.turnBudget;
						job.turnBudgetExceeded = status.turnBudgetExceeded ?? job.turnBudgetExceeded;
						job.wrapUpRequested = status.wrapUpRequested ?? job.wrapUpRequested;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if (job.status === "complete" || job.status === "failed" || job.status === "paused" || job.status === "stopped") {
							rememberFleetJob(state, job);
							if (!nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
								scheduleCleanup(job.asyncId);
							}
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					rememberFleetJob(state, job);
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
			}

			if (widgetChanged) rerenderLastWidget();
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		if (typeof state.currentSessionId === "string" && info.sessionId !== state.currentSessionId) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			...(typeof info.cwd === "string" ? { cwd: path.resolve(info.cwd) } : {}),
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			description: info.goal ?? info.task,
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
			timeoutMs: info.timeoutMs,
			deadlineAt: info.deadlineAt,
			turnBudget: info.turnBudget,
			controlEventCursor: 0,
		});
		rememberFleetJob(state, requirePresent(state.asyncJobs.get(info.id)));
		ensurePoller();
		rerenderLastWidget();
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; state?: AsyncJobState["status"]; asyncDir?: string; sessionId?: string; stopped?: boolean };
		if (typeof state.currentSessionId === "string" && result.sessionId !== state.currentSessionId) return;
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.state ?? (result.success ? "complete" : "failed");
			job.stopped = result.stopped ?? job.stopped;
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		if (job) rememberFleetJob(state, job);
		rerenderLastWidget();
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.fleetJobs?.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	const restoreActiveJobs = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) state.lastUiContext = ctx;
		if (!state.currentSessionId) return;
		let runs: AsyncRunSummary[];
		try {
			runs = listAsyncRuns(asyncDirRoot, omitUndefined({ states: ["queued", "running"], sessionId: state.currentSessionId, resultsDir, kill: options.kill, now: options.now }));
		} catch (error) {
			console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
			return;
		}
		for (const run of runs) {
			const job = summaryToJob(run);
			state.asyncJobs.set(run.id, job);
			rememberFleetJob(state, job);
		}
		if (runs.length === 0) return;
		ensurePoller();
		rerenderLastWidget();
	};

	return { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs };
}
