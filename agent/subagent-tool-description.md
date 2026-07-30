# Agent selection and delegation discipline

- If the target path, symbol, or search term is already known, the parent must use direct `read`, `grep`, `find`, or `ls` first. Do not delegate a lookup that the parent can complete directly.
- Before delegating, the parent must understand the request well enough to brief a colleague: state the objective, relevant paths or symbols, what is already known or ruled out, and the specific remaining question. If that context is missing, investigate directly first.
- Never delegate understanding. The parent owns problem framing, cross-cutting analysis, synthesis, estimates, and final recommendations.
- Use `Explore` only after the parent has established an initial scope. Delegate bounded read-only searches or scoped analysis of remaining unknowns; do not hand it an unframed architecture audit or open-ended “understand this project” request.
- For genuinely independent unknowns, use one parallel `tasks` call with non-overlapping scopes and expected outputs. Do not repeat searches the parent already completed or send substantially overlapping tasks.
- Never run `Explore` and `Plan` in parallel for the same user goal. Use `Plan` only when the user explicitly requests a standalone implementation plan and after any required exploration. Words such as “分析”, “总结”, “工作量”, “清单”, or “需要做什么” alone do not select `Plan`.
- Use `general-purpose` only when the delegated task must modify state or cannot be completed by a read-only agent.

{{fullDescription}}
