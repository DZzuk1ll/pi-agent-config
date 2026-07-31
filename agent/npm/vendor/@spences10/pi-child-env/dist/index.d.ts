export type ChildEnvProfile = 'mcp' | 'lsp' | 'hooks' | 'team-mode';
export interface PiSessionMetadata {
    session_id?: string;
    session_file?: string;
    provider?: string;
    model?: string;
    reasoning_level?: string;
}
export interface CreateChildProcessEnvOptions {
    profile?: ChildEnvProfile;
    explicit_env?: Record<string, string | undefined>;
    source_env?: NodeJS.ProcessEnv;
    extra_allowed_keys?: readonly string[];
    extra_allowlist_env_keys?: readonly string[];
}
export declare function create_pi_session_env(metadata: PiSessionMetadata): Record<string, string>;
export declare function create_child_process_env(options?: CreateChildProcessEnvOptions): NodeJS.ProcessEnv;
