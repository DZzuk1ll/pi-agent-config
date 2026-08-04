import { describe, expect, it } from "vitest";
import { decodeSubagentRunConfig } from "./runner-config-schema.ts";

const baseConfig = {
	id: "run-1",
	steps: [{
		agent: "worker",
		task: "work",
		inheritProjectContext: false,
		inheritSkills: false,
	}],
	resultPath: "/tmp/result.json",
	cwd: "/tmp/project",
	placeholder: "{previous}",
	asyncDir: "/tmp/async/run-1",
};

describe("runner config schema", () => {
	it("accepts a minimal runner config", () => {
		expect(decodeSubagentRunConfig(baseConfig, "test")).toMatchObject(baseConfig);
	});

	it("rejects malformed nested budgets and workflow graphs", () => {
		expect(() => decodeSubagentRunConfig({ ...baseConfig, turnBudget: { maxTurns: 1 } }, "test"))
			.toThrow(/turnBudget/);
		expect(() => decodeSubagentRunConfig({ ...baseConfig, toolBudget: { hard: 1 } }, "test"))
			.toThrow(/toolBudget/);
		expect(() => decodeSubagentRunConfig({ ...baseConfig, workflowGraph: {} }, "test"))
			.toThrow(/workflowGraph/);
	});

	it("rejects semantically invalid numeric limits and tool budgets", () => {
		for (const invalid of [
			{ turnBudget: { maxTurns: -1, graceTurns: -1 } },
			{ toolBudget: { hard: -1, block: [] } },
			{ maxOutput: { bytes: -1 } },
			{ timeoutMs: -1 },
		]) {
			expect(() => decodeSubagentRunConfig({ ...baseConfig, ...invalid }, "test")).toThrow(/Invalid|runnerConfig/);
		}
		expect(() => decodeSubagentRunConfig({
			...baseConfig,
			steps: [{ ...baseConfig.steps[0], toolBudget: { hard: 1, soft: 2, block: ["read"] } }],
		}, "test")).toThrow(/soft/);
	});

	it("applies acceptance semantic validation to nested steps and groups", () => {
		expect(() => decodeSubagentRunConfig({
			...baseConfig,
			steps: [{ ...baseConfig.steps[0], acceptanceInput: { level: "none" } }],
		}, "test")).toThrow(/reason is required/);
		expect(() => decodeSubagentRunConfig({
			...baseConfig,
			steps: [{
				parallel: [{
					...baseConfig.steps[0],
					acceptanceInput: { level: "none" },
				}],
			}],
		}, "test")).toThrow(/reason is required/);
		expect(() => decodeSubagentRunConfig({
			...baseConfig,
			steps: [{ ...baseConfig.steps[0], acceptanceInput: { verify: [{ id: "", command: "", timeoutMs: 0 }] } }],
		}, "test")).toThrow();
	});

	it("rejects malformed step options", () => {
		expect(() => decodeSubagentRunConfig({
			...baseConfig,
			steps: [{ ...baseConfig.steps[0], tools: "read" }],
		}, "test")).toThrow(/steps/);
	});

	it("normalizes JSON null placeholders used for sparse child and dynamic arrays", () => {
		const decoded = decodeSubagentRunConfig({
			...baseConfig,
			childIntercomTargets: [null, "child-2"],
			steps: [{
				expand: { from: { output: "items", path: "/items" } },
				parallel: baseConfig.steps[0],
				collect: { as: "items" },
				sessionFiles: [null, "/tmp/session.jsonl"],
				thinkingOverrides: [null, false, "high"],
			}],
		}, "test");

		expect(decoded.childIntercomTargets).toEqual([undefined, "child-2"]);
		const [step] = decoded.steps;
		expect(step && "expand" in step ? step.sessionFiles : undefined).toEqual([undefined, "/tmp/session.jsonl"]);
		expect(step && "expand" in step ? step.thinkingOverrides : undefined).toEqual([undefined, false, "high"]);
	});

	it("preserves zero as a valid disabled dynamic fanout limit", () => {
		const decoded = decodeSubagentRunConfig({
			...baseConfig,
			dynamicFanoutMaxItems: 0,
			workflowGraph: {
				runId: "run-1",
				mode: "chain",
				phases: [{ title: "fanout", nodeIds: ["step-0"] }],
				nodes: [{
					id: "step-0",
					kind: "dynamic-parallel-group",
					label: "fanout",
					status: "pending",
					dynamic: { sourceOutput: "items", sourcePath: "/items", itemName: "item", maxItems: 0 },
				}],
			},
			steps: [{
				expand: { from: { output: "items", path: "/items" }, maxItems: 0 },
				parallel: baseConfig.steps[0],
				collect: { as: "items" },
			}],
		}, "test");
		expect(decoded.dynamicFanoutMaxItems).toBe(0);
		expect(decoded.workflowGraph?.nodes[0]?.dynamic?.maxItems).toBe(0);
		const [step] = decoded.steps;
		expect(step && "expand" in step ? step.expand.maxItems : undefined).toBe(0);
	});

	it("accepts all acceptance verification command fields", () => {
		const config = {
			...baseConfig,
			steps: [{
				...baseConfig.steps[0],
				acceptanceInput: {
					verify: [{
						id: "test",
						command: "npm test",
						timeoutMs: 1_000,
						cwd: "/tmp/project",
						env: { CI: "1" },
						allowFailure: true,
					}],
				},
			}],
		};
		expect(decodeSubagentRunConfig(config, "test").steps).toHaveLength(1);
	});
});
