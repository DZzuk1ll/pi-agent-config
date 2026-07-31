import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
export interface ShellInvocation {
    command: string;
    args: string[];
}
export declare function extract_shell_invocations(command: string): ShellInvocation[];
export declare function extract_command_paths(command: string, command_name_to_find: 'rm' | 'git-rm'): string[] | undefined;
export declare function extract_overwrite_paths(command: string): string[];
export declare function extract_bash_create_paths(command: string, cwd: string): string[];
export declare function command_may_create_temp_path(command: string): boolean;
export declare function extract_created_temp_paths_from_result(event: ToolResultEvent): string[];
