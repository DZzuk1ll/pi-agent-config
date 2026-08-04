import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
type Labels = {
	path: string;
	branch: string;
	context: string;
	model: string;
	thinking: string;
	tokens: string;
	cache: string;
	cost: string;
	subscription: string;
	history: string;
	plan: string;
	fast: string;
};

type StatuslineConfig = {
	contextBarWidth: number;
	separator: string;
	showPath: boolean;
	showGitBranch: boolean;
	showTokens: boolean;
	showCacheHitRate: boolean;
	showCost: boolean;
	showExtensionStatuses: boolean;
	hiddenExtensionStatuses: string[];
	hideSubscriptionAccount: boolean;
	labels: Labels;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "extensions", "statusline", "config.json");
const LEGACY_CONFIG_PATH = join(AGENT_DIR, "extensions", "statusline.json");
const WIDGET_KEY = "custom-statusline";
const PADDING_X = 2;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const DEFAULT_CONFIG: StatuslineConfig = {
	contextBarWidth: 24,
	separator: "  │  ",
	showPath: true,
	showGitBranch: true,
	showTokens: true,
	showCacheHitRate: true,
	showCost: true,
	showExtensionStatuses: true,
	hiddenExtensionStatuses: [],
	hideSubscriptionAccount: false,
	labels: {
		path: "PROJECT",
		branch: "GIT",
		context: "CTX",
		model: "MODEL",
		thinking: "THINK",
		tokens: "TOKENS",
		cache: "CACHE",
		cost: "COST",
		subscription: "SUB",
		history: "HISTORY",
		plan: "PLAN",
		fast: "FAST",
	},
};

function cleanText(value: unknown, fallback = ""): string {
	return typeof value === "string"
		? value.replace(ANSI_RE, "").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim()
		: fallback;
}

function cleanSeparator(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_CONFIG.separator;
	const cleaned = value.replace(ANSI_RE, "").replace(CONTROL_RE, "");
	return cleaned.length > 0 && cleaned.length <= 12 ? cleaned : DEFAULT_CONFIG.separator;
}

function readConfig(): StatuslineConfig {
	const configPath = existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH;
	if (!existsSync(configPath)) return DEFAULT_CONFIG;
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_CONFIG;
		const raw = parsed as Record<string, unknown>;
		const rawLabels = raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)
			? raw.labels as Record<string, unknown>
			: undefined;
		const labels = rawLabels
			? Object.fromEntries(
				Object.entries(DEFAULT_CONFIG.labels).map(([key, value]) => [
					key,
					cleanText(rawLabels[key], value) || value,
				]),
			) as Labels
			: DEFAULT_CONFIG.labels;
		return {
			contextBarWidth: Math.max(
				8,
				Math.min(48, typeof raw.contextBarWidth === "number" && Number.isFinite(raw.contextBarWidth) ? Math.floor(raw.contextBarWidth) : 24),
			),
			separator: cleanSeparator(raw.separator),
			showPath: typeof raw.showPath === "boolean" ? raw.showPath : DEFAULT_CONFIG.showPath,
			showGitBranch: typeof raw.showGitBranch === "boolean" ? raw.showGitBranch : DEFAULT_CONFIG.showGitBranch,
			showTokens: typeof raw.showTokens === "boolean" ? raw.showTokens : DEFAULT_CONFIG.showTokens,
			showCacheHitRate: typeof raw.showCacheHitRate === "boolean" ? raw.showCacheHitRate : DEFAULT_CONFIG.showCacheHitRate,
			showCost: typeof raw.showCost === "boolean" ? raw.showCost : DEFAULT_CONFIG.showCost,
			showExtensionStatuses: typeof raw.showExtensionStatuses === "boolean" ? raw.showExtensionStatuses : DEFAULT_CONFIG.showExtensionStatuses,
			hiddenExtensionStatuses: Array.isArray(raw.hiddenExtensionStatuses)
				? raw.hiddenExtensionStatuses.map((key) => cleanText(key)).filter(Boolean)
				: [],
			hideSubscriptionAccount: typeof raw.hideSubscriptionAccount === "boolean" ? raw.hideSubscriptionAccount : DEFAULT_CONFIG.hideSubscriptionAccount,
			labels,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatPath(cwd: string): string {
	const home = homedir();
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const fromHome = relative(resolvedHome, resolvedCwd);
	const insideHome = fromHome === ""
		|| (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
	return insideHome ? (fromHome ? `~${sep}${fromHome}` : "~") : cwd;
}

function collectUsage(entries: readonly unknown[]): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate?: number;
} {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHitRate: number | undefined;

	const add = (usage: UsageLike | undefined): void => {
		if (!usage) return;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	};

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const message = record.message && typeof record.message === "object"
			? record.message as Record<string, unknown>
			: undefined;
		if (record.type === "message" && message?.role === "assistant") {
			const usage = message.usage as UsageLike | undefined;
			add(usage);
			const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
			if (promptTokens > 0) cacheHitRate = ((usage?.cacheRead ?? 0) / promptTokens) * 100;
		} else if (record.type === "message" && message?.role === "toolResult") {
			add(message.usage as UsageLike | undefined);
		} else if (record.type === "branch_summary" || record.type === "compaction") {
			add(record.usage as UsageLike | undefined);
		}
	}

	return { ...totals, ...(cacheHitRate === undefined ? {} : { cacheHitRate }) };
}

