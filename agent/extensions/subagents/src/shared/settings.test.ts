import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../agents/agents.ts";
import { SubagentParams } from "../extension/schemas.ts";
import { Value } from "typebox/value";
import { injectSingleReadInstructions, resolveParallelBehaviors, resolveStepBehavior } from "./settings.ts";

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "",
		source: "project",
		filePath: "/tmp/worker.md",
		output: "default.md",
		defaultReads: ["default.txt"],
	};
}

describe("subagent behavior overrides", () => {
	it("uses true to inherit and false to disable output and reads", () => {
		const config = agent();
		expect(resolveStepBehavior(config, { output: true, reads: true })).toMatchObject({
			output: "default.md",
			reads: ["default.txt"],
		});
		expect(resolveStepBehavior(config, { output: false, reads: false })).toMatchObject({
			output: false,
			reads: false,
		});
		expect(resolveStepBehavior(config, { output: "explicit.md", reads: ["explicit.txt"] })).toMatchObject({
			output: "explicit.md",
			reads: ["explicit.txt"],
		});
	});

	it("applies the same semantics to parallel behavior", () => {
		expect(resolveParallelBehaviors([
			{ agent: "worker", output: true, reads: true },
			{ agent: "worker", output: false, reads: false },
			{ agent: "worker", output: "explicit.md", reads: ["explicit.txt"] },
		], [agent()], 2)).toMatchObject([
			{ output: "parallel-2/0-worker/default.md", reads: ["default.txt"] },
			{ output: false, reads: false },
			{ output: "parallel-2/2-worker/explicit.md", reads: ["explicit.txt"] },
		]);
	});

	it("injects single-run reads for inherited, disabled, and explicit overrides", () => {
		expect(injectSingleReadInstructions("work", agent(), true, "/repo")).toBe("[Read from: /repo/default.txt]\n\nwork");
		expect(injectSingleReadInstructions("work", agent(), false, "/repo")).toBe("work");
		expect(injectSingleReadInstructions("work", agent(), ["explicit.txt"], "/repo")).toBe("[Read from: /repo/explicit.txt]\n\nwork");
	});

	it("accepts inherit, disable, and explicit overrides in every execution schema", () => {
		const overrides = [
			{ output: true, reads: true },
			{ output: false, reads: false },
			{ output: "explicit.md", reads: ["explicit.txt"] },
		] as const;
		for (const override of overrides) {
			const inputs = [
				{ agent: "worker", task: "single", ...override },
				{ chain: [{ agent: "worker", task: "chain", ...override }] },
				{ tasks: [{ agent: "worker", task: "parallel", ...override }] },
				{ chain: [
					{ agent: "worker", task: "seed", as: "items", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "items", path: "/items" }, maxItems: 2 },
						parallel: { agent: "worker", ...override },
						collect: { as: "results" },
					},
				] },
			];
			for (const input of inputs) expect(Value.Check(SubagentParams, input)).toBe(true);
		}
	});

	it("rejects unknown top-level execution fields", () => {
		expect(Value.Check(SubagentParams, { agent: "worker", task: "single", readz: true })).toBe(false);
	});
});
