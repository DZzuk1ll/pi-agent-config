import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { omitUndefined } from "../../../../_shared/runtime/omit-undefined.ts";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { requirePresent } from "../../../../_shared/runtime/require-present.ts";


const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
const GENERIC_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "mcp", "mcp.json");
const IMPORT_PATHS = {
	cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		path.join(os.homedir(), ".claude", "mcp.json"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
	codex: [path.join(os.homedir(), ".codex", "config.json")],
	windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
} as const;

type ImportKind = keyof typeof IMPORT_PATHS;

const ToolPrefixSchema = Type.Union([Type.Literal("server"), Type.Literal("none"), Type.Literal("short")]);
type ToolPrefix = Static<typeof ToolPrefixSchema>;

const ServerEntrySchema = Type.Object({
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	socket: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	auth: Type.Optional(Type.Union([Type.Literal("oauth"), Type.Literal("bearer"), Type.Literal(false)])),
	bearerToken: Type.Optional(Type.String()),
	bearerTokenEnv: Type.Optional(Type.String()),
	exposeResources: Type.Optional(Type.Boolean()),
	includeTools: Type.Optional(Type.Array(Type.String())),
	excludeTools: Type.Optional(Type.Array(Type.String())),
	directTools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
}, { additionalProperties: true });
type ServerEntry = Static<typeof ServerEntrySchema>;

interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	imports?: ImportKind[];
	settings?: {
		toolPrefix?: ToolPrefix;
		directTools?: boolean;
	};
}

const ServerCacheEntrySchema = Type.Object({
	configHash: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.Object({ name: Type.Optional(Type.String()) }, { additionalProperties: true }))),
	resources: Type.Optional(Type.Array(Type.Object({
		uri: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	}, { additionalProperties: true }))),
	cachedAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });
type ServerCacheEntry = Static<typeof ServerCacheEntrySchema>;

const MetadataCacheSchema = Type.Object({
	version: Type.Literal(CACHE_VERSION),
	servers: Type.Record(Type.String(), ServerCacheEntrySchema),
}, { additionalProperties: true });
type MetadataCache = Static<typeof MetadataCacheSchema>;

export interface ResolvedMcpDirectToolSelection { name: string; selector: string }

export function resolveMcpDirectToolSelections(mcpDirectTools: string[] | undefined, cwd = process.cwd()): ResolvedMcpDirectToolSelection[] {
	if (!mcpDirectTools?.length) return [];

	try {
		const config = loadMcpConfig(cwd);
		const cache = loadMetadataCache();
		if (!cache) return [];
		return resolveDirectToolSelections(config, cache, getToolPrefix(config.settings?.toolPrefix), mcpDirectTools);
	} catch {
		return [];
	}
}

function loadMetadataCache(): MetadataCache | null {
	const cachePath = path.join(getAgentDir(), "mcp-cache.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}

	return Value.Check(MetadataCacheSchema, parsed) ? parsed : null;
}

function loadMcpConfig(cwd: string): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const sourcePath of getConfigPaths(cwd)) {
		const loaded = readConfig(sourcePath);
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}
	return config;
}

function getConfigPaths(cwd: string): string[] {
	const piGlobalPath = path.join(getAgentDir(), "mcp.json");
	const projectPath = path.resolve(cwd, ".mcp.json");
	const projectPiPath = path.resolve(getProjectConfigDir(cwd), "mcp.json");
	const sources: string[] = [];
	if (GENERIC_GLOBAL_CONFIG_PATH !== piGlobalPath) sources.push(GENERIC_GLOBAL_CONFIG_PATH);
	sources.push(piGlobalPath);
	if (projectPath !== piGlobalPath) sources.push(projectPath);
	if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath) sources.push(projectPiPath);
	return sources;
}

function readConfig(configPath: string): McpConfig | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
	return validateConfig(parsed);
}

