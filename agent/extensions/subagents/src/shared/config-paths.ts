import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

function validConfigDirName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function readConfigDirNameFromPackageRoot(packageRoot: string | undefined): string | undefined {
	if (!packageRoot) return undefined;
	try {
		const pkg = recordValue(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")));
		if (!pkg) return undefined;
		if (pkg.name !== PI_CODING_AGENT_PACKAGE_NAME) return undefined;
		return validConfigDirName(recordValue(pkg.piConfig)?.configDir);
	} catch {
		return undefined;
	}
}

function resolveConfigDirNameFromPackageJson(entryPoint = process.argv[1], packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]): string | undefined {
	const packageRootValue = readConfigDirNameFromPackageRoot(packageRoot);
	if (packageRootValue) return packageRootValue;
	if (!entryPoint) return undefined;
	try {
		let dir = path.dirname(fs.realpathSync(entryPoint));
		while (dir !== path.dirname(dir)) {
			const value = readConfigDirNameFromPackageRoot(dir);
			if (value) return value;
			dir = path.dirname(dir);
		}
	} catch {
		// Package metadata lookup is best-effort; detached runners must not fail here.
	}
	return undefined;
}

export function resolveConfigDirName(codingAgentModule?: unknown, entryPoint?: string, packageRoot?: string): string {
	const moduleValue = codingAgentModule && typeof codingAgentModule === "object"
		? validConfigDirName((codingAgentModule as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME)
		: undefined;
	return moduleValue
		?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot)
		?? DEFAULT_CONFIG_DIR_NAME;
}

export function getConfigDirName(): string {
	return resolveConfigDirName();
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName());
}

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured === "~") return os.homedir();
	if (configured?.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
	return configured || path.join(os.homedir(), getConfigDirName(), "agent");
}
