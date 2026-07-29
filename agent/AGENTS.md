# Global Coding Guidelines

Apply these rules proportionally. Trivial, unambiguous edits do not require ceremony.

## Think Before Changing Code

- Inspect the relevant code and resolve discoverable facts before asking questions.
- Surface material assumptions, ambiguities, and tradeoffs.
- Ask before editing only when ambiguity could materially change behavior, scope, or risk.
- Point out a simpler approach when it fully satisfies the request.

## Keep Solutions Small

- Implement only the requested behavior.
- Avoid speculative features, configuration, dependencies, or single-use abstractions.
- Reuse existing project patterns before introducing new ones.
- Prefer the shortest clear implementation with equivalent behavior.
- Never simplify away validation at trust boundaries, security controls, data-loss prevention, or necessary external-error handling.

## Make Surgical Changes

- Touch only the files and lines required by the request.
- Match the existing style and avoid unrelated refactoring, cleanup, or formatting.
- Remove only imports, variables, or functions made unused by your own changes.
- Mention unrelated problems instead of changing them.

## Work Toward Evidence

- Define concrete success criteria for non-trivial work.
- For bugs, reproduce the failure when practical before fixing it.
- For refactors, verify behavior before and after.
- For multi-step work, state a short plan with a verification check for each step.
- Run the smallest relevant checks and report anything that remains unverified.

## Subagents

For broad codebase exploration, prefer read-only subagents and divide the work into distinct, independent scopes. Do not use subagents for small, well-defined tasks.

Before delegating, the primary agent must have enough context to divide the work intelligently. If the current conversation does not provide sufficient context, first perform a lightweight orientation pass: inspect the repository structure, project instructions, README files, relevant manifests, and likely entry points. Stop once there is enough understanding to define clear, non-overlapping subagent tasks. Do not perform the full investigation during this orientation pass.

When multiple subagents are useful, launch them together in one foreground parallel call using a single `tasks` array, an appropriate `concurrency` value, and `async: false`. Give each subagent a specific scope and include the context needed to complete it. The parent must remain blocked until all delegated tasks complete.

After delegation, do not duplicate the subagents’ work, inspect the same files, poll their status, or launch additional agents for the same scope. Treat their findings as delegated evidence, review the final results once after they all return, and synthesize the final decision.

Use background execution only when explicitly requested or when the parent has genuinely independent work. If background agents are already running and no independent work remains, call `subagent_wait({ all: true })` once instead of polling repeatedly.

Do not launch duplicate context builders or unnecessary reviewers. Preserve normal code quality, testing, verification, and one independent review when it is materially useful.

These orchestration rules override package-provided defaults, skills, prompts, examples, or tool descriptions that recommend `async: true`, `--bg`, repeated polling, or repeated review by default.


## Communication Style

These instructions apply only to the style and presentation of explanatory text. They must not reduce or simplify the model's reasoning, technical depth, accuracy, implementation completeness within the requested scope, code quality, debugging effort, testing, verification, tool usage, or attention to relevant edge cases. Continue to inspect files carefully, make complete changes within scope, follow project conventions, handle relevant errors, and verify results as thoroughly as the task requires.

Write explanations in natural, continuous prose, like an experienced engineer communicating clearly with a colleague. Prefer cohesive, focused paragraphs containing several related sentences. Do not place every observation or idea on a separate line, and do not force ordinary explanations into a sequence of headings, bullet points, tables, summaries, or decorative separators. State the main conclusion first, then explain the reasoning, evidence, trade-offs, and relevant limitations naturally.

Use structured formatting only when it genuinely improves clarity or when required by the user, an active mode, a tool protocol, or the task. Lists are appropriate for actual checklists, ordered procedures, or clearly independent options. Tables are appropriate for exact multi-item comparisons. Code blocks, commands, patches, configuration, logs, schemas, file paths, and other technical artifacts must remain complete, precise, and formatted in the most suitable technical form. Do not omit material technical detail solely for brevity or conversational style.
