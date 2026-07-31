import type { WorkflowAgentRecord, WorkflowDetails } from "./controller.ts";

export interface WorkflowDashboardEntry {
	runId: string;
	details: WorkflowDetails;
	live: boolean;
	stale: boolean;
}

export interface WorkflowPhaseGroup {
	title: string;
	agents: WorkflowAgentRecord[];
}

export function mergeWorkflowDashboardEntries(
	active: ReadonlyMap<string, WorkflowDetails>,
	history: readonly WorkflowDetails[],
	limit = 100,
): WorkflowDashboardEntry[] {
	const entries: WorkflowDashboardEntry[] = [];
	for (const details of active.values()) {
		entries.push({ runId: details.runId, details, live: true, stale: false });
	}
	for (const details of history) {
		if (active.has(details.runId)) continue;
		entries.push({
			runId: details.runId,
			details,
			live: false,
			stale: details.state === "running",
		});
	}
	return entries
		.sort((left, right) => right.details.startedAt - left.details.startedAt)
		.slice(0, Math.max(0, limit));
}

export function groupWorkflowAgents(details: WorkflowDetails): WorkflowPhaseGroup[] {
	const groups = new Map<string, WorkflowAgentRecord[]>();
	for (const phase of details.phases) {
		if (!groups.has(phase)) groups.set(phase, []);
	}
	for (const agent of details.agents) {
		const title = agent.phase?.trim() || "Unphased";
		const records = groups.get(title) ?? [];
		records.push(agent);
		groups.set(title, records);
	}
	return [...groups].map(([title, agents]) => ({ title, agents }));
}

export function moveWorkflowSelection(index: number, delta: number, length: number): number {
	if (length <= 0) return 0;
	return (index + delta + length) % length;
}

export function findWorkflowEntry(
	entries: readonly WorkflowDashboardEntry[],
	query: string | undefined,
): WorkflowDashboardEntry | undefined {
	const value = query?.trim();
	if (!value) return undefined;
	return entries.find((entry) => entry.runId === value)
		?? entries.find((entry) => entry.runId.endsWith(value));
}
