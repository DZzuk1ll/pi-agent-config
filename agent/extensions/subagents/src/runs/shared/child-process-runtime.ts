import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedTurnBudget, TurnBudgetState } from "../../shared/types.ts";
import { attachPostExitStdioGuard, isChildProcessTreeAlive, trySignalChildTree } from "../../shared/post-exit-stdio-guard.ts";
import {
	createBoundedByteTail,
	createBoundedLineReader,
	formatProtocolOutputLimit,
	MAX_CHILD_STDERR_BYTES,
	projectChildLifecycle,
	type ProtocolOutputLimit,
} from "./child-protocol.ts";
import { turnBudgetDecision, turnBudgetExceededMessage, turnBudgetState } from "./turn-budget.ts";

export type RuntimeTerminationReason = "cancel" | "interrupt" | "timeout" | "turn-budget" | "stop" | "protocol" | "final-drain";
export type RuntimeSignalRoute = "process-group" | "windows-tree" | "direct";

export function resolveRuntimeSignalRoute(
	platform: NodeJS.Platform,
	processGroup: boolean,
	signal: NodeJS.Signals,
): RuntimeSignalRoute {
	if (platform !== "win32" && processGroup) return "process-group";
	if (platform === "win32" && signal !== "SIGINT") return "windows-tree";
	return "direct";
}

export interface ChildRuntimeEvent {
	[key: string]: unknown;
	type?: string;
	willRetry?: unknown;
	message?: {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: unknown;
	};
}

export interface ChildProcessRuntimeResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	rawStdout: string;
	protocolError?: ProtocolOutputLimit;
	spawnError?: string;
	terminationReason?: RuntimeTerminationReason;
	forcedTermination: boolean;
	detached: boolean;
	terminalSeen: boolean;
	turnCount: number;
	turnBudget?: TurnBudgetState;
}

export interface ChildProcessRuntimeControls {
	readonly child: ChildProcess;
	terminate(reason: RuntimeTerminationReason, initialSignal?: "SIGINT" | "SIGTERM"): void;
	detach(): void;
	setWatchdogActive(active: boolean): void;
}

export interface ChildProcessRuntimeOptions<TEvent extends ChildRuntimeEvent = ChildRuntimeEvent> {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	processGroup?: boolean;
	signal?: AbortSignal;
	cancelInitialSignal?: "SIGINT" | "SIGTERM";
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	enforceHardTurnLimit?: boolean;
	watchdogTailMs?: number;
	finalDrainMs?: number;
	termGraceMs?: number;
	hardKillMs?: number;
	maxStdoutLineBytes?: number;
	maxStderrLineBytes?: number;
	onEvent?(event: TEvent, controls: ChildProcessRuntimeControls): void;
	onStdoutLine?(line: string): void;
	onRawStdoutLine?(line: string): void;
	onStderrLine?(line: string): void;
	onStderrChunk?(chunk: Buffer): void;
	onProtocolLimit?(limit: ProtocolOutputLimit): void;
	onTurnBudget?(state: TurnBudgetState, message?: string): void;
	onWatchdogTail?(): void;
	onTerminationRequested?(reason: RuntimeTerminationReason): void;
	onControls?(controls: ChildProcessRuntimeControls): void;
	onSpawn?(child: ChildProcess): void;
}

function assistantStartsToolCall(event: ChildRuntimeEvent): boolean {
	const content = event.message?.content;
	return Array.isArray(content) && content.some((part) => part && typeof part === "object" && Reflect.get(part, "type") === "toolCall");
}

function terminalAssistantStop(event: ChildRuntimeEvent): boolean {
	return event.type === "message_end"
		&& event.message?.role === "assistant"
		&& event.message.stopReason === "stop"
		&& !assistantStartsToolCall(event);
}

