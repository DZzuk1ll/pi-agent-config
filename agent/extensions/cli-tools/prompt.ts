import type { AvailableCliTool } from "./inventory.ts";

export interface CliToolsPrompt {
	promptSnippet: string;
	promptGuidelines: string[];
	tools: AvailableCliTool[];
}

export function buildCliToolsPrompt(tools: readonly AvailableCliTool[]): CliToolsPrompt | undefined {
	const developmentTools = tools.filter((tool) => tool.entry.bashCapability);
	if (developmentTools.length === 0) return undefined;

	const capabilities = developmentTools
		.map((tool) => `${tool.entry.name} (${tool.entry.bashCapability})`)
		.join(", ");

	return {
		promptSnippet: "Inspect installed development CLI capabilities available through bash when an additional or unclear capability must be discovered.",
		promptGuidelines: [
			`Bash has these installed development CLI capabilities: ${capabilities}.`,
			"Prefer these specialist CLIs over ad-hoc shell pipelines when they materially improve correctness, safety, or clarity; use the repository's existing scripts and task runners when available.",
			"Do not assume an unlisted CLI is installed; use cli_tools when an additional development capability must be discovered.",
		],
		tools: developmentTools,
	};
}
