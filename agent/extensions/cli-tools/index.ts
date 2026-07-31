import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { sanitizeForDisplay } from "../shared/text.ts";
import { queryCliTools } from "./query.ts";

const CliToolsParams = Type.Object({
	action: Type.Optional(Type.Union([
		Type.Literal("overview"),
		Type.Literal("category"),
		Type.Literal("search"),
		Type.Literal("details"),
	], { default: "overview", description: "Inventory view to return. Omit for the progressively disclosed overview." })),
	category: Type.Optional(Type.String({ maxLength: 120, description: "Category id or label returned by overview." })),
	query: Type.Optional(Type.String({ maxLength: 240, description: "Name, category, capability, or keyword to filter available catalog entries." })),
	name: Type.Optional(Type.String({ maxLength: 120, description: "Catalog name or detected command name for one available tool." })),
});

function safeInline(value: string): string {
	return sanitizeForDisplay(value).replace(/[\r\n\t]+/g, " ").trim();
}

export default function cliTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "cli_tools",
		label: "CLI Tools",
		description: "Inspect a curated, progressively disclosed inventory of command-line tools that are currently available on this system. Unavailable catalog entries are never returned.",
		parameters: CliToolsParams,
		async execute(_id, params) {
			const response = queryCliTools(params);
			return {
				content: [{ type: "text", text: response.text }],
				details: response,
			};
		},
		renderCall(args, theme) {
			const action = args.action ?? "overview";
			const target = args.category ?? args.query ?? args.name;
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
