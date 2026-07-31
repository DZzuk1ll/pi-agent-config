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
	text: "No available CLI tools.",
	tools: [],
	categories: [],
};

function overviewResponse(tools: readonly AvailableCliTool[]): CliToolsResponse {
	if (tools.length === 0) return EMPTY_RESPONSE;

	const defaultTools = tools.filter((tool) => tool.entry.defaultDisclosure);
	const additionalTools = tools.filter((tool) => !tool.entry.defaultDisclosure);
	const categories = CLI_TOOL_CATEGORIES
		.filter((category) => additionalTools.some((tool) => tool.entry.category === category.id))
		.map((category) => category.id);
	const names = defaultTools.map((tool) => tool.entry.name);
	const sections: string[] = [];
	if (names.length > 0) sections.push(`Default\n${names.join("\n")}`);
	if (categories.length > 0) sections.push(`Additional categories\n${categories.join("\n")}`);

	return {
		text: sections.join("\n\n"),
		tools: names,
		categories,
	};
}

function categoryResponse(tools: readonly AvailableCliTool[], value: string): CliToolsResponse {
	const category = findCliToolCategory(value);
	if (!category) return EMPTY_RESPONSE;
	const names = tools
		.filter((tool) => tool.entry.category === category.id)
		.map((tool) => tool.entry.name);
	return names.length > 0
		? { text: names.join("\n"), tools: names, categories: [category.id] }
		: EMPTY_RESPONSE;
}

function searchResponse(tools: readonly AvailableCliTool[], query: string): CliToolsResponse {
	const names = searchAvailableCliTools(tools, query).map((tool) => tool.entry.name);
	return names.length > 0
		? { text: names.join("\n"), tools: names, categories: [] }
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