function contextColor(percent: number | null | undefined): "success" | "warning" | "error" {
	if ((percent ?? 0) > 90) return "error";
	if ((percent ?? 0) > 70) return "warning";
	return "success";
}

function statusColor(key: string, value: string): "text" | "muted" | "success" | "warning" | "error" {
	if (key === "rewind") return "muted";
	if (key === "plan-mode") return "warning";
	if (key.includes("fast")) {
		if (/inactive/i.test(value)) return "warning";
		if (/off/i.test(value)) return "muted";
		return "success";
	}
	if (key === "pi-sub") {
		if (/unavailable|timed out|failed|error/i.test(value)) return "warning";
		const remaining = [...value.matchAll(/\b[RW]:(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
		const minimum = remaining.length ? Math.min(...remaining) : 100;
		if (minimum <= 10) return "error";
		if (minimum <= 20) return "warning";
		return "success";
	}
	return "text";
}

function statusLabel(key: string, labels: Labels): string {
	if (key === "pi-sub") return labels.subscription;
	if (key === "rewind") return labels.history;
	if (key === "plan-mode") return labels.plan;
	if (key.includes("fast")) return labels.fast;
	return cleanText(key).toUpperCase();
}

function progressBar(percent: number | null | undefined, width: number): string {
	const normalized = Math.max(0, Math.min(100, percent ?? 0));
	const filled = normalized > 0 ? Math.max(1, Math.round((normalized / 100) * width)) : 0;
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export default function statusline(pi: ExtensionAPI): void {
	pi.registerCommand("statusline", {
		description: "Show the custom statusline configuration path",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Edit ${CONFIG_PATH}, then run /reload`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const config = readConfig();
		const hiddenExtensionStatuses = new Set(config.hiddenExtensionStatuses);

		ctx.ui.setFooter((_footerTui, _footerTheme, footerData) => {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
				const label = (text: string): string => theme.bold(theme.fg("accent", text));
				const section = (
					name: string,
					value: string,
					color: "text" | "muted" | "success" | "warning" | "error" = "text",
				): string => `${label(name)} ${theme.fg(color, value)}`;
				const fitSections = (sections: string[], width: number): string =>
					truncateToWidth(sections.join(theme.fg("dim", config.separator)), width, theme.fg("dim", "…"));
				const fits = (sections: string[], width: number): boolean =>
					visibleWidth(sections.join(config.separator)) <= width;

				return {
					dispose: unsubscribe,
					invalidate() {},
					render(width: number): string[] {
					const contentWidth = Math.max(1, width - PADDING_X);
					const usage = collectUsage(ctx.sessionManager.getEntries());
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextTokens = context?.tokens;
					const contextPercent = context?.percent;
					const percentText = contextPercent === null || contextPercent === undefined
						? "?"
						: `${contextPercent.toFixed(1)}%`;
					const barWidth = contentWidth < 100
						? Math.min(config.contextBarWidth, 12)
						: config.contextBarWidth;
					const contextText = [
						progressBar(contextPercent, barWidth),
						percentText,
						`${contextTokens === null || contextTokens === undefined ? "?" : formatTokens(contextTokens)}/${formatTokens(contextWindow)}`,
						"auto",
					].join(" ");

					const projectLine: string[] = [];
					if (config.showPath) {
						projectLine.push(section(config.labels.path, formatPath(ctx.cwd)));
						const branch = footerData.getGitBranch();
						if (config.showGitBranch && branch) {
							projectLine.push(section(config.labels.branch, branch, "success"));
						}
					}

					const model = ctx.model?.id ?? "no-model";
					const modelLine = [
						section(config.labels.context, contextText, contextColor(contextPercent)),
						section(config.labels.model, model),
					];
					if (ctx.model?.reasoning) {
						modelLine.push(section(config.labels.thinking, ctx.thinkingLevel ?? "off", "warning"));
					}

					const detailLine: string[] = [];
					if (config.showTokens) {
						const tokenParts = [
							`↑${formatTokens(usage.input)}`,
							`↓${formatTokens(usage.output)}`,
							`R${formatTokens(usage.cacheRead)}`,
						];
						if (usage.cacheWrite > 0) tokenParts.push(`W${formatTokens(usage.cacheWrite)}`);
						detailLine.push(section(config.labels.tokens, tokenParts.join(" "), "muted"));
					}
					if (config.showCacheHitRate && usage.cacheHitRate !== undefined) {
						detailLine.push(section(config.labels.cache, `${usage.cacheHitRate.toFixed(1)}%`, "success"));
					}
					if (config.showCost) {
						const subscription = ctx.model?.provider === "openai-codex" || ctx.model?.provider === "kimi-coding";
						detailLine.push(
							section(config.labels.cost, `$${usage.cost.toFixed(3)}${subscription ? " sub" : ""}`, "muted"),
						);
					}

					const statusLine: string[] = [];
					if (config.showExtensionStatuses) {
						const statuses = [...footerData.getExtensionStatuses().entries()]
							.sort(([left], [right]) => {
								const order = ["fast-mode", "pi-sub", "plan-mode", "rewind"];
								const leftIndex = order.indexOf(left);
								const rightIndex = order.indexOf(right);
								return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex)
									|| left.localeCompare(right);
							});
						for (const [key, rawValue] of statuses) {
							if (hiddenExtensionStatuses.has(key)) continue;
							let value = cleanText(rawValue).replace(/^◆\s*/, "");
							if (key === "pi-sub" && config.hideSubscriptionAccount) {
								value = value.replace(/\s*\([^()@\s]+@[^()\s]+\)\s*/g, " ").replace(/\s+/g, " ").trim();
							}
							if (!value) continue;
							statusLine.push(section(statusLabel(key, config.labels), value, statusColor(key, value)));
						}
					}

					const compactTop = [...projectLine, ...statusLine];
					const compactBottom = [...modelLine, ...detailLine];
					if (fits(compactTop, contentWidth) && fits(compactBottom, contentWidth)) {
							return [fitSections(compactTop, contentWidth), fitSections(compactBottom, contentWidth)]
							.map((line) => `${" ".repeat(PADDING_X)}${line}`);
					}

					return [
							...(projectLine.length ? [fitSections(projectLine, contentWidth)] : []),
							fitSections(modelLine, contentWidth),
							...(detailLine.length || statusLine.length ? [fitSections([...detailLine, ...statusLine], contentWidth)] : []),
					].map((line) => `${" ".repeat(PADDING_X)}${line}`);
					},
				};
			}, { placement: "belowEditor" });

			return {
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});
	});
}
