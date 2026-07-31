import { sanitizeForDisplay } from "../shared/text.ts";
import { CLI_TOOL_CATEGORIES, type CliToolCategory } from "./catalog.ts";
import {
	extractCliToolVersion,
	findAvailableCliTool,
	findCliToolCategory,
	scanAvailableCliTools,
	searchAvailableCliTools,
	type AvailableCliTool,
} from "./inventory.ts";

export interface CliToolsParams {
	action?: "overview" | "category" | "search" | "details";
	category?: string;
	query?: string;
	name?: string;
}

export interface CliToolFact {
	name: string;
	command: string;
	path: string;
	category: string;
	description: string;
	version?: string;
}

export interface CliToolCategoryFact {
	id: string;
	label: string;
	description: string;
	availableCount: number;
}

export interface CliToolsResponse {
	text: string;
	tools: CliToolFact[];
	categories: CliToolCategoryFact[];
}

function safeInline(value: string): string {
	return sanitizeForDisplay(value).replace(/[\r\n\t]+/g, " ").trim();
}

function categoryFor(tool: AvailableCliTool): CliToolCategory {
	const category = CLI_TOOL_CATEGORIES.find((candidate) => candidate.id === tool.entry.category);
	if (!category) throw new Error(`Unknown CLI tool category: ${tool.entry.category}`);
	return category;
}

function toToolFact(tool: AvailableCliTool, includeVersion = false): CliToolFact {
	const category = categoryFor(tool);
	const version = includeVersion ? extractCliToolVersion(tool) : undefined;
	return {
		name: tool.entry.name,
		command: tool.command,
		path: tool.path,
		category: category.id,
		description: tool.entry.description,
		...(version ? { version } : {}),
	};
}

function formatCompactTool(tool: AvailableCliTool): string {
	return `- ${safeInline(tool.entry.name)} — ${safeInline(tool.entry.description)}\n  path: ${safeInline(tool.path)}`;
}

function unavailableResponse(message: string): CliToolsResponse {
	return { text: message, tools: [], categories: [] };
}

function overviewResponse(tools: readonly AvailableCliTool[]): CliToolsResponse {
	if (tools.length === 0) return unavailableResponse("No cataloged CLI tools are currently available.");

	const defaultTools = tools.filter((tool) => tool.entry.defaultDisclosure);
	const additionalTools = tools.filter((tool) => !tool.entry.defaultDisclosure);
	const categories = CLI_TOOL_CATEGORIES
		.map((category) => ({
			category,
			availableCount: additionalTools.filter((tool) => tool.entry.category === category.id).length,
		}))
		.filter(({ availableCount }) => availableCount > 0);
	const sections = ["CLI tools available on this system"];
	if (defaultTools.length > 0) {
		sections.push(`Default\n${defaultTools.map(formatCompactTool).join("\n")}`);
	}
	if (categories.length > 0) {
		sections.push(`Additional categories\n${categories.map(({ category, availableCount }) =>
			`- ${safeInline(category.label)} (${category.id}): ${availableCount} available — ${safeInline(category.description)}`
		).join("\n")}`);
	}

	return {
		text: sections.join("\n\n"),
		tools: defaultTools.map((tool) => toToolFact(tool)),
		categories: categories.map(({ category, availableCount }) => ({
			id: category.id,
			label: category.label,
			description: category.description,
			availableCount,
		})),
	};
}

function categoryResponse(tools: readonly AvailableCliTool[], value: string): CliToolsResponse {
	const category = findCliToolCategory(value);
	const matches = category ? tools.filter((tool) => tool.entry.category === category.id) : [];
	if (!category || matches.length === 0) {
		return unavailableResponse(`No available CLI tools found for category "${safeInline(value)}".`);
	}
	return {
		text: `Category: ${safeInline(category.label)} (${category.id})\n\n${matches.map(formatCompactTool).join("\n")}`,
		tools: matches.map((tool) => toToolFact(tool)),
		categories: [{
			id: category.id,
			label: category.label,
			description: category.description,
			availableCount: matches.length,
		}],
	};
}

function searchResponse(tools: readonly AvailableCliTool[], query: string): CliToolsResponse {
	const matches = searchAvailableCliTools(tools, query);
	if (matches.length === 0) {
		return unavailableResponse(`No available CLI tools matched "${safeInline(query)}".`);
	}
	return {
		text: `${matches.length} available CLI tool${matches.length === 1 ? "" : "s"} matched "${safeInline(query)}"\n\n${matches.map(formatCompactTool).join("\n")}`,
		tools: matches.map((tool) => toToolFact(tool)),
		categories: [],
	};
}

function detailsResponse(tools: readonly AvailableCliTool[], name: string): CliToolsResponse {
	const tool = findAvailableCliTool(tools, name);
	if (!tool) return unavailableResponse(`No available CLI tool matched "${safeInline(name)}".`);
	const fact = toToolFact(tool, true);
	const category = categoryFor(tool);
	const lines = [
		`name: ${safeInline(fact.name)}`,
		`command: ${safeInline(fact.command)}`,
		`path: ${safeInline(fact.path)}`,
		...(fact.version ? [`version: ${safeInline(fact.version)}`] : []),
		`category: ${safeInline(category.label)} (${category.id})`,
		`description: ${safeInline(fact.description)}`,
	];
	return {
		text: lines.join("\n"),
		tools: [fact],
		categories: [{
			id: category.id,
			label: category.label,
			description: category.description,
			availableCount: 1,
		}],
	};
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
		case "details":
			if (!params.name?.trim()) throw new Error("name is required when action is details.");
			return detailsResponse(tools, params.name);
	}
}
