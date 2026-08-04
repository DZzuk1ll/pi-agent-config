import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOL_BUDGET_BLOCK } from "../shared/tool-budget.ts";
import { readAsyncRecoveryDescriptor } from "./async-resume.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDescriptor(overrides: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recovery-test-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, "recovery-descriptor.json"), JSON.stringify({
		version: 1,
		sourceRunId: "run-1",
		agent: "worker",
		cwd: "/tmp/project",
		systemPromptMode: "append",
		outputMode: "inline",
		inheritProjectContext: false,
		inheritSkills: false,
		share: false,
		maxSubagentDepth: 1,
		...overrides,
	}));
	return dir;
}

describe("async recovery descriptor", () => {
	it("normalizes persisted budget defaults before returning domain values", () => {
		const descriptor = readAsyncRecoveryDescriptor(writeDescriptor({
			initialTurnBudget: { maxTurns: 2 },
			initialToolBudget: { hard: 3 },
		}));

		expect(descriptor?.initialTurnBudget).toEqual({ maxTurns: 2, graceTurns: 1 });
		expect(descriptor?.initialToolBudget).toEqual({ hard: 3, block: [...DEFAULT_TOOL_BUDGET_BLOCK] });
	});

	it("rejects malformed persisted budgets", () => {
		expect(() => readAsyncRecoveryDescriptor(writeDescriptor({ initialTurnBudget: { maxTurns: 0 } })))
			.toThrow(/initialTurnBudget\.maxTurns/);
		expect(() => readAsyncRecoveryDescriptor(writeDescriptor({ initialToolBudget: { hard: 1, block: [] } })))
			.toThrow(/initialToolBudget\.block/);
	});

	it("rejects invalid artifact directories and unknown nested fields", () => {
		const artifactConfig = {
			enabled: true,
			includeInput: true,
			includeOutput: true,
			includeJsonl: true,
			includeMetadata: true,
			cleanupDays: 1,
		};
		expect(() => readAsyncRecoveryDescriptor(writeDescriptor({
			artifactConfig: { ...artifactConfig, dir: "bad" },
		}))).toThrow(/artifactConfig\.dir/);
		expect(() => readAsyncRecoveryDescriptor(writeDescriptor({
			artifactConfig: { ...artifactConfig, unexpected: true },
		}))).toThrow(/unexpected is not supported/);
	});
});