function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mcpServers: {} };
	const obj = raw as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};
	const rawSettings = obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
		? obj.settings as Record<string, unknown>
		: undefined;
	return omitUndefined({
		mcpServers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {},
		imports: Array.isArray(obj.imports) ? obj.imports.filter((value): value is ImportKind => isImportKind(value)) : undefined,
		settings: rawSettings
			? omitUndefined({
				toolPrefix: Value.Check(ToolPrefixSchema, rawSettings.toolPrefix) ? rawSettings.toolPrefix : undefined,
				directTools: typeof rawSettings.directTools === "boolean" ? rawSettings.directTools : undefined,
			})
			: undefined,
	});
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
	return omitUndefined({
		mcpServers: { ...base.mcpServers, ...next.mcpServers },
		imports: imports.length ? [...new Set(imports)] : undefined,
		settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
	});
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, ServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;
		let imported: unknown;
		try {
			imported = JSON.parse(fs.readFileSync(importPath, "utf-8"));
		} catch {
			continue;
		}
		for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
			if (!importedServers[name]) importedServers[name] = definition;
		}
	}

	return omitUndefined({
		imports: config.imports,
		settings: config.settings,
		mcpServers: { ...importedServers, ...config.mcpServers },
	});
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
	for (const candidate of IMPORT_PATHS[importKind]) {
		const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
		if (fs.existsSync(fullPath)) return fullPath;
	}
	return null;
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	const obj = config as Record<string, unknown>;
	const servers = kind === "cursor" || kind === "windsurf" || kind === "vscode"
		? obj.mcpServers ?? obj["mcp-servers"]
		: obj.mcpServers;
	return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, ServerEntry> : {};
}

function resolveDirectToolSelections(config: McpConfig, cache: MetadataCache, prefix: ToolPrefix, envOverride: string[]): ResolvedMcpDirectToolSelection[] {
	const names: ResolvedMcpDirectToolSelection[] = [];
	const seenNames = new Set<string>();
	const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isServerCacheValid(serverCache, definition)) continue;

		const toolFilter = selectedServers.has(serverName)
			? true
			: selectedTools.get(serverName);
		if (!toolFilter) continue;

		for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
			if (typeof tool?.name !== "string" || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${tool.name}` });
		}

		if (definition.exposeResources === false) continue;
		for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
			if (typeof resource?.name !== "string" || !resource.name || typeof resource.uri !== "string" || !resource.uri) continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${baseName}` });
		}
	}

	return names;
}

export function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd = process.cwd()): string[] {
	return resolveMcpDirectToolSelections(mcpDirectTools, cwd).map((selection) => selection.name);
}

function parseSelections(selections: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (let item of selections) {
		item = item.replace(/\/+$/, "");
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				if (!tools.has(server)) tools.set(server, new Set());
				requirePresent(tools.get(server)).add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

function isServerCacheValid(entry: ServerCacheEntry | undefined, definition: ServerEntry): entry is ServerCacheEntry {
	if (!entry || entry.configHash !== computeMcpServerHash(definition)) return false;
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
	return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

export function computeMcpServerHash(definition: ServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		socket: resolveConfigPath(definition.socket),
		env: interpolateEnvRecord(definition.env),
		cwd: resolveConfigPath(definition.cwd),
		url: resolveServerUrl(definition),
		headers: interpolateEnvRecord(definition.headers),
		auth: definition.auth,
		bearerToken: resolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		includeTools: definition.includeTools,
		excludeTools: definition.excludeTools,
	};
	return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function getToolPrefix(value: unknown): ToolPrefix {
	return value === "none" || value === "short" || value === "server" ? value : "server";
}

function isImportKind(value: unknown): value is ImportKind {
	return typeof value === "string" && Object.hasOwn(IMPORT_PATHS, value);
}

function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

function isToolExcluded(toolName: string, serverName: string, prefix: ToolPrefix, excludeTools: unknown): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => typeof excluded === "string" && candidates.has(normalizeToolName(excluded)));
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "")
		.toLowerCase();
	if (!result || /^\d/.test(result)) result = `resource${result ? `_${result}` : ""}`;
	return result;
}

function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]));
}

function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function interpolateSecretExpression(value: string): string {
	if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
	return value.startsWith("!") ? value : interpolateEnvVars(value);
}

function getMissingEnvVars(value: string): string[] {
	const missing = new Set<string>();
	for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
		const name = match[1] ?? match[2] ?? match[3];
		if (name && process.env[name] === undefined) missing.add(name);
	}
	return [...missing];
}

function resolveServerUrl(definition: Pick<ServerEntry, "url">): string | undefined {
	if (definition.url == null) return undefined;
	if (typeof definition.url !== "string") throw new Error("MCP server URL must be a string");

	const missing = getMissingEnvVars(definition.url);
	if (missing.length > 0) {
		throw new Error(`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`);
	}

	const resolved = interpolateEnvVars(definition.url);
	try {
		new URL(resolved);
	} catch (error) {
		throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, { cause: error });
	}
	return resolved;
}

function resolveConfigPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">): string | undefined {
	if (definition.bearerToken !== undefined) return interpolateSecretExpression(definition.bearerToken);
	return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}