/** Shared foreground/background Pi child runtime. Orchestration and persistence stay in adapters. */
export function runChildProcess<TEvent extends ChildRuntimeEvent = ChildRuntimeEvent>(
	options: ChildProcessRuntimeOptions<TEvent>,
): Promise<ChildProcessRuntimeResult> {
	return new Promise((resolve) => {
		const processGroup = options.processGroup === true && process.platform !== "win32";
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: processGroup,
		});
		const stdoutTail = createBoundedByteTail();
		const stderrTail = createBoundedByteTail();
		const finalDrainMs = options.finalDrainMs ?? 1000;
		const termGraceMs = options.termGraceMs ?? 1000;
		const hardKillMs = options.hardKillMs ?? 3000;
		let settled = false;
		let exited = false;
		let detached = false;
		let forcedTermination = false;
		let terminationReason: RuntimeTerminationReason | undefined;
		let protocolError: ProtocolOutputLimit | undefined;
		let spawnError: string | undefined;
		let watchdogActive = false;
		let terminalSeen = false;
		let turnCount = 0;
		let turnBudget: TurnBudgetState | undefined;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let watchdogTailTimer: NodeJS.Timeout | undefined;
		let termTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let removeAbortListener: (() => void) | undefined;

		const signalChild = (signal: NodeJS.Signals): boolean =>
			trySignalChildTree(child, signal, { processGroup });
		const inactive = (): boolean => settled || detached || (exited && !processGroup);
		const clearTimer = (timer: NodeJS.Timeout | undefined): undefined => {
			if (timer) clearTimeout(timer);
			return undefined;
		};
		const clearTerminationTimers = (): void => {
			termTimer = clearTimer(termTimer);
			killTimer = clearTimer(killTimer);
		};
		const clearDrainTimers = (): void => {
			finalDrainTimer = clearTimer(finalDrainTimer);
			watchdogTailTimer = clearTimer(watchdogTailTimer);
		};

		const terminate = (reason: RuntimeTerminationReason, initialSignal: "SIGINT" | "SIGTERM" = "SIGINT"): void => {
			if (inactive() || terminationReason) return;
			terminationReason = reason;
			forcedTermination = true;
			clearDrainTimers();
			options.onTerminationRequested?.(reason);
			signalChild(initialSignal);
			if (initialSignal === "SIGINT") {
				termTimer = setTimeout(() => {
					if (!inactive()) signalChild("SIGTERM");
				}, termGraceMs);
				termTimer.unref?.();
			}
			killTimer = setTimeout(() => {
				if (!inactive()) signalChild("SIGKILL");
			}, (initialSignal === "SIGINT" ? termGraceMs : 0) + hardKillMs);
			killTimer.unref?.();
		};

		const startFinalDrain = (): void => {
			if (!terminalSeen || inactive() || finalDrainTimer || terminationReason) return;
			if (watchdogActive) {
				if (watchdogTailTimer) return;
				watchdogTailTimer = setTimeout(() => {
					watchdogTailTimer = undefined;
					watchdogActive = false;
					options.onWatchdogTail?.();
					startFinalDrain();
				}, options.watchdogTailMs ?? 120_000);
				watchdogTailTimer.unref?.();
				return;
			}
			finalDrainTimer = setTimeout(() => terminate("final-drain", "SIGTERM"), finalDrainMs);
			finalDrainTimer.unref?.();
		};

		const controls: ChildProcessRuntimeControls = {
			child,
			terminate,
			detach() {
				if (settled) return;
				detached = true;
				clearDrainTimers();
				clearTerminationTimers();
				timeoutTimer = clearTimer(timeoutTimer);
				removeAbortListener?.();
			},
			setWatchdogActive(active) {
				watchdogActive = active;
				if (active) {
					finalDrainTimer = clearTimer(finalDrainTimer);
					startFinalDrain();
				} else {
					watchdogTailTimer = clearTimer(watchdogTailTimer);
					startFinalDrain();
				}
			},
		};

		const failProtocol = (limit: ProtocolOutputLimit): void => {
			if (protocolError) return;
			protocolError = limit;
			options.onProtocolLimit?.(limit);
			terminate("protocol", "SIGTERM");
		};
		const stdoutReader = createBoundedLineReader({
			maxPendingLineBytes: options.maxStdoutLineBytes,
			onLimit: failProtocol,
			onLine(line) {
				if (!line.trim()) return;
				options.onStdoutLine?.(line);
				let event: TEvent;
				try {
					event = JSON.parse(line) as TEvent;
				} catch {
					stdoutTail.push(`${line}\n`);
					options.onRawStdoutLine?.(line);
					return;
				}
				try {
					options.onEvent?.(event, controls);
				} catch (error) {
					spawnError = error instanceof Error ? error.message : String(error);
					terminate("protocol", "SIGTERM");
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					turnCount++;
					if (options.turnBudget) {
						const terminal = terminalAssistantStop(event);
						const toolWork = assistantStartsToolCall(event);
						const decision = turnBudgetDecision(options.turnBudget, turnCount, terminal, toolWork, options.enforceHardTurnLimit);
						turnBudget = turnBudgetState(options.turnBudget, turnCount, decision === "abort");
						const message = decision === "abort" ? turnBudgetExceededMessage(options.turnBudget, turnCount) : undefined;
						options.onTurnBudget?.(turnBudget, message);
						if (decision === "abort") terminate("turn-budget");
					}
				}
				const lifecycle = projectChildLifecycle(event, terminalAssistantStop(event));
				if (lifecycle === "cancel-drain") {
					terminalSeen = false;
					clearDrainTimers();
				} else if (lifecycle === "start-drain") {
					terminalSeen = true;
					startFinalDrain();
				}
			},
		});
		const stderrReader = createBoundedLineReader({
			stream: "stderr",
			maxPendingLineBytes: options.maxStderrLineBytes ?? MAX_CHILD_STDERR_BYTES,
			onLine: (line) => options.onStderrLine?.(line),
			onLimit: (limit) => options.onStderrLine?.(formatProtocolOutputLimit(limit)),
		});
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		child.stdout?.on("data", (chunk: Buffer) => stdoutReader.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail.push(chunk);
			stderrReader.push(chunk);
			options.onStderrChunk?.(chunk);
		});
		options.onControls?.(controls);
		options.onSpawn?.(child);

		if (options.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => terminate("timeout"), Math.max(0, options.timeoutMs));
			timeoutTimer.unref?.();
		}
		if (options.signal) {
			const abort = () => terminate("cancel", options.cancelInitialSignal);
			if (options.signal.aborted) abort();
			else {
				options.signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
			}
		}

		const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			const reapProcessGroup = processGroup
				&& forcedTermination
				&& isChildProcessTreeAlive(child, { processGroup: true });
			settled = true;
			clearDrainTimers();
			if (reapProcessGroup) {
				termTimer = clearTimer(termTimer);
				killTimer = clearTimer(killTimer);
				const reaper = setTimeout(() => {
					if (isChildProcessTreeAlive(child, { processGroup: true })) signalChild("SIGKILL");
				}, hardKillMs);
				reaper.unref?.();
			} else {
				clearTerminationTimers();
			}
			timeoutTimer = clearTimer(timeoutTimer);
			removeAbortListener?.();
			clearStdioGuard();
			stdoutReader.end();
			stderrReader.end();
			resolve({
				exitCode,
				signal,
				stderr: stderrTail.text(),
				rawStdout: stdoutTail.text().trim(),
				protocolError,
				spawnError,
				terminationReason,
				forcedTermination,
				detached,
				terminalSeen,
				turnCount,
				turnBudget,
			});
		};
		child.on("exit", () => {
			exited = true;
			clearDrainTimers();
		});
		child.on("close", finish);
		child.on("error", (error) => {
			spawnError = error instanceof Error ? error.message : String(error);
			finish(1, null);
		});
	});
}
