import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { DestructiveAction } from './types.js';
export declare function assess_bash_command(command: string, cwd?: string, session_created_paths?: ReadonlySet<string>): DestructiveAction | undefined;
export declare function assess_tool_call(event: ToolCallEvent, cwd: string, session_created_paths?: ReadonlySet<string>): DestructiveAction | undefined;
