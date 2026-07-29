export type ToolGroupingMode = "off" | "consecutive-same-type" | "all-read-only";

export interface ToolGroupingSettings {
	toolGrouping?: unknown;
	readOnlyToolGrouping?: unknown;
}

export interface ToolComponentLike {
	toolName?: unknown;
	toolCallId?: unknown;
	args?: Record<string, unknown>;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	expanded?: boolean;
	render?: (width: number) => string[];
}

export type ToolRenderPlanItem =
	| { kind: "single"; child: ToolComponentLike }
	| { kind: "group"; toolName: string; children: ToolComponentLike[] };

const GROUPABLE_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function resolveToolGrouping(settings: ToolGroupingSettings): ToolGroupingMode {
	if (
		settings.toolGrouping === "off"
		|| settings.toolGrouping === "consecutive-same-type"
		|| settings.toolGrouping === "all-read-only"
	) {
		return settings.toolGrouping;
	}
	if (settings.readOnlyToolGrouping === false) return "off";
	if (settings.readOnlyToolGrouping === true) return "all-read-only";
	return "consecutive-same-type";
}

export function isToolComponent(value: unknown): value is ToolComponentLike {
	if (!value || typeof value !== "object") return false;
	const component = value as ToolComponentLike;
	return typeof component.toolName === "string" && typeof component.toolCallId === "string";
}

function isGroupableReadOnlyTool(value: unknown): value is ToolComponentLike {
	if (!isToolComponent(value)) return false;
	if (!GROUPABLE_READ_ONLY_TOOLS.has(value.toolName as string)) return false;
	if (value.expanded === true || value.result?.isError === true) return false;
	return !value.result?.content?.some((block) => block.type === "image");
}

export function planToolGroups(
	children: readonly ToolComponentLike[],
	mode: ToolGroupingMode,
	isTransparent: (child: ToolComponentLike) => boolean = () => false,
): ToolRenderPlanItem[] {
	const plan: ToolRenderPlanItem[] = [];
	let pending: ToolComponentLike[] = [];

	const flush = () => {
		if (pending.length > 1) {
			plan.push({
				kind: "group",
				toolName: mode === "consecutive-same-type"
					? pending[0]!.toolName as string
					: "read-only",
				children: pending,
			});
		} else if (pending.length === 1) {
			plan.push({ kind: "single", child: pending[0]! });
		}
		pending = [];
	};

	for (const child of children) {
		if (!isToolComponent(child) && isTransparent(child)) continue;
		if (mode === "off" || !isGroupableReadOnlyTool(child)) {
			flush();
			plan.push({ kind: "single", child });
			continue;
		}
		if (
			mode === "consecutive-same-type"
			&& pending.length > 0
			&& pending[0]!.toolName !== child.toolName
		) {
			flush();
		}
		pending.push(child);
	}
	flush();
	return plan;
}

function summarize(value: unknown, limit = 60): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function targetForTool(child: ToolComponentLike, includeToolName: boolean): string {
	const name = child.toolName as string;
	const args = child.args ?? {};
	let target: string;
	if (name === "read") {
		target = String(args.path ?? "");
		const range = [
			args.offset === undefined ? "" : `offset=${args.offset}`,
			args.limit === undefined ? "" : `limit=${args.limit}`,
		].filter(Boolean);
		if (range.length > 0) target += ` (${range.join(", ")})`;
	} else if (name === "grep" || name === "find") {
		target = `"${summarize(args.pattern, 40)}"`;
		if (args.path) target += ` in ${args.path}`;
	} else {
		target = String(args.path ?? ".");
	}
	return includeToolName ? `${displayToolName(name)} ${target}` : target;
}

function displayToolName(name: string): string {
	if (name === "ls") return "LS";
	return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function groupNoun(name: string, count: number): string {
	const noun = name === "read"
		? "file"
		: name === "grep" || name === "find"
			? "pattern"
			: name === "ls"
				? "path"
				: "call";
	return `${noun}${count === 1 ? "" : "s"}`;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	const chars = Array.from(line);
	return chars.length <= width ? line : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_SGR_PREFIX_RE = /^(?:\x1b\[[0-9;]*m)*/;

export function formatDoneLineSpacing(lines: readonly string[]): string[] {
	const formatted: string[] = [];
	for (const line of lines) {
		const plain = line.replace(ANSI_SGR_RE, "");
		if (!plain.trimStart().startsWith("Done in ")) {
			formatted.push(line);
			continue;
		}
		if (formatted.length > 0 && formatted.at(-1)!.replace(ANSI_SGR_RE, "").trim()) {
			formatted.push("");
		}
		const ansiPrefix = line.match(ANSI_SGR_PREFIX_RE)?.[0] ?? "";
		formatted.push(`${ansiPrefix}  ${line.slice(ansiPrefix.length).trimStart()}`);
	}
	return formatted;
}

export function renderToolGroup(group: Extract<ToolRenderPlanItem, { kind: "group" }>, width: number): string[] {
	const count = group.children.length;
	const mixed = group.toolName === "read-only";
	const title = mixed
		? `Read-only ${count} calls`
		: `${displayToolName(group.toolName)} ${count} ${groupNoun(group.toolName, count)}`;
	return [
		"",
		fitLine(`⏺ ${title} (ctrl+o to expand)`, width),
		...group.children.map((child) =>
			fitLine(`  ⎿ ${targetForTool(child, mixed)}`, width),
		),
	];
}

export function renderPlannedChildren(
	children: readonly ToolComponentLike[],
	mode: ToolGroupingMode,
	width: number,
	isTransparent: (child: ToolComponentLike) => boolean = () => false,
): string[] {
	const lines: string[] = [];
	let previousWasTool = false;
	for (const item of planToolGroups(children, mode, isTransparent)) {
		const currentIsTool = item.kind === "group" || isToolComponent(item.child);
		const rendered = item.kind === "group"
			? renderToolGroup(item, width)
			: typeof item.child.render === "function"
				? item.child.render(width)
				: [];
		if (rendered.length === 0) continue;
		if (previousWasTool && !currentIsTool && lines.at(-1)?.trim()) lines.push("");
		lines.push(...rendered);
		previousWasTool = currentIsTool;
	}
	return lines;
}
