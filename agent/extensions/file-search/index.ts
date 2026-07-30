import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildFdArgs,
	buildRgArgs,
	FD_MAX_DEPTH,
	FD_MAX_LIMIT,
	RG_MAX_CONTEXT,
	RG_MAX_LIMIT,
	type FdParams,
	type RgParams,
} from "./args.ts";
import { sanitizeForDisplay, truncateUtf8, utf8ByteLength } from "../shared/text.ts";

const PREVIEW_CAPTURE_BYTES = Math.max(DEFAULT_MAX_BYTES * 2, 128 * 1024);
const FULL_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const MAX_RETAINED_OUTPUTS = 8;

type SearchTool = "fd" | "rg";

interface SearchResult {
	text: string;
	lineCount: number;
	truncated: boolean;
	fullOutputPath?: string;
	fullOutputCapped: boolean;
}

interface ArtifactLifecycle {
	created(directory: string): void;
	removed(directory: string): void;
	retained(directory: string): void;
}

function executableCandidates(name: string): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const names = process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
	const directories = [join(agentDir, "bin"), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
	return directories.flatMap((directory) => names.map((candidate) => join(directory, candidate)));
}

function resolveExecutable(names: readonly string[]): string | undefined {
	for (const name of names) {
		for (const candidate of executableCandidates(name)) {
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// Try the next candidate.
			}
		}
	}
	return undefined;
}

function missingBinaryMessage(tool: SearchTool): string {
	const packageName = tool === "fd" ? "fd" : "ripgrep";
	return `${tool} is not installed. Install ${packageName} with Homebrew (brew install ${packageName}) or place ${tool} in ~/.pi/agent/bin, then run /reload.`;
}

