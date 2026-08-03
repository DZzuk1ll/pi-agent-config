import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, loadJsonConfig, saveJsonConfig, validateGuidanceFields } from "./index.ts";

const originalXdg = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("personal config", () => {
	it("loads and saves XDG JSON without changing legacy paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "personal-pi-config-"));
		dirs.push(dir);
		process.env.XDG_CONFIG_HOME = dir;
		const path = configPath("rpiv-todo");
		expect(path).toBe(join(dir, "rpiv-todo", "config.json"));
		expect(saveJsonConfig(path, { value: 1 })).toBe(true);
		expect(loadJsonConfig<{ value: number }>(path)).toEqual({ value: 1 });
		expect(readFileSync(path, "utf8")).toBe('{\n  "value": 1\n}\n');
	});

	it("fails soft for invalid JSON and validates guidance", () => {
		const dir = mkdtempSync(join(tmpdir(), "personal-pi-config-"));
		dirs.push(dir);
		const path = join(dir, "broken.json");
		writeFileSync(path, "{");
		expect(loadJsonConfig(path)).toEqual({});
		expect(validateGuidanceFields({ promptSnippet: "Todo", promptGuidelines: ["One"] })).toEqual({ promptSnippet: "Todo", promptGuidelines: ["One"] });
		expect(validateGuidanceFields({ promptSnippet: "", promptGuidelines: [] })).toEqual({});
	});
});
