# Agent selection, delegation, and lifecycle discipline

- If the target path, symbol, or search term is already known, the parent must use direct `read`, `grep`, `find`, or `ls` first. Do not delegate a lookup the parent can complete directly.
- Before delegating, the parent must understand the request well enough to state the objective, relevant paths or symbols, what is already known or ruled out, the exact remaining question, and the expected output. Never delegate understanding or final synthesis.
- Use `Explore` only for bounded read-only searches after the parent establishes scope. Do not use it for unframed architecture audits or open-ended “understand this project” requests.
- For genuinely independent unknowns, use one parallel call with non-overlapping tasks. Do not repeat searches the parent already completed.
- Never run `Explore` and `Plan` in the same parallel group. Use `Plan` only after exploration and only when the user explicitly requests a standalone implementation plan.
- Use `general-purpose` only when delegated work must modify state or cannot be completed by a read-only agent.

## Foreground versus background

- Use foreground execution for short tasks whose answer is immediately required before the parent can continue.
- Use async/background execution for long-running, independently useful, or parallel work. After launch, continue useful parent work; do not immediately call status or create a polling loop.
- Completion notifications are the normal result-delivery path. Call status only when the user asks, the result becomes a real dependency, or the run appears to need attention.
- Use `subagent_wait` only when this turn must return the child result before it can end. In interactive sessions, otherwise return control and let Pi wake the session.
- Treat failed, timed-out, paused, stopped, interrupted, budget-exhausted, and acceptance-failed runs as distinct terminal outcomes. Missing output is never success.
- Cancel or stop only the intended run ID. Do not infer process completion from result files, timestamps, or PID disappearance; rely on package lifecycle state.

## Safety and ownership

- Keep one writer in the same working tree. Parallel writers require isolated worktrees or explicitly non-overlapping ownership.
- Prefer fresh-context reviewers and validators for independent checks. The parent owns synthesis and decides which findings to apply.
- Children are not orchestrators unless their resolved agent definition explicitly grants the child-safe `subagent` tool.
- Respect cwd, model, tool, turn, cost, and acceptance budgets. Do not weaken them merely to make a run succeed.
- `Explore` defaults to `toolBudget: { soft: 50, hard: 70, block: ["bash"] }`. Do not reduce it unless the user requests a tighter bound.

{{fullDescription}}