function safeInline(value: unknown): string {
	return sanitizeForDisplay(String(value ?? "")).replace(/[\r\n\t]+/g, " ");
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function runSearch(
	tool: SearchTool,
	command: string,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal | undefined,
	artifacts: ArtifactLifecycle,
): Promise<SearchResult> {
	return new Promise((resolve, reject) => {
		let directory = "";
		let fullOutputPath = "";
		let outputFd: number;
		try {
			directory = fs.mkdtempSync(join(tmpdir(), `pi-${tool}-${process.pid}-`));
			fullOutputPath = join(directory, "output.txt");
			outputFd = fs.openSync(fullOutputPath, "w", 0o600);
			artifacts.created(directory);
		} catch (error) {
			if (directory) {
				try {
					fs.rmSync(directory, { recursive: true, force: true });
				} catch {
					// Best-effort cleanup after setup failure.
				}
			}
			reject(asError(error));
			return;
		}
		const decoder = new StringDecoder("utf8");
		let preview = "";
		let previewCapped = false;
		let totalBytes = 0;
		let writtenBytes = 0;
		let lineBreaks = 0;
		let lastByte: number | undefined;
		let fullOutputCapped = false;
		let stderr = Buffer.alloc(0);
		let aborted = false;
		let settled = false;
		let outputClosed = false;

		const closeOutput = () => {
			if (outputClosed) return;
			outputClosed = true;
			try {
				fs.closeSync(outputFd);
			} catch {
				// The descriptor may already be closed after a spawn failure.
			}
		};
		const removeOutput = () => {
			closeOutput();
			try {
				fs.rmSync(directory, { recursive: true, force: true });
			} catch {
				// Cleanup is best effort; never mask the tool's real result or error.
			} finally {
				artifacts.removed(directory);
			}
		};

		const startChild = () => spawn(command, args, {
			cwd,
			env: { ...process.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let child: ReturnType<typeof startChild>;
		try {
			child = startChild();
		} catch (error) {
			removeOutput();
			reject(asError(error));
			return;
		}

		let childClosed = false;
		let terminationTimer: ReturnType<typeof setTimeout> | undefined;
		const terminateChild = () => {
			if (childClosed || terminationTimer) return;
			try {
				child.kill("SIGTERM");
			} catch {
				// Escalation below makes another best-effort attempt.
			}
			terminationTimer = setTimeout(() => {
				terminationTimer = undefined;
				if (childClosed) return;
				try {
					child.kill("SIGKILL");
				} catch {
					// The OS may have already reaped the process.
				}
			}, 750);
			terminationTimer.unref?.();
		};
		const abort = () => {
			aborted = true;
			terminateChild();
		};
		const finishError = (error: Error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			removeOutput();
			reject(error);
		};
		const failStream = (error: unknown) => {
			terminateChild();
			finishError(asError(error));
		};

		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();

		child.stdout.on("data", (chunk: Buffer) => {
			if (settled) return;
			totalBytes += chunk.byteLength;
			for (const byte of chunk) if (byte === 0x0a) lineBreaks += 1;
			lastByte = chunk.at(-1);

			if (!previewCapped) {
				preview += decoder.write(chunk);
				if (utf8ByteLength(preview) > PREVIEW_CAPTURE_BYTES) {
					preview = truncateUtf8(preview, PREVIEW_CAPTURE_BYTES);
					previewCapped = true;
				}
			}

			const remaining = FULL_OUTPUT_MAX_BYTES - writtenBytes;
			if (remaining <= 0) {
				fullOutputCapped = true;
				return;
			}
			const writable = chunk.subarray(0, remaining);
			try {
				let offset = 0;
				while (offset < writable.byteLength) {
					const written = fs.writeSync(outputFd, writable, offset, writable.byteLength - offset);
					if (written <= 0) throw new Error(`Could not persist ${tool} output.`);
					offset += written;
				}
				writtenBytes += writable.byteLength;
			} catch (error) {
				failStream(error);
				return;
			}
			if (writable.byteLength < chunk.byteLength) fullOutputCapped = true;
		});

		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.byteLength >= STDERR_MAX_BYTES) return;
			stderr = Buffer.concat([stderr, chunk.subarray(0, STDERR_MAX_BYTES - stderr.byteLength)]);
		});

		child.once("error", (error) => finishError(error));
		child.once("close", () => {
			childClosed = true;
			if (terminationTimer) clearTimeout(terminationTimer);
			terminationTimer = undefined;
		});
		child.once("close", (code, exitSignal) => {
			if (settled) return;
			closeOutput();
			signal?.removeEventListener("abort", abort);
			if (aborted) {
				finishError(new Error(`${tool} search cancelled.`));
				return;
			}
			if (code !== 0 && !(tool === "rg" && code === 1)) {
				const detail = sanitizeForDisplay(stderr.toString("utf8")).trim();
				finishError(new Error(`${tool} exited with ${code ?? exitSignal ?? "an unknown status"}${detail ? `: ${detail}` : ""}`));
				return;
			}

			settled = true;
			if (!previewCapped) preview += decoder.end();
			const sanitized = sanitizeForDisplay(preview).replace(/\n+$/, "");
			const bounded = truncateHead(sanitized, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const lineCount = totalBytes === 0 ? 0 : lineBreaks + (lastByte === 0x0a ? 0 : 1);
			const truncated = bounded.truncated || previewCapped || totalBytes > writtenBytes || lineCount > DEFAULT_MAX_LINES;
			if (truncated) artifacts.retained(directory);
			else removeOutput();

			let text = bounded.content;
			if (!text) text = tool === "fd" ? "No files found." : "No matches found.";
			if (truncated) {
				text += `\n\n[Output truncated: showing ${bounded.content ? bounded.content.split("\n").length : 0} of ${lineCount} lines. Captured output: ${safeInline(fullOutputPath)}${fullOutputCapped ? ` (capped at ${FULL_OUTPUT_MAX_BYTES / 1024 / 1024} MiB)` : ""}]`;
			}
			resolve({
				text,
				lineCount,
				truncated,
				...(truncated ? { fullOutputPath } : {}),
				fullOutputCapped,
			});
		});
	});
}

export default function fileSearch(pi: ExtensionAPI): void {
	const fd = resolveExecutable(["fd", "fdfind"]);
	const rg = resolveExecutable(["rg"]);
	const activeOutputs = new Set<string>();
	const retainedOutputs = new Set<string>();
	let sessionClosed = false;
	const removeArtifact = (directory: string) => {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort and must not break a search or shutdown.
		}
	};
	const artifacts: ArtifactLifecycle = {
		created(directory) {
			activeOutputs.add(directory);
		},
		removed(directory) {
			activeOutputs.delete(directory);
			retainedOutputs.delete(directory);
		},
		retained(directory) {
			activeOutputs.delete(directory);
			if (sessionClosed) {
				removeArtifact(directory);
				return;
			}
			retainedOutputs.add(directory);
			while (retainedOutputs.size > MAX_RETAINED_OUTPUTS) {
				const oldest = retainedOutputs.values().next().value as string | undefined;
				if (!oldest) break;
				retainedOutputs.delete(oldest);
				removeArtifact(oldest);
			}
		},
	};
	pi.on("session_start", () => {
		sessionClosed = false;
	});
	pi.on("session_shutdown", () => {
		sessionClosed = true;
		for (const directory of new Set([...activeOutputs, ...retainedOutputs])) removeArtifact(directory);
		activeOutputs.clear();
		retainedOutputs.clear();
	});

	pi.registerTool({
		name: "fd",
		label: "Find Files",
		description: "Find files and directories with fd. Supports regex or glob patterns, type/extension filters, hidden files, depth limits, and bounded results.",
		promptSnippet: "Find files and directories with fd using structured filters",
		promptGuidelines: [
			"Use fd for filename and directory discovery when its type, extension, glob, hidden-file, or depth filters are more useful than the built-in find tool.",
			"Use the built-in find tool for simple project glob lookups; do not duplicate the same search with fd unless the first result is insufficient.",
		],
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ maxLength: 4_096, description: "Regex pattern by default; interpreted as a glob when glob=true. Omit to match everything." })),
			path: Type.Optional(Type.String({ maxLength: 4_096, description: "Directory to search, relative to the current project or absolute." })),
			type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink")])),
			extension: Type.Optional(Type.String({ maxLength: 128, description: "File extension, with or without a leading dot." })),
			glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob instead of a regular expression." })),
			hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories." })),
			max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: FD_MAX_DEPTH })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FD_MAX_LIMIT, default: 1_000 })),
		}),
		async execute(_id, params: FdParams, signal, _onUpdate, ctx) {
			if (!fd) throw new Error(missingBinaryMessage("fd"));
			const args = buildFdArgs(params);
			const result = await runSearch("fd", fd, args, ctx.cwd, signal, artifacts);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					command: fd,
					args,
					lineCount: result.lineCount,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
					fullOutputCapped: result.fullOutputCapped,
				},
			};
		},
		renderCall(args, theme) {
			const pattern = safeInline(args.pattern || "(all)");
			const path = args.path ? ` in ${safeInline(args.path)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("fd "))}${theme.fg("accent", pattern)}${theme.fg("muted", path)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "rg",
		label: "Search Content",
		description: "Search file contents with ripgrep. Supports regex or literal matching, glob/file-type filters, hidden files, context lines, and bounded matches per file.",
		promptSnippet: "Search file contents with ripgrep using structured filters",
		promptGuidelines: [
			"Use rg for content searches that benefit from ripgrep glob, file-type, literal, hidden-file, or context-line controls.",
			"Use the built-in grep tool for simple searches whose concise indexed output is sufficient; do not repeat identical searches with rg.",
		],
		parameters: Type.Object({
			pattern: Type.String({ minLength: 1, maxLength: 4_096, description: "Regular expression to search for, or literal text when fixed_strings=true." }),
			path: Type.Optional(Type.String({ maxLength: 4_096, description: "File or directory to search, relative to the current project or absolute." })),
			glob: Type.Optional(Type.String({ maxLength: 1_024, description: "ripgrep include/exclude glob, for example **/*.ts or !dist/**." })),
			file_type: Type.Optional(Type.String({ maxLength: 128, description: "ripgrep file type such as ts, js, py, or rust." })),
			fixed_strings: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text." })),
			hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories." })),
			context: Type.Optional(Type.Integer({ minimum: 0, maximum: RG_MAX_CONTEXT, description: "Lines of context before and after each match." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: RG_MAX_LIMIT, default: 100, description: "Maximum matches per file." })),
		}),
		async execute(_id, params: RgParams, signal, _onUpdate, ctx) {
			if (!rg) throw new Error(missingBinaryMessage("rg"));
			const args = buildRgArgs(params);
			const result = await runSearch("rg", rg, args, ctx.cwd, signal, artifacts);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					command: rg,
					args,
					lineCount: result.lineCount,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
					fullOutputCapped: result.fullOutputCapped,
				},
			};
		},
		renderCall(args, theme) {
			const path = args.path ? ` in ${safeInline(args.path)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("rg "))}${theme.fg("accent", safeInline(args.pattern))}${theme.fg("muted", path)}`, 0, 0);
		},
	});
}
