import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundToolText, sanitizeForDisplay } from "../shared/text.ts";
import { settleWithin } from "../shared/lifecycle.ts";
import { WorkflowArtifacts, aggregateUsage, loadWorkflowHistory, prepareWorkflowStorage } from "./artifacts.ts";
import { WorkflowAdmission, WorkflowController, WORKFLOW_SHUTDOWN_MS, type WorkflowDetails } from "./controller.ts";
import { DelegationClient } from "./delegation.ts";
import { runWorkflowSandbox } from "./sandbox.ts";

const WIDGET_KEY = "workflows";
const MAX_ACTIVE_WORKFLOWS = 4;

interface ActiveWorkflow {
	controller: WorkflowController;
	artifacts: WorkflowArtifacts;
	completion: Promise<void>;
}

function elapsed(details: WorkflowDetails): string {
	const milliseconds = (details.endedAt ?? Date.now()) - details.startedAt;
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function counts(details: WorkflowDetails): { done: number; failed: number; active: number } {
	let done = 0;
	let failed = 0;
	let active = 0;
	for (const agent of details.agents) {
		if (agent.state === "done") done++;
		else if (agent.state === "failed" || agent.state === "aborted") failed++;
		else active++;
	}
	return { done, failed, active };
}

function summaryLine(details: WorkflowDetails): string {
	const count = counts(details);
	const phase = details.currentPhase ? ` phase=${sanitizeForDisplay(details.currentPhase)}` : "";
	return `${details.runId} ${details.state} ${count.done}/${details.agents.length} done ${count.failed} failed ${elapsed(details)}${phase} — ${sanitizeForDisplay(details.name)}`;
}

function resultText(details: WorkflowDetails, directory: string): string {
	const usage = aggregateUsage(details);
	const sections = [
		summaryLine(details),
		`artifacts: ${directory}`,
		`usage: ${usage.input + usage.cacheRead + usage.cacheWrite} input · ${usage.output} output · $${usage.cost.toFixed(4)}`,
		...(details.error ? [`error: ${sanitizeForDisplay(details.error)}`] : []),
		...(details.result !== undefined ? ["", "result:", sanitizeForDisplay(JSON.stringify(details.result, null, 2))] : []),
	];
	return boundToolText(sections.join("\n"), { fullOutputPath: `${directory}/result.json` }).text;
}

export default function workflows(pi: ExtensionAPI): void {
	const active = new Map<string, ActiveWorkflow>();
	const workflowAdmission = new WorkflowAdmission(MAX_ACTIVE_WORKFLOWS);
	let ui: { setWidget: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void; notify: (message: string, level?: "info" | "warning" | "error") => void } | undefined;
	let shuttingDown = false;

	const updateWidget = () => {
		if (!ui) return;
		const runs = [...active.values()].map((item) => item.controller.details);
		if (runs.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const latest = runs.sort((a, b) => b.startedAt - a.startedAt)[0];
		const count = counts(latest);
		ui.setWidget(WIDGET_KEY, [`WF ${runs.length}  ${latest.runId} ${count.done}/${latest.agents.length} ${latest.currentPhase ? `· ${sanitizeForDisplay(latest.currentPhase)}` : ""}`], {
			placement: "belowEditor",
		});
	};

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		ui = ctx.ui;
		prepareWorkflowStorage();
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		ui?.setWidget(WIDGET_KEY, undefined);
		ui = undefined;
		const runs = [...active.values()];
		for (const run of runs) run.controller.abort("Pi session is shutting down");
		await settleWithin(Promise.allSettled(runs.map((run) => run.completion)).then(() => undefined), WORKFLOW_SHUTDOWN_MS);
		for (const run of runs) run.artifacts.dispose();
		active.clear();
		workflowAdmission.reset();
		try { prepareWorkflowStorage(); } catch {}
	});

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: "Run an explicitly requested multi-stage, fan-out/fan-in workflow in a permission-restricted JavaScript sandbox. The script may only call agent(), parallel(), phase(), and read args.",
		promptSnippet: "Orchestrate bounded subagents with a sandboxed workflow DSL",
		promptGuidelines: [
			"Use workflow only when the user explicitly asks for one or the task genuinely needs multiple dependent or parallel agents.",
			"Keep scripts small, await every agent() call, label phases, handle ok:false results, and stay within 32 calls and concurrency 4.",
			"Do not use workflow for a task the parent can complete directly with ordinary tools or one subagent call.",
		],
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 160 }),
			description: Type.Optional(Type.String({ maxLength: 2_000 })),
			script: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
			argsJson: Type.Optional(Type.String({ maxLength: 256 * 1024, description: "Valid JSON exposed to the script as immutable args" })),
			background: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (shuttingDown) throw new Error("Workflow runtime is shutting down");
			let args: unknown;
			if (params.argsJson !== undefined) {
				try { args = JSON.parse(params.argsJson); } catch (error) {
					throw new Error(`argsJson must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const releaseAdmission = workflowAdmission.acquire();
			let artifacts: WorkflowArtifacts | undefined;
			try {
				const runId = `wf_${randomBytes(6).toString("hex")}`;
				const background = (params.background ?? false) && ctx.hasUI;
				let controller!: WorkflowController;
				artifacts = new WorkflowArtifacts(runId, params.script, params.argsJson, (error) => {
					if (controller) controller.abort(`Workflow artifact persistence failed: ${error.message}`);
				});
				const delegation = new DelegationClient(pi.events, ctx.cwd);
				let emitTimer: ReturnType<typeof setTimeout> | undefined;
				let lastEventSignature = "";
				const onChange = () => {
					artifacts!.checkpoint(controller.details);
					const signature = JSON.stringify({
						state: controller.details.state,
						phase: controller.details.currentPhase,
						agents: controller.details.agents.map((agent) => [agent.nodeId, agent.state]),
					});
					if (signature !== lastEventSignature) {
						lastEventSignature = signature;
						artifacts!.event("workflow.progress", JSON.parse(signature));
					}
					updateWidget();
					if (background || emitTimer) return;
					emitTimer = setTimeout(() => {
						emitTimer = undefined;
						try {
							onUpdate?.({
								content: [{ type: "text", text: summaryLine(controller.details) }],
								details: controller.details,
							});
						} catch {
							// A detached/stale tool renderer must not fail the workflow.
						}
					}, 200);
					emitTimer.unref?.();
				};
				controller = new WorkflowController({
					runId,
					sessionId: ctx.sessionManager.getSessionId(),
					name: params.name.trim(),
					description: params.description?.trim(),
					background,
					parentSignal: background ? undefined : signal,
					delegation,
					onChange,
				});
				artifacts.event("workflow.started", { name: controller.details.name, background });
				artifacts.checkpoint(controller.details, true);

				const runScript = async () => {
					let result: unknown;
					let failure: unknown;
					try {
						result = await runWorkflowSandbox({
							source: params.script,
							args,
							cwd: ctx.cwd,
							signal: controller.signal,
							onAgent: (prompt, options, invocationSignal) => controller.runAgent(prompt, options, invocationSignal),
							onPhase: (title) => controller.phase(title),
						});
					} catch (error) {
						failure = error;
					}
					await controller.finalize(failure ? { error: failure } : { result });
					if (emitTimer) clearTimeout(emitTimer);
					emitTimer = undefined;
					try {
						artifacts!.finish(controller.details);
					} catch (error) {
						controller.details.state = "failed";
						controller.details.error = `Workflow artifact persistence failed: ${error instanceof Error ? error.message : String(error)}`;
						artifacts!.dispose();
					}
				};

				const completion = runScript();
				active.set(runId, { controller, artifacts, completion });
				updateWidget();
				if (background) {
					void completion.finally(() => {
						active.delete(runId);
						releaseAdmission();
						artifacts!.dispose();
						try { prepareWorkflowStorage([...active.keys()]); } catch {}
						updateWidget();
						if (shuttingDown) return;
						try {
							pi.sendMessage(
								{
									customType: "workflow-result",
									content: resultText(controller.details, artifacts!.directory),
									display: true,
									details: { runId, state: controller.details.state },
								},
								{ deliverAs: "followUp", triggerTurn: true },
							);
						} catch {
							// The owning session may no longer exist.
						}
					}).catch(() => {});
					return {
						content: [{ type: "text", text: `Workflow ${runId} started in the background.\nArtifacts: ${artifacts.directory}\nCompletion will be delivered automatically.` }],
						details: controller.details,
					};
				}

				try {
					await completion;
				} finally {
					active.delete(runId);
					releaseAdmission();
					artifacts.dispose();
					try { prepareWorkflowStorage([...active.keys()]); } catch {}
					updateWidget();
				}
				if (controller.details.state !== "completed") throw new Error(resultText(controller.details, artifacts.directory));
				return { content: [{ type: "text", text: resultText(controller.details, artifacts.directory) }], details: controller.details };
			} catch (error) {
				releaseAdmission();
				artifacts?.dispose();
				try { prepareWorkflowStorage([...active.keys()]); } catch {}
				throw error;
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "Inspect and cancel workflow runs",
		handler: async (_args, ctx) => {
			const live = new Map([...active.values()].map((item) => [item.controller.details.runId, item]));
			const history = loadWorkflowHistory();
			const merged = [[...live.values()].map((item) => item.controller.details), history.filter((item) => !live.has(item.runId))].flat()
				.sort((a, b) => b.startedAt - a.startedAt)
				.slice(0, 100);
			if (merged.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No workflow runs.", "info");
				else pi.sendMessage({ customType: "workflow-list", content: "No workflow runs.", display: true }, { triggerTurn: false });
				return;
			}
			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "workflow-list",
					content: boundToolText(merged.map(summaryLine).join("\n")).text,
					display: true,
				}, { triggerTurn: false });
				return;
			}
			while (true) {
				const labels = merged.map(summaryLine);
				const choice = await ctx.ui.select("Workflow runs", [...labels, "Close"]);
				if (!choice || choice === "Close") return;
				const details = merged[labels.indexOf(choice)];
				if (!details) continue;
				const running = live.get(details.runId);
				const action = await ctx.ui.select(details.runId, ["View details", ...(running ? ["Cancel workflow"] : []), "Back"]);
				if (action === "View details") {
					ctx.ui.notify(resultText(running?.controller.details ?? details, running?.artifacts.directory ?? `${preparePath(details.runId)}`), "info");
				}
				if (action === "Cancel workflow") running?.controller.abort("Cancelled from /workflows");
			}
		},
	});
}

function preparePath(runId: string): string {
	const home = process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME ?? "~"}/.pi/agent`;
	return `${home}/workflows/${runId}`;
}
