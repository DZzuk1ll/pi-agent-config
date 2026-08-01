import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type FastModeConfig = {
	enabled: boolean;
	models: string[];
	showStatus: boolean;
};

const CONFIG_PATH = join(getAgentDir(), "extensions", "fast-mode", "config.json");
const LEGACY_CONFIG_PATH = join(getAgentDir(), "extensions", "fast-mode.json");
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const DEFAULT_CONFIG: FastModeConfig = {
	enabled: false,
	models: [
		"openai-codex/gpt-5.6-sol",
		"openai-codex/gpt-5.6-terra",
		"openai-codex/gpt-5.6-luna",
	],
	showStatus: true,
};

function readConfig(): FastModeConfig {
	const configPath = existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH;
	if (!existsSync(configPath)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<FastModeConfig>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			models: Array.isArray(raw.models) && raw.models.every((model) => typeof model === "string")
				? raw.models
				: DEFAULT_CONFIG.models,
			showStatus: typeof raw.showStatus === "boolean" ? raw.showStatus : DEFAULT_CONFIG.showStatus,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function modelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export default function fastMode(pi: ExtensionAPI): void {
	let config = DEFAULT_CONFIG;
	let enabled = false;

	const isEligible = (ctx: ExtensionContext): boolean => {
		const key = modelKey(ctx);
		return Boolean(key && config.models.includes(key) && ctx.model && SUPPORTED_APIS.has(ctx.model.api));
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const value = !config.showStatus ? undefined : !enabled ? "OFF" : isEligible(ctx) ? "ON" : "INACTIVE";
		ctx.ui.setStatus("fast-mode", value);
	};

	const notifyState = (ctx: ExtensionContext): void => {
		const model = ctx.model?.name ?? "(none)";
		const message = !enabled
			? `Fast mode is off. Current model: ${model}.`
			: isEligible(ctx)
				? `Fast mode is on for ${model}.`
				: `Fast mode is on, but inactive for ${model}.`;
		ctx.ui.notify(message, "info");
	};

	pi.registerFlag("fast", {
		description: "Start with fast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode (faster, costlier inference) for configured models",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "status") {
				notifyState(ctx);
				return;
			}
			if (command !== "" && command !== "on" && command !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			enabled = command === "" ? !enabled : command === "on";
			updateStatus(ctx);
			notifyState(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = readConfig();
		enabled = pi.getFlag("fast") === true || config.enabled;
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isEligible(ctx) || typeof event.payload !== "object" || event.payload === null) return;
		if (event.payload.model !== ctx.model?.id || "service_tier" in event.payload) return;
		return { ...event.payload, service_tier: "priority" };
	});
}
