const FOCUS_STATE_KEY = Symbol.for("pi.agent.interactive-widget-focus.v1");

type FocusState = {
	owner: string | undefined;
};

function focusState(): FocusState {
	const globalRecord = globalThis as typeof globalThis & { [FOCUS_STATE_KEY]?: FocusState };
	const existing = globalRecord[FOCUS_STATE_KEY];
	if (existing) return existing;
	const created: FocusState = { owner: undefined };
	globalRecord[FOCUS_STATE_KEY] = created;
	return created;
}

export function claimInteractiveWidgetFocus(owner: string): boolean {
	const state = focusState();
	if (state.owner && state.owner !== owner) return false;
	state.owner = owner;
	return true;
}

export function releaseInteractiveWidgetFocus(owner: string): void {
	const state = focusState();
	if (state.owner === owner) state.owner = undefined;
}

export function interactiveWidgetFocusedByOther(owner: string): boolean {
	const current = focusState().owner;
	return current !== undefined && current !== owner;
}
