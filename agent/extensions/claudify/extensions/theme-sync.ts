export type ThemeOverrideTarget = object;

export type ThemeOverrideApplier = (theme: ThemeOverrideTarget) => void;

export type ThemeOverrideSyncSnapshot = {
	enabled: boolean;
	revision: number;
};

type ThemeOverrideSyncState = ThemeOverrideSyncSnapshot & {
	owner: symbol | undefined;
	theme: ThemeOverrideTarget | undefined;
	apply: ThemeOverrideApplier | undefined;
	identity: object | undefined;
};

const THEME_OVERRIDE_SYNC_STATE = Symbol.for("pi-claudify:theme-override-sync-state");

function syncState(): ThemeOverrideSyncState {
	const globalRecord = globalThis as Record<PropertyKey, unknown>;
	const existing = globalRecord[THEME_OVERRIDE_SYNC_STATE];
	if (existing && typeof existing === "object") return existing as ThemeOverrideSyncState;
	const created: ThemeOverrideSyncState = {
		enabled: false,
		revision: 0,
		owner: undefined,
		theme: undefined,
		apply: undefined,
		identity: undefined,
	};
	globalRecord[THEME_OVERRIDE_SYNC_STATE] = created;
	return created;
}

export function themeOverrideIdentity(theme: ThemeOverrideTarget | undefined): object | undefined {
	if (!theme) return undefined;
	const colors = theme as { bgColors?: unknown; fgColors?: unknown };
	if (colors.bgColors && typeof colors.bgColors === "object") return colors.bgColors as object;
	if (colors.fgColors && typeof colors.fgColors === "object") return colors.fgColors as object;
	return theme;
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
