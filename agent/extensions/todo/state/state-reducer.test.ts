import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { applyTaskMutation } from "./state-reducer.js";
import type { TaskState } from "./state.js";

function state(tasks: Task[], nextId = Math.max(0, ...tasks.map((task) => task.id)) + 1): TaskState {
	return { tasks, nextId };
}

function message(result: ReturnType<typeof applyTaskMutation>): string | undefined {
	return result.op.kind === "error" ? result.op.message : undefined;
}

describe("todo reducer invariants", () => {
	it("enforces the strict forward status path", () => {
		const pending = state([{ id: 1, subject: "One", status: "pending" }]);
		expect(message(applyTaskMutation(pending, "update", { id: 1, status: "completed" }))).toContain("illegal transition");
		const started = applyTaskMutation(pending, "update", { id: 1, status: "in_progress", activeForm: "working" });
		expect(started.op.kind).toBe("update");
		expect(message(applyTaskMutation(started.state, "update", { id: 1, status: "pending" }))).toContain("illegal transition");
		expect(applyTaskMutation(started.state, "update", { id: 1, status: "completed" }).op.kind).toBe("update");
	});

	it("allows only one ready task in progress with a non-empty activeForm", () => {
		const tasks = state([
			{ id: 1, subject: "Dependency", status: "pending" },
			{ id: 2, subject: "Blocked", status: "pending", blockedBy: [1] },
			{ id: 3, subject: "Other", status: "pending" },
		]);
		expect(message(applyTaskMutation(tasks, "update", { id: 2, status: "in_progress", activeForm: "working" }))).toContain("must be completed");
		expect(message(applyTaskMutation(tasks, "update", { id: 1, status: "in_progress", activeForm: " " }))).toContain("activeForm required");
		const active = applyTaskMutation(tasks, "update", { id: 1, status: "in_progress", activeForm: "working" });
		expect(message(applyTaskMutation(active.state, "update", { id: 3, status: "in_progress", activeForm: "working" }))).toContain("already in_progress");
	});

	it("protects dependencies, unfinished clears, and non-empty subjects", () => {
		const tasks = state([
			{ id: 1, subject: "Dependency", status: "completed" },
			{ id: 2, subject: "Consumer", status: "pending", blockedBy: [1] },
		]);
		expect(message(applyTaskMutation(tasks, "delete", { id: 1 }))).toContain("required by #2");
		expect(message(applyTaskMutation(tasks, "update", { id: 1, status: "deleted" }))).toContain("required by #2");
		expect(message(applyTaskMutation(tasks, "clear", {}))).toContain("cannot clear");
		expect(message(applyTaskMutation(tasks, "update", { id: 2, subject: "  " }))).toContain("must not be empty");
		expect(applyTaskMutation(state([{ id: 1, subject: "Done", status: "completed" }], 4), "clear", {}).state).toEqual({ tasks: [], nextId: 4 });
	});
});
