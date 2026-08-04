import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPrototypePatch } from "./prototype-patch.ts";

class Target {
	value(): string {
		return "original";
	}
}

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
});

function layer(name: string, order: number) {
	const dispose = registerPrototypePatch(Target.prototype, "value", {
		name,
		order,
		wrap: (next) => function (this: Target) {
			return `${name}(${next.call(this)})`;
		},
	});
	disposers.push(dispose);
}

describe("prototype patch registry", () => {
	it("uses stable order regardless of reverse registration", () => {
		layer("outer", 200);
		layer("inner", 100);
		expect(new Target().value()).toBe("outer(inner(original))");
	});

	it("replaces a named layer on reload without nesting it", () => {
		const stale = registerPrototypePatch(Target.prototype, "value", {
			name: "reload",
			wrap: (next) => function (this: Target) { return `old(${next.call(this)})`; },
		});
		disposers.push(stale);
		const latest = registerPrototypePatch(Target.prototype, "value", {
			name: "reload",
			wrap: (next) => function (this: Target) { return `new(${next.call(this)})`; },
		});
		disposers.push(latest);
		expect(new Target().value()).toBe("new(original)");
		stale();
		expect(new Target().value()).toBe("new(original)");
	});

	it("restores the original only after the final layer is removed", () => {
		const first = registerPrototypePatch(Target.prototype, "value", { name: "a", wrap: (next) => function (this: Target) { return `a(${next.call(this)})`; } });
		const second = registerPrototypePatch(Target.prototype, "value", { name: "b", wrap: (next) => function (this: Target) { return `b(${next.call(this)})`; } });
		first();
		expect(new Target().value()).toBe("b(original)");
		second();
		expect(new Target().value()).toBe("original");
	});

	it("warns once and skips a missing host method", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerPrototypePatch(Target.prototype, "missing", { name: "one", override() {} });
		registerPrototypePatch(Target.prototype, "missing", { name: "two", override() {} });
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
