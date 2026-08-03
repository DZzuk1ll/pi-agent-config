import { Check } from "typebox/value";
import { TaskDetailsSchema, type Task, type TaskDetails } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!Check(TaskDetailsSchema, value)) return false;
	return isSemanticallyValidSnapshot(value.tasks, value.nextId);
}

function isSemanticallyValidSnapshot(tasks: readonly Task[], nextId: number): boolean {
	const byId = new Map<number, Task>();
	let inProgress = 0;
	for (const task of tasks) {
		if (!task.subject.trim() || byId.has(task.id)) return false;
		byId.set(task.id, task);
		if (task.status === "in_progress" && ++inProgress > 1) return false;
	}
	if (nextId <= Math.max(0, ...byId.keys())) return false;

	for (const task of tasks) {
		const dependencies = task.blockedBy ?? [];
		if (new Set(dependencies).size !== dependencies.length) return false;
		for (const id of dependencies) {
			const dependency = byId.get(id);
			if (id === task.id || !dependency || dependency.status === "deleted") return false;
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const visit = (id: number): boolean => {
		if (visiting.has(id)) return false;
		if (visited.has(id)) return true;
		visiting.add(id);
		for (const dependency of byId.get(id)?.blockedBy ?? []) {
			if (!visit(dependency)) return false;
		}
		visiting.delete(id);
		visited.add(id);
		return true;
	};
	return tasks.every((task) => visit(task.id));
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). When no matching entry exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = {
			tasks: msg.details.tasks.map((task) => ({
				...task,
				...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
				...(task.metadata ? { metadata: { ...task.metadata } } : {}),
			})),
			nextId: msg.details.nextId,
		};
	}
	return result;
}
