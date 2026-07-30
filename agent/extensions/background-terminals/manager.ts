import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backgroundEnvironment } from "./environment.ts";
import type { StreamCapture, StreamSnapshot, TerminalRecord, TerminalSnapshot } from "./types.ts";
import { Deferred, settleWithin, type FinalRunState } from "../shared/lifecycle.ts";
import { ensurePrivateDir, writeJsonAtomic } from "../shared/artifacts.ts";
import { sanitizeForDisplay, truncateUtf8, utf8ByteLength, Utf8TailBuffer } from "../shared/text.ts";

export const MAX_RUNNING_TERMINALS = 8;
export const MAX_COMMAND_BYTES = 32 * 1024;
export const MAX_TITLE_LENGTH = 120;
export const MEMORY_BYTES_PER_STREAM = 1024 * 1024;
export const SPILL_BYTES_PER_STREAM = 32 * 1024 * 1024;
export const MAX_SETTLED_RECORDS = 50;
export const MAX_SESSION_SPILL_BYTES = 512 * 1024 * 1024;
const STALE_SESSION_AGE_MS = 24 * 60 * 60 * 1_000;
const OWNER_HEARTBEAT_MS = 60 * 1_000;
const TERM_GRACE_MS = 2_500;
const KILL_GRACE_MS = 500;
const STDIO_SETTLE_MS = 1_000;
const SPILL_FLUSH_MS = 1_500;

export function resolveProjectCwd(projectRoot: string, requested?: string): string {
	const root = fs.realpathSync(projectRoot);
	const candidate = fs.realpathSync(requested ? path.resolve(root, requested) : root);
	const relative = path.relative(root, candidate);
	if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		return candidate;
	}
	throw new Error(`cwd must stay inside the current project: ${candidate}`);
}

function shellInvocation(command: string): { shell: string; args: string[] } {
	const supervisor = [
		"__pi_cleanup() {",
		"  __pi_status=$?",
		"  trap - EXIT HUP INT TERM",
		"  __pi_jobs=$(jobs -pr 2>/dev/null)",
		"  for __pi_pid in $__pi_jobs; do",
		"    /bin/kill -TERM -- \"-$__pi_pid\" 2>/dev/null || /bin/kill -TERM \"$__pi_pid\" 2>/dev/null || true",
		"  done",
		"  if [ -n \"$__pi_jobs\" ]; then /bin/sleep 0.05; fi",
		"  for __pi_pid in $__pi_jobs; do",
		"    /bin/kill -KILL -- \"-$__pi_pid\" 2>/dev/null || /bin/kill -KILL \"$__pi_pid\" 2>/dev/null || true",
		"  done",
		"  exit \"$__pi_status\"",
		"}",
		"trap '__pi_cleanup' EXIT",
		"trap 'exit 129' HUP",
		"trap 'exit 130' INT",
		"trap 'exit 143' TERM",
	].join("\n");
	return { shell: "/bin/sh", args: ["-c", `${supervisor}\n${command}`] };
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid && process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => {
				try { child.kill(signal); } catch {}
			});
			killer.unref();
			return;
		} catch {
			// Fall through to direct signalling.
		}
	}
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The process group may already have ended.
		}
	}
	try { child.kill(signal); } catch {}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processIdentity(pid: number): string | undefined {
	if (process.platform === "win32") return undefined;
	try {
		const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1_000,
			maxBuffer: 4 * 1024,
		}).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

interface SpillOwner {
	pid?: number;
	createdAt?: number;
	heartbeatAt?: number;
	processIdentity?: string;
}

function scavengeStaleSessions(base: string): void {
	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
		const directory = path.join(base, entry.name);
		let owner: SpillOwner | undefined;
		try { owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")) as SpillOwner; } catch {}
		const ownerPid = Number.isSafeInteger(owner?.pid) && owner!.pid! > 1 ? owner!.pid : undefined;
		if (ownerPid && pidExists(ownerPid)) {
			if (owner?.processIdentity) {
				const currentIdentity = processIdentity(ownerPid);
				if (currentIdentity === owner.processIdentity) continue;
				if (currentIdentity) {
					try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
					continue;
				}
			}
			const heartbeatAt = Number.isFinite(owner?.heartbeatAt) ? owner!.heartbeatAt! : owner?.createdAt;
			if (heartbeatAt && Date.now() - heartbeatAt < STALE_SESSION_AGE_MS) continue;
		}
		if (!ownerPid) {
			try {
				if (Date.now() - fs.statSync(directory).mtimeMs < STALE_SESSION_AGE_MS) continue;
			} catch {}
		}
		try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
	}
}

