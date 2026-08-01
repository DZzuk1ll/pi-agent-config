import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeStringify, toSerializable } from "../_shared/runtime/artifacts.ts";
import { utf8ByteLength } from "../_shared/runtime/text.ts";
import type { AgentCallOptions, AgentCallResult, WorkflowThinking } from "./delegation.ts";

export const MAX_WORKFLOW_SOURCE_BYTES = 512 * 1024;
export const MAX_WORKFLOW_ARGS_BYTES = 256 * 1024;
export const MAX_WORKFLOW_AGENT_IPC_BYTES = 512 * 1024;
export const MAX_WORKFLOW_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_REQUESTS = 32;
const THINKING = new Set<WorkflowThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface SandboxOptions {
	source: string;
	args: unknown;
	cwd: string;
	signal: AbortSignal;
	onAgent: (prompt: string, options: AgentCallOptions, signal: AbortSignal) => Promise<AgentCallResult>;
	onPhase: (title: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stopChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try { child.kill("SIGTERM"); } catch {}
	const force = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			try { child.kill("SIGKILL"); } catch {}
		}
	}, 1_000);
	force.unref?.();
}

function sanitizeOptions(value: unknown): AgentCallOptions {
	if (!isRecord(value)) return {};
	const output: AgentCallOptions = {};
	if (typeof value.agent === "string" && value.agent.trim()) output.agent = value.agent.trim().slice(0, 128);
	if (typeof value.label === "string" && value.label.trim()) output.label = value.label.trim().slice(0, 160);
	if (typeof value.phase === "string" && value.phase.trim()) output.phase = value.phase.trim().slice(0, 160);
	if (typeof value.model === "string" && value.model.trim()) output.model = value.model.trim().slice(0, 256);
	if (typeof value.thinking === "string" && THINKING.has(value.thinking as WorkflowThinking)) output.thinking = value.thinking as WorkflowThinking;
	if (isRecord(value.schema)) output.schema = value.schema;
	return output;
}

