import { describe, expect, it } from "vitest";
import type { TaskDetails } from "../tool/types.js";
import { isTaskDetails, replayFromBranch } from "./replay.js";

function details(overrides: Partial<TaskDetails> = {}): TaskDetails {
	return {
		action: "list",
		params: {},
		tasks: [{ id: 1, subject: "Valid", status: "pending" }],
		nextId: 2,
		...overrides,
	};
}

function entry(snapshot: unknown): unknown {
	return { type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot } };
}

describe("todo replay validation", () => {
	it("rejects malformed ids, subjects, references, cycles, and multiple active tasks", () => {
		expect(isTaskDetails(details({ nextId: 1 }))).toBe(false);
		expect(isTaskDetails(details({ tasks: [{ id: 1, subject: " ", status: "pending" }] }))).toBe(false);
		expect(isTaskDetails(details({ tasks: [{ id: 1, subject: "A", status: "pending", blockedBy: [2] }] }))).toBe(false);
		expect(isTaskDetails(details({
			tasks: [
				{ id: 1, subject: "A", status: "pending", blockedBy: [2] },
				{ id: 2, subject: "B", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		}))).toBe(false);
		expect(isTaskDetails(details({
			tasks: [
				{ id: 1, subject: "A", status: "in_progress" },
				{ id: 2, subject: "B", status: "in_progress" },
			],
			nextId: 3,
		}))).toBe(false);
		expect(isTaskDetails(details({
			tasks: [
				{ id: 1, subject: "Deleted", status: "deleted" },
				{ id: 2, subject: "B", status: "pending", blockedBy: [1, 1] },
			],
			nextId: 3,
		}))).toBe(false);
	});

	it("falls back to the most recent older valid snapshot", () => {
		const valid = details();
		const replayed = replayFromBranch({
			sessionManager: { getBranch: () => [entry(valid), entry({ ...valid, nextId: 1 })] },
		});
		expect(replayed).toEqual({ tasks: valid.tasks, nextId: 2 });
		expect(replayed.tasks).not.toBe(valid.tasks);
	});

	it("accepts legacy valid snapshots with optional fields omitted", () => {
		expect(isTaskDetails(details())).toBe(true);
	});
});
