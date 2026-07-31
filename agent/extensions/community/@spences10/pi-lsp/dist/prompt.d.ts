import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';
export declare const LSP_TOOL_NAMES: Set<string>;
export declare const LSP_SYSTEM_PROMPT = "\n\n## Language server support via LSP tools\n\nYou have access to Language Server Protocol tools for diagnostics, hover/type information, definitions, references, and document symbols. Use them when:\n- Debugging TypeScript, JavaScript, Svelte, or other language-server-supported errors\n- Checking types, symbol definitions, or API documentation from code\n- Finding references more precisely than text search\n- Validating focused code changes before reporting completion\n\nAfter editing language-server-supported files, check changed files with LSP diagnostics before reporting completion or committing. Prefer lsp_diagnostics_many for batches: use git to identify changed files, filter to supported source files, then run diagnostics on that list.\n\nPrefer LSP diagnostics over guessing from build output when a file-level check is enough. Use text search for broad discovery, then LSP tools for precise type and symbol questions.";
export declare function should_inject_lsp_prompt(event: {
    systemPromptOptions?: Pick<BeforeAgentStartEvent['systemPromptOptions'], 'selectedTools'>;
}): boolean;
export declare function append_lsp_system_prompt(system_prompt: string): string;