export function runWorkflowSandbox(options: SandboxOptions): Promise<unknown> {
	if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
		return Promise.reject(new Error("This Node runtime cannot enforce workflow child permissions"));
	}
	if (utf8ByteLength(options.source) > MAX_WORKFLOW_SOURCE_BYTES) {
		return Promise.reject(new Error(`Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`));
	}
	let argsJson: string;
	try {
		argsJson = safeStringify({ defined: options.args !== undefined, value: options.args }, {
			maxBytes: MAX_WORKFLOW_ARGS_BYTES,
			maxDepth: 16,
			maxNodes: 10_000,
			maxStringBytes: 128 * 1024,
		});
	} catch (error) {
		return Promise.reject(new Error(`Workflow args are invalid: ${errorText(error)}`));
	}

	return new Promise<unknown>((resolve, reject) => {
		const workerPath = fileURLToPath(new URL("./sandbox-child.cjs", import.meta.url));
		const child = spawn(process.execPath, [
			"--permission",
			`--allow-fs-read=${workerPath}`,
			"--max-old-space-size=128",
			"--stack-size=2048",
			workerPath,
		], {
			cwd: options.cwd,
			env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			windowsHide: true,
		});
		const token = randomBytes(24).toString("hex");
		const seenIds = new Set<number>();
		const active = new Map<number, AbortController>();
		let requestCount = 0;
		let phaseCount = 0;
		let finished = false;

		const cleanup = () => {
			options.signal.removeEventListener("abort", onAbort);
			for (const controller of active.values()) controller.abort(new Error("Workflow sandbox stopped"));
			active.clear();
			child.removeAllListeners("message");
			child.removeAllListeners("error");
			child.removeAllListeners("exit");
			stopChild(child);
		};
		const finish = (error?: unknown, result?: unknown) => {
			if (finished) return;
			finished = true;
			cleanup();
			if (error) reject(error instanceof Error ? error : new Error(String(error)));
			else resolve(result);
		};
		const onAbort = () => finish(options.signal.reason instanceof Error ? options.signal.reason : new Error("Workflow aborted"));
		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) {
			onAbort();
			return;
		}

		child.once("error", (error) => finish(error));
		child.once("exit", (code, signal) => {
			if (!finished) finish(new Error(`Workflow sandbox exited before completion (${signal ?? code ?? "unknown"})`));
		});
		child.on("message", (raw: unknown) => {
			if (!isRecord(raw) || raw.token !== token || typeof raw.kind !== "string") {
				finish(new Error("Workflow sandbox sent an unauthenticated or malformed IPC message"));
				return;
			}
			if (raw.kind === "phase") {
				if (typeof raw.payloadJson !== "string" || utf8ByteLength(raw.payloadJson) > 4_096 || ++phaseCount > 64) {
					finish(new Error("Workflow sandbox sent an invalid phase update"));
					return;
				}
				try {
					const value = JSON.parse(raw.payloadJson);
					if (!isRecord(value) || typeof value.title !== "string") throw new Error("invalid phase");
					options.onPhase(value.title.slice(0, 160));
				} catch {
					finish(new Error("Workflow sandbox sent malformed phase JSON"));
				}
				return;
			}
			if (raw.kind === "agent") {
				if (typeof raw.payloadJson !== "string" || utf8ByteLength(raw.payloadJson) > MAX_WORKFLOW_AGENT_IPC_BYTES) {
					finish(new Error("Workflow sandbox sent an oversized agent request"));
					return;
				}
				let value: unknown;
				try { value = JSON.parse(raw.payloadJson); } catch {
					finish(new Error("Workflow sandbox sent malformed agent JSON"));
					return;
				}
				if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.id !== "number" || value.id < 1 || typeof value.prompt !== "string" || !isRecord(value.options)) {
					finish(new Error("Workflow sandbox sent an invalid agent request"));
					return;
				}
				if (seenIds.has(value.id) || ++requestCount > MAX_AGENT_REQUESTS) {
					finish(new Error("Workflow sandbox exceeded or reused its agent request budget"));
					return;
				}
				seenIds.add(value.id);
				const id = value.id;
				const controller = new AbortController();
				active.set(id, controller);
				void options.onAgent(value.prompt, sanitizeOptions(value.options), controller.signal).then((result) => {
					if (!active.delete(id) || finished || !child.connected) return;
					let resultJson: string;
					try {
						resultJson = safeStringify(result, {
							maxBytes: MAX_WORKFLOW_AGENT_IPC_BYTES,
							maxDepth: 16,
							maxNodes: 10_000,
							maxStringBytes: 256 * 1024,
						});
					} catch {
						resultJson = JSON.stringify({ ok: false, output: "", error: "Agent result exceeded the workflow IPC limit" });
					}
					child.send?.({ token, kind: "agentResult", id, resultJson }, (error) => {
						if (error) finish(error);
					});
				}).catch((error) => finish(error));
				return;
			}
			if (raw.kind === "result") {
				if (typeof raw.resultJson !== "string" || utf8ByteLength(raw.resultJson) > MAX_WORKFLOW_RESULT_BYTES) {
					finish(new Error("Workflow result exceeded the IPC limit"));
					return;
				}
				try {
					const normalized = toSerializable(JSON.parse(raw.resultJson), { maxBytes: MAX_WORKFLOW_RESULT_BYTES });
					finish(undefined, JSON.parse(JSON.stringify(normalized)));
				} catch (error) {
					finish(new Error(`Workflow returned invalid JSON: ${errorText(error)}`));
				}
				return;
			}
			if (raw.kind === "error" && typeof raw.error === "string") {
				finish(new Error(raw.error.slice(0, 16 * 1024)));
				return;
			}
			finish(new Error("Workflow sandbox sent an unknown IPC message"));
		});

		child.send?.({ kind: "init", token, source: options.source, argsJson }, (error) => {
			if (error) finish(error);
		});
	});
}
