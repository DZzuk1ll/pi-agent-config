import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

export const LSP_TOOL_NAMES = new Set([
	'lsp_diagnostics_many',
	'lsp_hover',
	'lsp_definition',
	'lsp_references',
]);

export const LSP_SYSTEM_PROMPT = `

## Language server support via LSP tools

You have access to Language Server Protocol tools for diagnostics, hover/type information, definitions, and references. Use them when:
- Debugging TypeScript, JavaScript, Svelte, or other language-server-supported errors
- Checking types, symbol definitions, or API documentation from code
- Finding references more precisely than text search
- Validating focused code changes before reporting completion

After editing language-server-supported files, check changed files with lsp_diagnostics_many before reporting completion or committing. Pass one file for a focused check or use git to identify multiple changed files for a batch.

Prefer LSP diagnostics over guessing from build output when a file-level check is enough. Use text search for broad discovery, then LSP tools for precise type and symbol questions.`;

export function should_inject_lsp_prompt(event: {
	systemPromptOptions?: Pick<
		BeforeAgentStartEvent['systemPromptOptions'],
		'selectedTools'
	>;
}): boolean {
	const selected_tools = event.systemPromptOptions?.selectedTools;
	return (
		!selected_tools ||
		selected_tools.some((tool) => LSP_TOOL_NAMES.has(tool))
	);
}

export function append_lsp_system_prompt(
	system_prompt: string,
): string {
	return system_prompt + LSP_SYSTEM_PROMPT;
}
