import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerSubagents from "./src/extension/index.ts";

type DelegatedTask = { agent?: unknown };
type DelegationInput = {
	tasks?: unknown;
	chain?: unknown;
};

function mixesExploreAndPlan(tasks: unknown): boolean {
	if (!Array.isArray(tasks)) return false;
	const agents = new Set(
		tasks
			.filter((task): task is DelegatedTask => typeof task === "object" && task !== null)
			.map((task) => task.agent),
	);
	return agents.has("Explore") && agents.has("Plan");
}

export function hasParallelExplorePlan(input: unknown): boolean {
	if (typeof input !== "object" || input === null) return false;
	const delegation = input as DelegationInput;
	if (mixesExploreAndPlan(delegation.tasks)) return true;
	if (!Array.isArray(delegation.chain)) return false;
	return delegation.chain.some(
		(step) =>
			typeof step === "object"
			&& step !== null
			&& mixesExploreAndPlan((step as { parallel?: unknown }).parallel),
	);
}

export default function subagents(pi: ExtensionAPI): void {
	registerSubagents(pi);
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent" || !hasParallelExplorePlan(event.input)) return;
		return {
			block: true,
			reason:
				"Explore and Plan must not run in the same parallel group. "
				+ "Retry with non-overlapping Explore tasks; use Plan only later if the user explicitly requested a standalone implementation plan.",
		};
	});
}
