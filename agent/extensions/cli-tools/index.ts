import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { scanAvailableCliTools } from "./inventory.ts";
import { buildCliToolsPrompt } from "./prompt.ts";
import { queryCliTools } from "./query.ts";

const CliToolsParams = Type.Object({
	action: Type.Optional(Type.Union([
		Type.Literal("overview"),
		Type.Literal("category"),
		Type.Literal("search"),
	], { default: "overview", description: "Inventory view to return. Omit for the progressively disclosed overview." })),
	category: Type.Optional(Type.String({ maxLength: 120, description: "Category id or label returned by overview." })),
	query: Type.Optional(Type.String({ maxLength: 240, description: "Name, category, capability, or keyword to filter available catalog entries." })),
});

function safeInline(value: string): string {
	return sanitizeForDisplay(value).replace(/[\r\n\t]+/g, " ").trim();
}

export default function cliTools(pi: ExtensionAPI): void {
	const prompt = buildCliToolsPrompt(scanAvailableCliTools());
	if (!prompt) return;

	pi.registerTool({
		name: "cli_tools",
		label: "CLI Tools",
		description: "Inspect a curated, progressively disclosed inventory of development command-line tools that are currently available through bash. Unavailable catalog entries are never returned.",
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: prompt.promptGuidelines,
		parameters: CliToolsParams,
		async execute(_id, params) {
			const response = queryCliTools(params, prompt.tools);
			return {
				content: [{ type: "text", text: response.text }],
				details: response,
			};
		},
		renderCall(args, theme) {
			const action = args.action ?? "overview";
			const target = args.category ?? args.query;
			const suffix = target ? ` ${safeInline(target)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("cli_tools "))}${theme.fg("accent", `${action}${suffix}`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});
}
