import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerSubagents from "../npm/node_modules/pi-subagents/src/extension/index.ts";
import { SubagentFleetStatus } from "../npm/node_modules/pi-subagents/src/tui/fleet-status.ts";

const FOCUS_FIX = Symbol.for("pi-subagents:fleet-editor-focus-fix");

type EditorLike = {
	getText?: unknown;
	handleInput?: unknown;
	setText?: unknown;
};

type FleetPrototype = {
	editorHasFocus(): boolean;
	tui?: { focusedComponent?: EditorLike };
	[FOCUS_FIX]?: boolean;
};

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

const fleetPrototype = SubagentFleetStatus.prototype as unknown as FleetPrototype;

if (!fleetPrototype[FOCUS_FIX]) {
	const editorHasFocus = fleetPrototype.editorHasFocus;
	fleetPrototype.editorHasFocus = function (): boolean {
		if (editorHasFocus.call(this)) return true;

		const focused = this.tui?.focusedComponent;
		return (
			typeof focused?.getText === "function"
			&& typeof focused.handleInput === "function"
			&& typeof focused.setText === "function"
		);
	};
	fleetPrototype[FOCUS_FIX] = true;
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