function processGroupExists(child: ChildProcess): boolean {
	if (process.platform === "win32" || !child.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function createCapture(directory: string, id: string, stream: "stdout" | "stderr"): StreamCapture {
	const spillPath = path.join(directory, `${id}.${stream}.log`);
	const capture: StreamCapture = {
		tail: new Utf8TailBuffer(MEMORY_BYTES_PER_STREAM),
		spillPath,
		spillBytes: 0,
		spillCapped: false,
		spillEvicted: false,
	};
	try {
		const writer = fs.createWriteStream(spillPath, { flags: "a", mode: 0o600 });
		capture.writer = writer;
		writer.on("error", (error) => {
			capture.writeError = error instanceof Error ? error.message : String(error);
			capture.writer = undefined;
		});
	} catch (error) {
		capture.writeError = error instanceof Error ? error.message : String(error);
		capture.spillPath = undefined;
	}
	return capture;
}

function captureChunk(capture: StreamCapture, chunk: Buffer | string): boolean {
	const decoded = capture.tail.push(chunk);
	const writer = capture.writer;
	if (!writer || capture.spillCapped || writer.destroyed || writer.writableEnded) return true;
	const remaining = SPILL_BYTES_PER_STREAM - capture.spillBytes;
	if (remaining <= 0) {
		capture.spillCapped = true;
		return true;
	}
	const text = utf8ByteLength(decoded) > remaining ? truncateUtf8(decoded, remaining) : decoded;
	if (text.length === 0) {
		capture.spillCapped = true;
		return true;
	}
	capture.spillBytes += utf8ByteLength(text);
	if (capture.spillBytes >= SPILL_BYTES_PER_STREAM || text.length < decoded.length) capture.spillCapped = true;
	return writer.write(text, "utf8");
}

async function flushCapture(capture: StreamCapture): Promise<void> {
	capture.tail.finish();
	const writer = capture.writer;
	capture.writer = undefined;
	if (!writer || writer.destroyed || writer.writableFinished) return;
	const flushed = new Promise<void>((resolve) => {
		const done = () => resolve();
		writer.once("finish", done);
		writer.once("close", done);
		writer.once("error", done);
		writer.end();
	});
	await settleWithin(flushed, SPILL_FLUSH_MS);
}

function streamSnapshot(capture: StreamCapture): StreamSnapshot {
	const view = capture.tail.view();
	return {
		...view,
		...(capture.spillPath ? { spillPath: capture.spillPath } : {}),
		spillBytes: capture.spillBytes,
		spillCapped: capture.spillCapped,
		spillEvicted: capture.spillEvicted,
	};
}

function materialize(record: TerminalRecord): TerminalSnapshot {
	return {
		id: record.id,
		command: record.command,
		title: record.title,
		cwd: record.cwd,
		...(record.child.pid ? { pid: record.child.pid } : {}),
		state: record.state,
		startedAt: record.startedAt,
		...(record.endedAt ? { endedAt: record.endedAt } : {}),
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.signal ? { signal: record.signal } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.residualTreeTerminated ? { residualTreeTerminated: true } : {}),
		stdout: streamSnapshot(record.stdout),
		stderr: streamSnapshot(record.stderr),
	};
}

function classify(record: TerminalRecord): FinalRunState {
	if (record.abortRequested) return "aborted";
	if (record.killRequested) return "killed";
	if (record.processError || record.exitCode !== 0) return "failed";
	return "done";
}

export class BackgroundTerminalManager {
	private readonly projectRoot: string;
	private readonly entries = new Map<string, TerminalRecord>();
	private readonly listeners = new Set<() => void>();
	private readonly logDir: string;
	private readonly ownerPath: string;
	private readonly ownerIdentity: string | undefined;
	private ownerHeartbeat: ReturnType<typeof setInterval> | undefined;
	private counter = 0;
	private reserved = 0;
	private disposed = false;
	private settledHook?: (snapshot: TerminalSnapshot, consumed: boolean) => void;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		const base = path.join(os.tmpdir(), "pi-background-terminals");
		ensurePrivateDir(base);
		scavengeStaleSessions(base);
		this.logDir = fs.mkdtempSync(path.join(base, "session-"));
		fs.chmodSync(this.logDir, 0o700);
		this.ownerPath = path.join(this.logDir, "owner.json");
		this.ownerIdentity = processIdentity(process.pid);
		this.writeOwnerHeartbeat(Date.now());
		this.ownerHeartbeat = setInterval(() => {
			try { this.writeOwnerHeartbeat(Date.now()); } catch {}
		}, OWNER_HEARTBEAT_MS);
		this.ownerHeartbeat.unref?.();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setOnSettled(hook: ((snapshot: TerminalSnapshot, consumed: boolean) => void) | undefined): void {
		this.settledHook = hook;
	}

	list(includeSettled = true): TerminalSnapshot[] {
		return [...this.entries.values()]
			.filter((entry) => includeSettled || entry.state === "running" || entry.state === "starting")
			.map(materialize)
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	get(id: string): TerminalSnapshot | undefined {
		const record = this.entries.get(id);
		return record ? materialize(record) : undefined;
	}

	async start(options: { command: string; title?: string; cwd?: string }): Promise<TerminalSnapshot> {
		if (this.disposed) throw new Error("Background terminal manager is shutting down");
		if (process.platform === "win32") throw new Error("Background terminals require POSIX process-group containment");
		if (!options.command.trim()) throw new Error("command must not be empty");
		if (utf8ByteLength(options.command) > MAX_COMMAND_BYTES) throw new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
		const title = sanitizeForDisplay(options.title?.trim() || options.command.trim().split("\n", 1)[0] || "background task")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, MAX_TITLE_LENGTH) || "background task";
		const running = [...this.entries.values()].filter((entry) => entry.state === "starting" || entry.state === "running").length;
		if (running + this.reserved >= MAX_RUNNING_TERMINALS) throw new Error(`At most ${MAX_RUNNING_TERMINALS} background terminals may run concurrently`);
		this.reserved++;
		try {
			const cwd = resolveProjectCwd(this.projectRoot, options.cwd);
			const { shell, args } = shellInvocation(options.command);
			const child = spawn(shell, args, {
				cwd,
				env: backgroundEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				windowsHide: true,
			});
			const id = `bt-${++this.counter}`;
			const record: TerminalRecord = {
				id,
				command: options.command,
				title,
				cwd,
				child,
				state: "starting",
				startedAt: Date.now(),
				stdout: createCapture(this.logDir, id, "stdout"),
				stderr: createCapture(this.logDir, id, "stderr"),
				completion: new Deferred<TerminalSnapshot>(),
				closed: false,
				processError: false,
				killRequested: false,
				abortRequested: false,
				consumeInterest: 0,
				residualTreeTerminated: false,
			};
			this.entries.set(id, record);
			record.state = "running";
			this.enforceSpillBudget();
			this.attach(record);
			this.notify();
			if (this.disposed) {
				record.abortRequested = true;
				await this.terminate(record);
				throw new Error("Background terminal manager shut down while starting");
			}
			return materialize(record);
		} finally {
			this.reserved--;
		}
	}

	async kill(ids: readonly string[], consumed = true): Promise<TerminalSnapshot[]> {
		const unique = [...new Set(ids)];
		const records = unique.map((id) => {
			const record = this.entries.get(id);
			if (!record) throw new Error(`Unknown background terminal: ${id}`);
			return record;
		});
		for (const record of records) {
			if (consumed) record.consumeInterest++;
			if (record.state === "starting" || record.state === "running") record.killRequested = true;
		}
		try {
			return await Promise.all(records.map((record) => this.terminate(record)));
		} finally {
			for (const record of records) {
				if (consumed) record.consumeInterest = Math.max(0, record.consumeInterest - 1);
			}
		}
	}

	requestKill(id: string): void {
		const record = this.entries.get(id);
		if (!record || (record.state !== "starting" && record.state !== "running")) return;
		record.killRequested = true;
		void this.terminate(record);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.ownerHeartbeat) clearInterval(this.ownerHeartbeat);
		this.ownerHeartbeat = undefined;
		this.settledHook = undefined;
		const active = [...this.entries.values()].filter((record) => record.state === "starting" || record.state === "running");
		for (const record of active) record.abortRequested = true;
		await Promise.allSettled(active.map((record) => this.terminate(record)));
		this.listeners.clear();
		try { fs.rmSync(this.logDir, { recursive: true, force: true }); } catch {}
	}

	private writeOwnerHeartbeat(now: number): void {
		writeJsonAtomic(this.ownerPath, {
			pid: process.pid,
			createdAt: now - process.uptime() * 1_000,
			heartbeatAt: now,
			...(this.ownerIdentity ? { processIdentity: this.ownerIdentity } : {}),
		});
	}

	private attach(record: TerminalRecord): void {
		const bind = (stream: NodeJS.ReadableStream | null, capture: StreamCapture) => {
			stream?.on("data", (chunk: Buffer | string) => {
				const flowing = captureChunk(capture, chunk);
				if (!flowing && capture.writer) {
					stream.pause();
					const writer = capture.writer;
					const resume = () => {
						writer.off("drain", resume);
						writer.off("error", resume);
						stream.resume();
					};
					writer.once("drain", resume);
					writer.once("error", resume);
				}
				this.notify();
			});
		};
		bind(record.child.stdout, record.stdout);
		bind(record.child.stderr, record.stderr);
		record.child.once("error", (error) => {
			record.processError = true;
			record.error = error instanceof Error ? error.message : String(error);
			void this.settle(record);
		});
		record.child.once("exit", (code, signal) => {
			record.exitCode = code ?? undefined;
			record.signal = signal ?? undefined;
			record.exitCleanup = setTimeout(() => {
				if (record.closed || record.completion.isSettled) return;
				void this.terminate(record, false);
			}, STDIO_SETTLE_MS);
			record.exitCleanup.unref?.();
		});
		record.child.once("close", (code, signal) => {
			record.closed = true;
			if (record.exitCleanup) clearTimeout(record.exitCleanup);
			if (!record.processError) {
				record.exitCode ??= code ?? undefined;
				record.signal ??= signal ?? undefined;
			}
			void this.settle(record);
		});
	}

	private async terminate(record: TerminalRecord, markKill = true): Promise<TerminalSnapshot> {
		if (record.completion.isSettled) return record.completion.promise;
		const childAlreadyExited = record.child.exitCode !== null || record.child.signalCode !== null;
		if (markKill && !childAlreadyExited && !record.abortRequested) record.killRequested = true;
		if (!record.closed || processGroupExists(record.child)) killProcessTree(record.child, "SIGTERM");
		const graceful = await settleWithin(record.completion.promise, TERM_GRACE_MS);
		if (graceful) return graceful;
		if (!record.closed || processGroupExists(record.child)) killProcessTree(record.child, "SIGKILL");
		const forced = await settleWithin(record.completion.promise, KILL_GRACE_MS);
		if (forced) return forced;
		record.error ??= "process stdio did not close after forced termination; output may be incomplete";
		return this.settle(record);
	}

	private settle(record: TerminalRecord): Promise<TerminalSnapshot> {
		if (record.completion.isSettled) return record.completion.promise;
		if (record.settling) return record.settling;
		record.settling = (async () => {
			if (record.exitCleanup) clearTimeout(record.exitCleanup);
			await this.cleanupResidualTree(record);
			await Promise.all([flushCapture(record.stdout), flushCapture(record.stderr)]);
			record.state = classify(record);
			record.endedAt = Date.now();
			if (record.stdout.writeError || record.stderr.writeError) {
				record.error ??= `log write failed: ${record.stdout.writeError ?? record.stderr.writeError}`;
				if (record.state === "done") record.state = "failed";
			}
			this.pruneSettled();
			this.enforceSpillBudget();
			const snapshot = materialize(record);
			record.completion.resolve(snapshot);
			this.notify();
			if (!this.disposed) {
				try { this.settledHook?.(snapshot, record.consumeInterest > 0); } catch {}
			}
			return snapshot;
		})();
		return record.settling;
	}

	private async cleanupResidualTree(record: TerminalRecord): Promise<void> {
		if (!record.closed || !processGroupExists(record.child)) return;
		if (!record.killRequested && !record.abortRequested) record.residualTreeTerminated = true;
		killProcessTree(record.child, "SIGTERM");
		const termDeadline = Date.now() + TERM_GRACE_MS;
		while (processGroupExists(record.child) && Date.now() < termDeadline) await delay(25);
		if (!processGroupExists(record.child)) return;
		killProcessTree(record.child, "SIGKILL");
		const killDeadline = Date.now() + KILL_GRACE_MS;
		while (processGroupExists(record.child) && Date.now() < killDeadline) await delay(25);
		if (processGroupExists(record.child)) {
			record.error ??= "residual process group survived forced termination";
		}
	}

	private pruneSettled(): void {
		const settled = [...this.entries.values()]
			.filter((record) => record.state !== "starting" && record.state !== "running")
			.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		for (const record of settled.slice(MAX_SETTLED_RECORDS)) {
			this.deleteRecordSpills(record);
			this.entries.delete(record.id);
		}
	}

	private enforceSpillBudget(): void {
		const records = [...this.entries.values()];
		const activeCount = records.filter((record) => record.state === "starting" || record.state === "running").length;
		const settled = records
			.filter((record) => record.state !== "starting" && record.state !== "running")
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		let projected = activeCount * SPILL_BYTES_PER_STREAM * 2;
		for (const record of settled) {
			if (record.stdout.spillPath) projected += record.stdout.spillBytes;
			if (record.stderr.spillPath) projected += record.stderr.spillBytes;
		}
		for (const record of settled) {
			if (projected <= MAX_SESSION_SPILL_BYTES) break;
			const bytes = (record.stdout.spillPath ? record.stdout.spillBytes : 0)
				+ (record.stderr.spillPath ? record.stderr.spillBytes : 0);
			this.deleteRecordSpills(record);
			projected = Math.max(0, projected - bytes);
		}
	}

	private deleteRecordSpills(record: TerminalRecord): void {
		for (const capture of [record.stdout, record.stderr]) {
			if (capture.writer || !capture.spillPath) continue;
			try { fs.rmSync(capture.spillPath, { force: true }); } catch {}
			capture.spillPath = undefined;
			capture.spillEvicted = true;
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try { listener(); } catch {}
		}
	}
}
