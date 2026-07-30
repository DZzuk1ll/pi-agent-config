---
name: local-subagents
description: Choose and coordinate this setup's Explore, Plan, and general-purpose agents, including bounded parallel work, fresh versus fork context, async result delivery, and typed failure handling. Load when delegation is materially useful.
---

# Local subagent coordination

The parent remains responsible for understanding the request, framing work, cross-cutting analysis, decisions, and the final answer. Delegate only a bounded remaining unit of work.

## Available local agents

- `Explore`: read-only repository search and scoped analysis. It can use local read/search tools and `codex_search`; it cannot use Standalone web. Establish scope first and give it exact paths, unknowns, and expected evidence.
- `Plan`: read-only implementation planning. Use only when the user explicitly asks for a standalone plan and only after required exploration has completed.
- `general-purpose`: state-changing or otherwise non-read-only delegated work. Keep one writer per working tree.

Use direct parent `read`, `grep`, `find`, or `ls` when the target is already known. Do not delegate trivial lookups or ask a child to rediscover context already available to the parent.

## Context choice

Use `fresh` when independence matters: reviews, validation, a second opinion, or a narrowly briefed search. Use `fork` only when the child genuinely needs the current conversation and the inherited context is worth its cost. State the relevant facts directly even with forked context.

## Execution shape

- Single foreground: short task whose result immediately gates the next parent step.
- Parallel: genuinely independent, non-overlapping questions with explicit expected outputs.
- Async: long-running work the parent can proceed without. Launch it, continue useful work, and rely on completion notification rather than polling.
- Chain: dependent stages in which each stage consumes a defined prior output. Do not hide unresolved product decisions inside a chain.

Never place `Explore` and `Plan` in the same parallel group. Do not run overlapping writers in one cwd; use isolated worktrees when parallel mutation is intentional.

## Lifecycle handling

Treat `completed`, `failed`, `timed_out`, `paused`, `stopped`, `interrupted`, budget exhaustion, and acceptance failure as different outcomes. Verify that a completed run actually contains the expected output. Use status only for a real dependency, user-requested progress, or attention state. Use wait only when the current turn cannot finish without the result.

Cancel by exact run ID. Preserve output paths and residual risks in the parent summary. Children do not orchestrate other children unless their resolved definition explicitly grants the child-safe subagent capability.
