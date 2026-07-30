import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { utf8ByteLength, truncateUtf8 } from "./text.ts";

export interface SerializationLimits {
	maxBytes?: number;
	maxDepth?: number;
	maxNodes?: number;
	maxStringBytes?: number;
}

interface SerializationState {
	nodes: number;
	seen: WeakSet<object>;
	limits: Required<SerializationLimits>;
}

const DEFAULT_LIMITS: Required<SerializationLimits> = {
	maxBytes: 1024 * 1024,
	maxDepth: 16,
	maxNodes: 10_000,
	maxStringBytes: 128 * 1024,
};

function normalizeValue(value: unknown, state: SerializationState, depth: number): unknown {
	if (depth > state.limits.maxDepth) return "[maximum depth reached]";
	if (++state.nodes > state.limits.maxNodes) return "[node limit reached]";
	if (typeof value === "string") {
		return utf8ByteLength(value) > state.limits.maxStringBytes
			? `${truncateUtf8(value, state.limits.maxStringBytes)}[string truncated]`
			: value;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
	}
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "undefined") return null;
	if (typeof value === "function" || typeof value === "symbol") return `[${typeof value} omitted]`;
	if (typeof value !== "object") return String(value);
	if (state.seen.has(value)) return "[circular]";
	state.seen.add(value);
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item, state, depth + 1));
	const output: Record<string, unknown> = Object.create(null);
	for (const [key, item] of Object.entries(value)) {
		output[key] = normalizeValue(item, state, depth + 1);
	}
	return output;
}

export function toSerializable(value: unknown, limits: SerializationLimits = {}): unknown {
	const resolved = { ...DEFAULT_LIMITS, ...limits };
	return normalizeValue(value, { nodes: 0, seen: new WeakSet(), limits: resolved }, 0);
}

export function safeStringify(value: unknown, limits: SerializationLimits = {}): string {
	const resolved = { ...DEFAULT_LIMITS, ...limits };
	const json = JSON.stringify(toSerializable(value, resolved));
	if (utf8ByteLength(json) > resolved.maxBytes) {
		throw new Error(`Serialized value exceeds ${resolved.maxBytes} bytes`);
	}
	return json;
}

export function ensurePrivateDir(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

export function writeFileAtomic(filePath: string, content: string): void {
	ensurePrivateDir(path.dirname(filePath));
	const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, filePath);
		fs.chmodSync(filePath, 0o600);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

export function writeJsonAtomic(filePath: string, value: unknown, limits: SerializationLimits = {}): void {
	writeFileAtomic(filePath, `${safeStringify(value, limits)}\n`);
}

export interface PruneOptions {
	maxAgeMs: number;
	maxEntries: number;
	now?: number;
	excludeNames?: readonly string[];
}

export function prunePrivateRunDirs(root: string, options: PruneOptions): string[] {
	if (!fs.existsSync(root)) return [];
	const now = options.now ?? Date.now();
	const excluded = new Set(options.excludeNames ?? []);
	const entries = fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !excluded.has(entry.name))
		.flatMap((entry) => {
			const fullPath = path.join(root, entry.name);
			try {
				return [{ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const removed: string[] = [];
	for (const [index, entry] of entries.entries()) {
		if (index < options.maxEntries && now - entry.mtimeMs <= options.maxAgeMs) continue;
		fs.rmSync(entry.path, { recursive: true, force: true });
		removed.push(entry.path);
	}
	return removed;
}
