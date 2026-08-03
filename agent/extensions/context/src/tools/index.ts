import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { register_context_export_tool } from './export.js';
import { register_context_get_tool } from './get.js';
import { register_context_search_tool } from './search.js';

export function register_context_tools(pi: ExtensionAPI): void {
	register_context_search_tool(pi);
	register_context_get_tool(pi);
	register_context_export_tool(pi);
}
