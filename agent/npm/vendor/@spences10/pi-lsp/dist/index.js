import { register_lsp_command } from './commands.js';
import { append_lsp_system_prompt, should_inject_lsp_prompt, } from './prompt.js';
import { LspServerManager, } from './server-manager.js';
import { register_lsp_tools } from './tools.js';
export { should_inject_lsp_prompt } from './prompt.js';
export function create_lsp_extension(options = {}) {
    return async function lsp(pi) {
        const manager = new LspServerManager(options);
        register_lsp_tools(pi, manager);
        pi.on('before_agent_start', async (event) => {
            if (!should_inject_lsp_prompt(event))
                return {};
            return {
                systemPrompt: append_lsp_system_prompt(event.systemPrompt),
            };
        });
        register_lsp_command(pi, manager);
        pi.on('session_shutdown', async () => {
            await manager.clear_language_state();
        });
    };
}
export default create_lsp_extension();
//# sourceMappingURL=index.js.map