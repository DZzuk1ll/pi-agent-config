import type { GitRecoverability } from './types.js';
export declare function git(args: string[], cwd: string): string | undefined;
export declare function get_git_recoverability(cwd: string, path: string): GitRecoverability;
export declare function is_git_recoverable(cwd: string, path: string): boolean;
