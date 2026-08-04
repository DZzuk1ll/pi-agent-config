import * as fs from "node:fs";
import * as path from "node:path";
import { omitUndefined } from "../../../../_shared/runtime/omit-undefined.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { RESULTS_DIR, type AsyncParallelGroupStatus, type AsyncStatus, type ModelAttempt, type NestedRunSummary, type SubagentRunMode, type Usage } from "../../shared/types.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { decodeAsyncStatus } from "../../shared/status-schema.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, type NestedRoute } from "../shared/nested-events.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
	const stderrPath = path.join(asyncDir, "runner.stderr.log");
	const maxBytes = 64 * 1024;
	let content: string;
	try {
		const stat = fs.statSync(stderrPath);
		if (stat.size <= 0) return undefined;
		const fd = fs.openSync(stderrPath, "r");
		try {
			const bytesToRead = Math.min(stat.size, maxBytes);
			const start = Math.max(0, stat.size - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			fs.readSync(fd, buffer, 0, bytesToRead, start);
			content = buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(-30).join("\n");
	return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function appendJsonlBestEffort(filePath: string, payload: object): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Repair status/result writes are the important path. A broken or full
		// diagnostic event log must not make stale-run reconciliation fail.
	}
}

function readStatusFile(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return decodeAsyncStatus(JSON.parse(content) as unknown, statusPath);
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

interface ResultChildOutcome {
	agent?: string;
	success?: boolean;
	error?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
}

interface ResultRepairData {
	state: "complete" | "failed" | "paused" | "stopped";
	results?: ResultChildOutcome[];
}

function decodeUsage(value: unknown, source: string): Usage | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${source} must be an object.`);
	const usage = value as Record<string, unknown>;
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
		if (typeof usage[field] !== "number") throw new TypeError(`${source}.${field} must be a number.`);
	}
	return { input: usage.input as number, output: usage.output as number, cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, cost: usage.cost as number, turns: usage.turns as number };
}

function decodeModelAttempts(value: unknown, source: string): ModelAttempt[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError(`${source} must be an array.`);
	return value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`${source}[${index}] must be an object.`);
		const attempt = entry as Record<string, unknown>;
		if (typeof attempt.model !== "string" || typeof attempt.success !== "boolean") throw new TypeError(`${source}[${index}] is missing model or success.`);
		if (attempt.exitCode !== undefined && attempt.exitCode !== null && typeof attempt.exitCode !== "number") throw new TypeError(`${source}[${index}].exitCode must be a number or null.`);
		if (attempt.error !== undefined && typeof attempt.error !== "string") throw new TypeError(`${source}[${index}].error must be a string.`);
		return omitUndefined({
			model: attempt.model,
			success: attempt.success,
			exitCode: typeof attempt.exitCode === "number" || attempt.exitCode === null ? attempt.exitCode : undefined,
			error: typeof attempt.error === "string" ? attempt.error : undefined,
			usage: decodeUsage(attempt.usage, `${source}[${index}].usage`),
		});
	});
}

function readResultRepairData(resultPath: string): ResultRepairData | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("expected a JSON object");
		const data = parsed as Record<string, unknown>;
		if (data.success !== undefined && typeof data.success !== "boolean") throw new TypeError("success must be a boolean");
		if (data.state !== undefined && typeof data.state !== "string") throw new TypeError("state must be a string");
		if (data.exitCode !== undefined && typeof data.exitCode !== "number") throw new TypeError("exitCode must be a number");
		const state = data.success ? "complete" : data.state === "stopped" ? "stopped" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
		const results = Array.isArray(data.results)
			? data.results.map((entry, index) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
				const child = entry as Record<string, unknown>;
				for (const field of ["agent", "error", "sessionFile", "model", "thinking"] as const) {
					if (child[field] !== undefined && typeof child[field] !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].${field} must be a string.`);
				}
				if (child.success !== undefined && typeof child.success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
				if (child.attemptedModels !== undefined && (!Array.isArray(child.attemptedModels) || child.attemptedModels.some((model) => typeof model !== "string"))) throw new Error(`Invalid async result file '${resultPath}': results[${index}].attemptedModels must contain strings.`);
				const modelAttempts = decodeModelAttempts(child.modelAttempts, `results[${index}].modelAttempts`);
				return omitUndefined({
					agent: typeof child.agent === "string" ? child.agent : undefined,
					success: typeof child.success === "boolean" ? child.success : undefined,
					error: typeof child.error === "string" ? child.error : undefined,
					sessionFile: typeof child.sessionFile === "string" ? child.sessionFile : undefined,
					model: typeof child.model === "string" ? child.model : undefined,
					thinking: typeof child.thinking === "string" ? child.thinking : undefined,
					attemptedModels: Array.isArray(child.attemptedModels) ? child.attemptedModels as string[] : undefined,
					modelAttempts,
				});
			})
			: undefined;
		return { state, ...(results ? { results } : {}) };
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): "complete" | "failed" | "paused" | "stopped" {
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

function terminalStatusFromResult(status: AsyncStatus, resultPath: string, now: number): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath);
	if (!repair) return undefined;
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		const model = child?.model ?? step.model;
		const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
		return omitUndefined({
			...step,
			status: state === "complete" ? "complete" as const : state,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: state === "failed" || state === "stopped" ? step.error ?? child?.error : step.error,
			stopped: state === "stopped" ? true : step.stopped,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model,
			thinking,
			attemptedModels: child?.attemptedModels ?? step.attemptedModels,
			modelAttempts: child?.modelAttempts ?? step.modelAttempts,
		});
	});
	return omitUndefined({
		...status,
		state: repair.state,
		...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
			processTerminal: { version: 1 as const, state: "unknown" as const, runId: status.runId, runnerProcessInstanceId: "observer-unavailable", reason: "observer-unavailable" as const },
		} : {}),
		...(repair.state === "stopped" ? { stopped: true } : {}),
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
	});
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return omitUndefined({
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	});
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string): { status: AsyncStatus; result: object; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const baseMessage = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const diagnostics = readRunnerStartupDiagnostics(asyncDir);
	const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
		? omitUndefined({
			...step,
			status: "failed" as const,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? 1,
			error: step.error ?? message,
		})
		: step);
	const repairedStatus: AsyncStatus = omitUndefined({
		...status,
		state: "failed",
		...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
			processTerminal: { version: 1 as const, state: "unknown" as const, runId, runnerProcessInstanceId: "observer-unavailable", reason: "stale-repair" as const },
		} : {}),
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	});
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			success: false,
			state: "failed",
			summary: message,
			results: repairedSteps.map((step) => ({
				agent: step.agent,
				output: step.status === "complete" || step.status === "completed" ? "" : message,
				error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
				success: step.status === "complete" || step.status === "completed",
				model: step.model,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				sessionFile: step.sessionFile,
			})),
			exitCode: 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

function writeFailedRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number, reason?: string): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

function terminal(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "stopped";
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state)) continue;
		const ts = options.now?.() ?? Date.now();
		writeNestedEvent(route, omitUndefined({
			type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			parentStepIndex: run.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(status, asyncDir, {
				id: run.id,
				parentRunId: run.parentRunId,
				...(run.parentStepIndex === undefined ? {} : { parentStepIndex: run.parentStepIndex }),
				depth: run.depth,
				path: run.path,
				...(run.mode === undefined ? {} : { mode: run.mode }),
				ts,
			}),
		}));
	}
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill): PidLiveness {
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatusFile(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };
	const statusPath = path.join(asyncDir, "status.json");
	for (const [index, step] of (effectiveStatus.steps ?? []).entries()) {
		const stepRecord = step as Record<string, unknown>;
		if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
		if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
	}

	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
	if (fs.existsSync(resultPath)) {
		const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
			? terminalStatusFromResult(effectiveStatus, resultPath, now)
			: undefined;
		if (terminalStatus) {
			writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
			return { status: terminalStatus, repaired: true, resultPath, message: "Existing async result file was used to repair stale running status." };
		}
		return { status: effectiveStatus, repaired: false, resultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
	if (liveness !== "dead") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
		return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
	}

	return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
