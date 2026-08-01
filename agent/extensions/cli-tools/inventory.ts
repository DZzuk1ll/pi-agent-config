import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import {
	CLI_TOOL_CATALOG,
	CLI_TOOL_CATEGORIES,
	type CliToolCatalogEntry,
	type CliToolCategory,
} from "./catalog.ts";

const PROBE_TIMEOUT_MS = 1_500;
const PROBE_MAX_BYTES = 64 * 1024;

export interface AvailableCliTool {
	entry: CliToolCatalogEntry;
	command: string;
	path: string;
}

export interface ScanCliToolsOptions {
	path?: string;
	pathExt?: string;
	platform?: NodeJS.Platform;
	readProbeOutput?: (path: string, entry: CliToolCatalogEntry) => string | undefined;
}

function commandVariants(command: string, platform: NodeJS.Platform, pathExt: string): string[] {
	if (platform !== "win32" || extname(command)) return [command];
	const extensions = pathExt
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean);
	return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function resolveCommand(
	command: string,
	pathValue: string,
	platform: NodeJS.Platform,
	pathExt: string,
): string | undefined {
	const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
	const directories = pathValue.split(delimiter).filter(Boolean);
	for (const directory of directories) {
		for (const variant of commandVariants(command, platform, pathExt)) {
			const candidate = join(directory, variant);
			try {
				accessSync(candidate, accessMode);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// Continue through PATH just like shell command resolution.
			}
		}
	}
	return undefined;
}

export function readCliToolProbeOutput(path: string, entry: CliToolCatalogEntry): string | undefined {
	if (!entry.probeArgs) return undefined;
	const result = spawnSync(path, entry.probeArgs, {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		maxBuffer: PROBE_MAX_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: PROBE_TIMEOUT_MS,
	});
	if (result.error) return undefined;
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
	return output ? sanitizeForDisplay(output) : undefined;
}

export function scanAvailableCliTools(options: ScanCliToolsOptions = {}): AvailableCliTool[] {
	const pathValue = options.path ?? process.env.PATH ?? "";
	const platform = options.platform ?? process.platform;
	const pathExt = options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	const readProbe = options.readProbeOutput ?? readCliToolProbeOutput;
	const available: AvailableCliTool[] = [];

	for (const entry of CLI_TOOL_CATALOG) {
		for (const command of entry.commands) {
			const path = resolveCommand(command, pathValue, platform, pathExt);
			if (!path) continue;
			if (entry.identityPattern) {
				const probeOutput = readProbe(path, entry);
				if (!probeOutput || !entry.identityPattern.test(probeOutput)) continue;
			}
			available.push({ entry, command, path });
			break;
		}
	}

	return available;
}

export function findCliToolCategory(value: string): CliToolCategory | undefined {
	const normalized = value.trim().toLocaleLowerCase();
	return CLI_TOOL_CATEGORIES.find((category) =>
		category.id.toLocaleLowerCase() === normalized || category.label.toLocaleLowerCase() === normalized
	);
}

export function searchAvailableCliTools(tools: readonly AvailableCliTool[], query: string): AvailableCliTool[] {
	const terms = query
		.trim()
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}._+-]+/u)
		.filter(Boolean);
	if (terms.length === 0) return [];

	return tools.filter((tool) => {
		const category = CLI_TOOL_CATEGORIES.find((candidate) => candidate.id === tool.entry.category);
		const haystack = [
			tool.entry.name,
			...tool.entry.commands,
			tool.entry.category,
			category?.label ?? "",
			category?.description ?? "",
			tool.entry.description,
			...tool.entry.keywords,
		].join(" ").toLocaleLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}
