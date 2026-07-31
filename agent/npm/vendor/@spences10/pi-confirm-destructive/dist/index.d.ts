import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assess_bash_command, assess_tool_call } from './destructive/assessors.js';
export type { DestructiveAction } from './destructive/types.js';
export { assess_bash_command, assess_tool_call };
export default function confirm_destructive(pi: ExtensionAPI): Promise<void>;
