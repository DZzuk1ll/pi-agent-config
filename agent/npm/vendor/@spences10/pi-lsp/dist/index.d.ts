import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type CreateLspServerManagerOptions } from './server-manager.js';
export { should_inject_lsp_prompt } from './prompt.js';
export type { LspClientLike } from './server-manager.js';
export interface CreateLspExtensionOptions extends CreateLspServerManagerOptions {
}
export declare function create_lsp_extension(options?: CreateLspExtensionOptions): (pi: ExtensionAPI) => Promise<void>;
declare const _default: (pi: ExtensionAPI) => Promise<void>;
export default _default;
