import type { AgentToolResult as CoreAgentToolResult } from "@earendil-works/pi-agent-core";

/** Internal result envelope. Pi receives `isError` through its tool_result hook. */
export type AgentToolResult<T> = CoreAgentToolResult<T> & { isError?: boolean };
