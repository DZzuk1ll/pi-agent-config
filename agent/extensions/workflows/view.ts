import { boundToolText, sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { aggregateUsage } from "./artifacts.ts";
import type { WorkflowDetails } from "./controller.ts";

export interface WorkflowTheme {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

export interface WorkflowToolArgs {
	name: string;
	description?: string;
	background?: boolean;
}

export interface WorkflowRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

function elapsed(details: Pick<WorkflowDetails, "startedAt" | "endedAt">): string {
	const milliseconds = Math.max(0, (details.endedAt ?? Date.now()) - details.startedAt);
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function counts(details: WorkflowDetails): { done: number; failed: number } {
	let done = 0;
	let failed = 0;
	for (const agent of details.agents) {
		if (agent.state === "done") done++;
		else if (agent.state === "failed" || agent.state === "aborted") failed++;
	}
	return { done, failed };
}

function inlineText(value: unknown, maxLength = 160): string {
	const clean = sanitizeForDisplay(String(value ?? "")).replace(/\s+/g, " ").trim();
	return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function previewText(value: unknown, maxLength = 400): string {
	const clean = sanitizeForDisplay(String(value ?? ""))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 2)
		.join(" · ");
	return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isWorkflowDetails(value: unknown): value is WorkflowDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.runId === "string"
		&& typeof record.name === "string"
		&& (record.state === "running" || record.state === "completed" || record.state === "failed" || record.state === "aborted")
		&& Number.isFinite(record.startedAt)
		&& Array.isArray(record.agents);
}

function stateMarker(state: string, theme: WorkflowTheme): string {
	if (state === "completed" || state === "done") return theme.fg("success", "■");
	if (state === "failed" || state === "aborted") return theme.fg("error", "■");
	if (state === "running") return theme.fg("warning", "◆");
	return theme.fg("dim", "□");
}

function safeResultPreview(value: unknown): string {
	try {
		return boundToolText(sanitizeForDisplay(JSON.stringify(value, null, 2)), { maxBytes: 4_000, maxLines: 40 }).text;
	} catch {
		return inlineText(value, 1_000);
	}
}

export function formatWorkflowCall(args: Partial<WorkflowToolArgs>, theme: WorkflowTheme): string {
	const name = inlineText(args.name || "(unnamed workflow)", 160);
	let text = theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", name);
	if (args.background) text += theme.fg("dim", " (background)");
	const description = inlineText(args.description, 240);
	if (description) text += `\n  ${theme.fg("dim", description)}`;
	return text;
}

export function formatWorkflowResult(
	result: WorkflowRenderResult,
	options: { expanded: boolean; isPartial?: boolean },
	theme: WorkflowTheme,
): string {
	if (!isWorkflowDetails(result.details)) {
		const first = result.content.find((part) => part.type === "text");
		return first?.text ?? "(no workflow output)";
	}
	const details = result.details;
	const count = counts(details);
	const settled = count.done + count.failed;
	const statusColor = details.state === "completed" ? "success" : details.state === "running" ? "warning" : "error";
	let text = `${stateMarker(details.state, theme)} ${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("accent", inlineText(details.name))}`;
	text += theme.fg("dim", ` ${settled}/${details.agents.length} agents · ${elapsed(details)} · `);
	text += theme.fg(statusColor, details.state);
	if (count.failed) text += theme.fg("error", ` · ${count.failed} failed`);
	if (details.background) text += theme.fg("dim", " (background)");
	if (details.currentPhase) text += theme.fg("muted", ` · ${inlineText(details.currentPhase)}`);

	const displayAgents = options.expanded ? details.agents : details.agents.slice(0, 6);
	let previousPhase: string | undefined;
	for (const agent of displayAgents) {
		if (options.expanded && agent.phase && agent.phase !== previousPhase) {
			previousPhase = agent.phase;
			text += `\n  ${theme.fg("muted", `── ${inlineText(agent.phase)} ──`)}`;
		}
		const runtime = agent.startedAt === undefined ? "" : ` · ${elapsed({ startedAt: agent.startedAt, endedAt: agent.endedAt })}`;
		const context = [
			inlineText(agent.agent),
			agent.model ? inlineText(agent.model) : undefined,
			agent.currentTool ? inlineText(agent.currentTool) : undefined,
			agent.toolCount !== undefined ? `${agent.toolCount} tools` : undefined,
			agent.tokens !== undefined ? `${agent.tokens} tokens` : undefined,
		].filter(Boolean).join(" · ");
		text += `\n  ${stateMarker(agent.state, theme)} ${theme.fg("accent", inlineText(agent.label))}${theme.fg("dim", ` · ${context}${runtime}`)}`;
		if (options.expanded) {
			const error = inlineText(agent.error, 500);
			const preview = previewText(agent.preview);
			if (error) text += `\n    ${theme.fg("error", error)}`;
			else if (preview) text += `\n    ${theme.fg("dim", preview)}`;
		}
	}
	if (!options.expanded && details.agents.length > displayAgents.length) {
		text += `\n  ${theme.fg("dim", `… ${details.agents.length - displayAgents.length} more agents`)}`;
	}
	const usage = aggregateUsage(details);
	if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) {
		text += `\n  ${theme.fg("dim", `Total: ${usage.input + usage.cacheRead + usage.cacheWrite} input · ${usage.output} output · $${usage.cost.toFixed(4)}`)}`;
	}
	if (details.error) text += `\n  ${theme.fg("error", `Error: ${inlineText(details.error, 1_000)}`)}`;
	if (options.expanded && details.result !== undefined) {
		text += `\n\n${theme.fg("muted", "── result ──")}\n${theme.fg("toolOutput", safeResultPreview(details.result))}`;
	}
	return text;
}
