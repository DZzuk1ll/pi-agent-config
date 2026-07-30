import { homedir } from "node:os";
import { join } from "node:path";

export const FD_DEFAULT_LIMIT = 1_000;
export const FD_MAX_LIMIT = 10_000;
export const FD_MAX_DEPTH = 64;
export const RG_DEFAULT_LIMIT = 100;
export const RG_MAX_LIMIT = 1_000;
export const RG_MAX_CONTEXT = 20;

export type FdEntryType = "file" | "directory" | "symlink";

export interface FdParams {
	pattern?: string;
	path?: string;
	type?: FdEntryType;
	extension?: string;
	glob?: boolean;
	hidden?: boolean;
	max_depth?: number;
	limit?: number;
}

export interface RgParams {
	pattern: string;
	path?: string;
	glob?: string;
	file_type?: string;
	fixed_strings?: boolean;
	hidden?: boolean;
	context?: number;
	limit?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function normalizeSearchPath(raw: string): string {
	let value = raw.trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function optionalPath(raw?: string): string | undefined {
	if (raw === undefined) return undefined;
	const normalized = normalizeSearchPath(raw);
	return normalized || undefined;
}

export function buildFdArgs(params: FdParams): string[] {
	const args = ["--color=never"];
	if (params.hidden) args.push("--hidden");
	if (params.glob) args.push("--glob");
	if (params.type) {
		const type = { file: "f", directory: "d", symlink: "l" }[params.type];
		args.push("--type", type);
	}
	if (params.extension?.trim()) args.push("--extension", params.extension.trim().replace(/^\./, ""));
	if (params.max_depth !== undefined) {
		args.push("--max-depth", String(clamp(params.max_depth, 1, FD_MAX_DEPTH)));
	}
	args.push("--max-results", String(clamp(params.limit ?? FD_DEFAULT_LIMIT, 1, FD_MAX_LIMIT)));
	args.push("--", params.pattern ?? "");
	const path = optionalPath(params.path);
	if (path) args.push(path);
	return args;
}

export function buildRgArgs(params: RgParams): string[] {
	const args = ["--line-number", "--no-heading", "--color=never"];
	if (params.fixed_strings) args.push("--fixed-strings");
	if (params.hidden) args.push("--hidden");
	if (params.context !== undefined) {
		args.push("--context", String(clamp(params.context, 0, RG_MAX_CONTEXT)));
	}
	if (params.glob?.trim()) args.push("--glob", params.glob.trim());
	if (params.file_type?.trim()) args.push("--type", params.file_type.trim());
	args.push("--max-count", String(clamp(params.limit ?? RG_DEFAULT_LIMIT, 1, RG_MAX_LIMIT)));
	args.push("--", params.pattern);
	const path = optionalPath(params.path);
	if (path) args.push(path);
	return args;
}
