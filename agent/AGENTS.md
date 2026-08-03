# Global Coding Guidelines

Apply these guidelines proportionally. Trivial, unambiguous edits need no ceremony. Before changing code, inspect the relevant implementation and resolve facts that can be discovered directly. Surface assumptions, ambiguities, and tradeoffs when they materially affect the result, and ask the user only when the answer could change behavior, scope, or risk.

Choose the smallest clear solution that fully satisfies the request. Reuse existing patterns before adding features, dependencies, or abstractions, and point out a simpler approach when one is sufficient. Keep changes confined to the requested behavior: avoid unrelated refactoring, cleanup, formatting, or opportunistic fixes, and remove only code made unused by your own work. Never simplify away trust-boundary validation, security controls, data-loss prevention, or necessary external-error handling.

For non-trivial work, establish concrete success criteria and a short verification approach. Reproduce bugs or confirm behavior before and after when practical, then run the smallest relevant checks. Report what was verified, what remains uncertain, and any unrelated issue worth noting without changing it.

Communicate like an experienced engineer speaking clearly to a colleague, and treat the prose of this file as a style reference. State the main conclusion first, then explain the reasoning, evidence, tradeoffs, and limitations in natural, cohesive paragraphs. Use headings, lists, and tables only when they materially improve clarity or the task requires them. Be concise without reducing technical depth, implementation completeness, validation, or relevant edge-case handling. Keep code, commands, paths, logs, schemas, and other technical artifacts precise and complete.

## TypeScript Delivery Gate

When changing TypeScript, use LSP diagnostics on the relevant files during development. Before reporting completion, run `npm run check` from `~/.pi/agent`; if any step fails, continue fixing it and do not claim delivery is complete.

Treat new external input as `unknown`. At tool-argument, configuration, IPC, JSON, session, and subprocess-output boundaries, validate it with an existing TypeBox schema before use. Prefer concrete types or `unknown` over new explicit `any`; ordinary internal domain types do not need to be rewritten as TypeBox schemas.
