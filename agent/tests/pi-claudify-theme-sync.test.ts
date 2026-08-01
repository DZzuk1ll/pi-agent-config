import assert from "node:assert/strict";
import test from "node:test";

import {
	activateThemeOverrides,
	deactivateThemeOverrides,
	ensureThemeOverrides,
	invalidateThemeOverrides,
	type ThemeOverrideTarget,
} from "../extensions/claudify/extensions/theme-sync.ts";

function theme(background: string): ThemeOverrideTarget & { bgColors: Map<string, string> } {
	return { bgColors: new Map([["toolSuccessBg", background]]) };
}

test("theme overrides follow the live theme proxy across reload", () => {
	const first = theme("first");
	const second = theme("second");
	let current = first;
	const proxy = new Proxy({} as ThemeOverrideTarget, {
		get(_target, property) {
			return current[property as keyof ThemeOverrideTarget];
		},
	});
	const owner = Symbol("reload-test");
	let applications = 0;
	const apply = (target: ThemeOverrideTarget) => {
		applications++;
		(target.bgColors as Map<string, string>).set("toolSuccessBg", "transparent");
	};

	const initial = activateThemeOverrides(owner, proxy, apply);
	assert.equal(initial.enabled, true);
	assert.equal(first.bgColors.get("toolSuccessBg"), "transparent");
	assert.equal(applications, 1);

	assert.equal(ensureThemeOverrides().revision, initial.revision);
	assert.equal(applications, 1, "the same Theme instance should not be reapplied every frame");

	current = second;
	const reloaded = ensureThemeOverrides();
	assert.ok(reloaded.revision > initial.revision);
	assert.equal(second.bgColors.get("toolSuccessBg"), "transparent");
	assert.equal(applications, 2);

	deactivateThemeOverrides(owner);
});

test("invalidating overrides advances the render-cache revision", () => {
	const target = theme("default");
	const owner = Symbol("invalidate-test");
	let applications = 0;
	const active = activateThemeOverrides(owner, target, () => {
		applications++;
	});

	const refreshed = invalidateThemeOverrides(owner);
	assert.ok(refreshed.revision > active.revision);
	assert.equal(applications, 2);

	const inactive = deactivateThemeOverrides(owner);
	assert.equal(inactive.enabled, false);
	assert.ok(inactive.revision > refreshed.revision);
	assert.equal(ensureThemeOverrides().enabled, false);
});

test("stale runtime owners cannot disable the active override", () => {
	const oldOwner = Symbol("old-runtime");
	const currentOwner = Symbol("current-runtime");
	activateThemeOverrides(oldOwner, theme("old"), () => {});
	const active = activateThemeOverrides(currentOwner, theme("current"), () => {});

	const staleShutdown = deactivateThemeOverrides(oldOwner);
	assert.equal(staleShutdown.enabled, true);
	assert.equal(staleShutdown.revision, active.revision);

	deactivateThemeOverrides(currentOwner);
});

test("failed applications retry on the next frame", () => {
	const owner = Symbol("retry-test");
	let attempts = 0;
	const previousRevision = ensureThemeOverrides().revision;
	const first = activateThemeOverrides(owner, theme("default"), () => {
		attempts++;
		throw new Error("transient failure");
	});
	assert.equal(first.revision, previousRevision);
	assert.equal(attempts, 1);

	ensureThemeOverrides();
	assert.equal(attempts, 2);
	deactivateThemeOverrides(owner);
});
