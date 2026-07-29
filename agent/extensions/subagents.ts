import {
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import registerSubagents from "../npm/node_modules/pi-subagents/index.ts";
import { SubagentFleetStatus } from "../npm/node_modules/pi-subagents/src/tui/fleet-status.ts";

type FleetPrototype = {
	editorHasFocus(): boolean;
	tui?: { focusedComponent?: unknown };
};

type AppEditor = {
	actionHandlers?: unknown;
	getText?: unknown;
	handleInput?: unknown;
	onAction?: unknown;
};

const prototype = SubagentFleetStatus.prototype as unknown as FleetPrototype;
const editorHasFocus = prototype.editorHasFocus;

// This wrapper shares pi-subagents' module root, unlike a separately loaded patch extension.
prototype.editorHasFocus = function (): boolean {
	const focused = this.tui?.focusedComponent as AppEditor | undefined;
	return editorHasFocus.call(this)
		|| focused instanceof CustomEditor
		|| (
			focused?.actionHandlers instanceof Map
			&& typeof focused.getText === "function"
			&& typeof focused.handleInput === "function"
			&& typeof focused.onAction === "function"
		);
};

export default function subagents(pi: ExtensionAPI): void {
	registerSubagents(pi);
}
