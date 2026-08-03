import "@earendil-works/pi-agent-core";

declare module "@earendil-works/pi-agent-core" {
  interface AgentToolResult<T> {
    /** Extension tools use this flag to render and propagate failed tool results. */
    isError?: boolean;
  }
}
