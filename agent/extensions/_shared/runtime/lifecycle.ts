
import { requirePresent } from "./require-present.ts";
export type FinalRunState = "done" | "failed" | "killed" | "aborted";
export type RunState = "starting" | "running" | FinalRunState;

export class Deferred<T> {
	readonly promise: Promise<T>;
	private readonly resolvePromise: (value: T) => void;
	private settled = false;

	constructor() {
		let resolvePromise: ((value: T) => void) | undefined;
		this.promise = new Promise<T>((resolve) => {
			resolvePromise = resolve;
		});
		this.resolvePromise = requirePresent(resolvePromise);
	}

	resolve(value: T): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.resolvePromise(value);
		return true;
	}

	get isSettled(): boolean {
		return this.settled;
	}
}

export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class DeferredResultDelivery<T extends { id: string }> {
	private readonly pending = new Map<string, T>();

	queue(value: T): void {
		if (!this.pending.has(value.id)) this.pending.set(value.id, value);
	}

	consume(ids: readonly string[]): void {
		for (const id of ids) this.pending.delete(id);
	}

	drain(): T[] {
		const values = [...this.pending.values()];
		this.pending.clear();
		return values;
	}

	clear(): void {
		this.pending.clear();
	}
}

export class SubscriptionBag {
	private readonly cleanups = new Set<() => void>();
	private disposed = false;

	add(cleanup: (() => void) | undefined): () => void {
		if (typeof cleanup !== "function") return () => {};
		if (this.disposed) {
			cleanup();
			return () => {};
		}
		this.cleanups.add(cleanup);
		return () => {
			if (this.cleanups.delete(cleanup)) cleanup();
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const cleanup of [...this.cleanups]) {
			try {
				cleanup();
			} catch {
				// One cleanup must not prevent the others.
			}
		}
		this.cleanups.clear();
	}
}

export class Semaphore {
	readonly limit: number;
	private active = 0;
	private readonly waiters: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be positive");
		this.limit = limit;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw abortError(signal);
		if (this.active < this.limit) {
			this.active++;
			return this.releaseHandle();
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = {
				resolve,
				reject,
				...(signal === undefined ? {} : { signal }),
			};
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortError(signal));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
		// The releasing holder transfers its slot directly to this waiter.
		return this.releaseHandle();
	}

	clear(reason = "Semaphore closed"): void {
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error(reason));
		}
	}

	private releaseHandle(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (this.waiters.length > 0) {
				const waiter = requirePresent(this.waiters.shift());
				if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal?.aborted) {
					waiter.reject(abortError(waiter.signal));
					continue;
				}
				waiter.resolve();
				return;
			}
			this.active = Math.max(0, this.active - 1);
		};
	}
}

export function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

export function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
	if (!parent) return () => {};
	const abort = () => child.abort(parent.reason instanceof Error ? parent.reason : new Error("Operation aborted"));
	if (parent.aborted) abort();
	else parent.addEventListener("abort", abort, { once: true });
	return () => parent.removeEventListener("abort", abort);
}
