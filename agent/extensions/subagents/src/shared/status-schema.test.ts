import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAsyncRuns } from "../runs/background/async-status.ts";
import { readStatus } from "./utils.ts";

const roots: string[] = [];

function writeStatus(root: string, id: string, value: unknown): string {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(value));
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async status runtime validation", () => {
	it("reports the source path for malformed steps and missing required fields", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-schema-"));
		roots.push(root);
		const malformed = writeStatus(root, "bad-steps", {
			runId: "bad-steps",
			mode: "chain",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "worker", status: 42 }],
		});
		expect(() => readStatus(malformed)).toThrow(/bad-steps\/status\.json.*steps\/0\/status/);

		const missing = writeStatus(root, "missing", { state: "running", startedAt: 1 });
		expect(() => readStatus(missing)).toThrow(/missing\/status\.json/);
	});

	it("rejects malformed known nested status projections", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-schema-"));
		roots.push(root);
		const invalidBudget = writeStatus(root, "bad-budget", {
			runId: "bad-budget", mode: "single", state: "running", startedAt: 1,
			steps: [{
				agent: "worker", status: "running",
				turnBudget: { maxTurns: "ten", graceTurns: 1, outcome: "within-budget", turnCount: 1 },
			}],
		});
		expect(() => readStatus(invalidBudget)).toThrow(/steps\/0\/turnBudget\/maxTurns/);

		const invalidChild = writeStatus(root, "bad-child", {
			runId: "bad-child", mode: "single", state: "running", startedAt: 1,
			steps: [{
				agent: "worker", status: "running",
				children: [{
					id: "child", parentRunId: "bad-child", depth: 1, path: [], state: "running",
					totalTokens: { input: 1, output: 2, total: "three" },
				}],
			}],
		});
		expect(() => readStatus(invalidChild)).toThrow(/children\/0\/totalTokens\/total/);

		const invalidGraph = writeStatus(root, "bad-graph", {
			runId: "bad-graph", mode: "chain", state: "running", startedAt: 1,
			workflowGraph: {
				runId: "bad-graph", mode: "chain", phases: [],
				nodes: [{ id: "step-0", kind: "step", label: "step", status: "unknown" }],
			},
		});
		expect(() => readStatus(invalidGraph)).toThrow(/workflowGraph\/nodes\/0\/status/);
	});

	it("accepts an older valid snapshot and isolates a corrupt run during fleet scans", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-schema-"));
		roots.push(root);
		const valid = writeStatus(root, "valid", {
			runId: "valid",
			mode: "single",
			state: "complete",
			startedAt: 1,
			steps: [{ agent: "worker", status: "completed" }],
		});
		writeStatus(root, "corrupt", { runId: "corrupt", mode: "single", state: "complete", startedAt: 1, steps: {} });
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(readStatus(valid)?.runId).toBe("valid");
		expect(listAsyncRuns(root, { reconcile: false }).map((run) => run.id)).toEqual(["valid"]);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("corrupt"));
	});

	it("accepts every persisted acceptance verify command option", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-schema-"));
		roots.push(root);
		const statusDir = writeStatus(root, "acceptance", {
			runId: "acceptance",
			mode: "single",
			state: "complete",
			startedAt: 1,
			steps: [{
				agent: "worker",
				status: "completed",
				acceptance: {
					status: "pending",
					evidenceStatus: "pending",
					explicit: true,
					effectiveAcceptance: {
						level: "verified",
						explicit: true,
						inferredReason: [],
						criteria: [],
						evidence: [],
						verify: [{
							id: "check",
							command: "npm test",
							timeoutMs: 5_000,
							cwd: "/repo",
							env: { CI: "1" },
							allowFailure: false,
						}],
						stopRules: [],
					},
					inferredReason: [],
					criteria: [],
					runtimeChecks: [],
					verifyRuns: [],
				},
			}],
		});

		expect(readStatus(statusDir)?.steps?.[0]?.acceptance?.effectiveAcceptance.verify[0]).toMatchObject({
			timeoutMs: 5_000,
			cwd: "/repo",
			env: { CI: "1" },
			allowFailure: false,
		});
	});
});
