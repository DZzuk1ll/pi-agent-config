import { type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { LspServerManager } from './server-manager.js';
export declare function register_lsp_command(pi: ExtensionAPI, manager: LspServerManager): void;
export declare function handle_lsp_command(args: string, ctx: ExtensionCommandContext, manager: LspServerManager): Promise<void>;
