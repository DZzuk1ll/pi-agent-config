export interface LspServerConfig {
    language: string;
    command: string;
    args: string[];
    install_hint?: string;
    is_project_local?: boolean;
}
export declare function detect_language(file_path: string): string | undefined;
export declare function list_supported_languages(): string[];
export interface ResolvedServerCommand {
    command: string;
    is_project_local: boolean;
}
export declare function resolve_server_command_info(command: string, cwd?: string): ResolvedServerCommand;
export declare function resolve_server_command(command: string, cwd?: string): string;
export declare function get_server_config(language: string, cwd?: string): LspServerConfig | undefined;
export declare function language_id_for_file(file_path: string): string | undefined;
export declare function find_workspace_root(file_path: string, fallback?: string): string;
