export type ThemeOverrideTarget = {
	bgColors?: unknown;
	fgColors?: unknown;
};

export type ThemeOverrideApplier = (theme: ThemeOverrideTarget) => void;

export type ThemeOverrideSyncSnapshot = {
	enabled: boolean;
	revision: number;
};

type ThemeOverrideSyncState = ThemeOverrideSyncSnapshot & {
	owner?: symbol;
	theme?: ThemeOverrideTarget;
	apply?: ThemeOverrideApplier;
	identity?: object;
};

const THEME_OVERRIDE_SYNC_STATE = Symbol.for("pi-claudify:theme-override-sync-state");

function syncState(): ThemeOverrideSyncState {
	const globalRecord = globalThis as Record<PropertyKey, unknown>;
	const existing = globalRecord[THEME_OVERRIDE_SYNC_STATE];
	if (existing && typeof existing === "object") return existing as ThemeOverrideSyncState;
	const created: ThemeOverrideSyncState = { enabled: false, revision: 0 };
	globalRecord[THEME_OVERRIDE_SYNC_STATE] = created;
	return created;
}

export function themeOverrideIdentity(theme: ThemeOverrideTarget | undefined): object | undefined {
	if (!theme) return undefined;
	if (theme.bgColors && typeof theme.bgColors === "object") return theme.bgColors as object;
	if (theme.fgColors && typeof theme.fgColors === "object") return theme.fgColors as object;
	return typeof theme === "object" ? theme : undefined;
}

export function ensureThemeOverrides(): ThemeOverrideSyncSnapshot {
	const state = syncState();
	if (!state.enabled || !state.theme || !state.apply) {
		return { enabled: false, revision: state.revision };
	}
	const identity = themeOverrideIdentity(state.theme);
	if (identity && identity === state.identity) {
		return { enabled: true, revision: state.revision };
	}
	try {
		state.apply(state.theme);
		state.identity = identity;
		state.revision++;
	} catch {
		// Leave identity unset so a later frame can retry without taking down the TUI.
		state.identity = undefined;
	}
	return { enabled: true, revision: state.revision };
}

export function activateThemeOverrides(
	owner: symbol,
	theme: ThemeOverrideTarget,
	apply: ThemeOverrideApplier,
): ThemeOverrideSyncSnapshot {
	const state = syncState();
	state.owner = owner;
	state.theme = theme;
	state.apply = apply;
	state.enabled = true;
	state.identity = undefined;
	return ensureThemeOverrides();
}

export function invalidateThemeOverrides(owner: symbol): ThemeOverrideSyncSnapshot {
	const state = syncState();
	if (state.owner !== owner) return { enabled: state.enabled, revision: state.revision };
	state.identity = undefined;
	return ensureThemeOverrides();
}

export function deactivateThemeOverrides(owner: symbol): ThemeOverrideSyncSnapshot {
	const state = syncState();
	if (state.owner !== owner) return { enabled: state.enabled, revision: state.revision };
	state.enabled = false;
	state.owner = undefined;
	state.theme = undefined;
	state.apply = undefined;
	state.identity = undefined;
	state.revision++;
	return { enabled: false, revision: state.revision };
}
