import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { CLI_TOOL_CATEGORIES } from "./catalog.ts";
import {
	findCliToolCategory,
	scanAvailableCliTools,
	searchAvailableCliTools,
	type AvailableCliTool,
} from "./inventory.ts";

export interface CliToolsParams {
	action?: "overview" | "category" | "search";
	category?: string;
	query?: string;
}

export interface CliToolsResponse {
	text: string;
	tools: string[];
	categories: string[];
}

const EMPTY_RESPONSE: CliToolsResponse = {
	text: "[tools]",
	tools: [],
	categories: [],
};

function safeInline(value: string): string {
	return sanitizeForDisplay(value).replace(/[\r\n\t]+/g, " ").trim();
}

function overviewResponse(tools: readonly AvailableCliTool[]): CliToolsResponse {
	if (tools.length === 0) return EMPTY_RESPONSE;

	const defaultNames = tools
		.filter((tool) => tool.entry.defaultDisclosure)
		.map((tool) => tool.entry.name);
	const additionalTools = tools.filter((tool) => !tool.entry.defaultDisclosure);
	const categoryCounts = CLI_TOOL_CATEGORIES
		.map((category) => ({
			id: category.id,
			count: additionalTools.filter((tool) => tool.entry.category === category.id).length,
		}))
		.filter((category) => category.count > 0);
	const categories = categoryCounts.map((category) => category.id);
	const sections: string[] = [];
	if (defaultNames.length > 0) sections.push(`[default]\n${defaultNames.join(", ")}`);
	if (categoryCounts.length > 0) {
		sections.push(`[categories]\n${categoryCounts.map((category) => `${category.id}: ${category.count}`).join("\n")}`);
	}

	return {
		text: sections.join("\n\n"),
		tools: defaultNames,
		categories,
	};
}

function categoryResponse(tools: readonly AvailableCliTool[], value: string): CliToolsResponse {
	const category = findCliToolCategory(value);
	if (!category) return EMPTY_RESPONSE;
	const names = tools
		.filter((tool) => !tool.entry.defaultDisclosure && tool.entry.category === category.id)
		.map((tool) => tool.entry.name);
	return names.length > 0
		? { text: `[category: ${category.id}]\n${names.join(", ")}`, tools: names, categories: [category.id] }
		: EMPTY_RESPONSE;
}

function searchResponse(tools: readonly AvailableCliTool[], query: string): CliToolsResponse {
	const names = searchAvailableCliTools(tools, query).map((tool) => tool.entry.name);
	return names.length > 0
		? { text: `[search: ${safeInline(query)}]\n${names.join(", ")}`, tools: names, categories: [] }
		: EMPTY_RESPONSE;
}

export function queryCliTools(
	params: CliToolsParams,
	tools: readonly AvailableCliTool[] = scanAvailableCliTools(),
): CliToolsResponse {
	const action = params.action ?? "overview";
	switch (action) {
		case "overview":
			return overviewResponse(tools);
		case "category":
			if (!params.category?.trim()) throw new Error("category is required when action is category.");
			return categoryResponse(tools, params.category);
		case "search":
			if (!params.query?.trim()) throw new Error("query is required when action is search.");
			return searchResponse(tools, params.query);
	}
}
