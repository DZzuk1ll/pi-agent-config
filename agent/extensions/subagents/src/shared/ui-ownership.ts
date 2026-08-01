import type { ForegroundRunControl } from "./types.ts";

/**
 * Delegated children with an owning orchestrator are rendered by that owner's UI.
 * They remain available in the explicit fleet inspector and transcript APIs.
 */
export function isOwnedByOrchestratorUi(control: Pick<ForegroundRunControl, "uiOwnerRunId">): boolean {
	return Boolean(control.uiOwnerRunId);
}
