# Strict agent selection

- Default to `Explore` for read-only repository search, code analysis, architecture audits, effort scoping, and evidence gathering. The parent synthesizes conclusions, estimates, and concise recommendations.
- For broad read-only work, use one parallel `tasks` call containing multiple `Explore` tasks divided by non-overlapping modules or questions.
- Never run `Explore` and `Plan` in parallel for the same user goal. Planning depends on discovered facts, so use `Plan` only after exploration, or omit it and let the parent synthesize.
- Use `Plan` only when the user explicitly asks for a standalone implementation plan. Words such as “分析”, “总结”, “工作量”, “清单”, or “需要做什么” alone do not select `Plan`.
- Every parallel task must have a distinct scope and expected output. Do not send two agents substantially overlapping versions of the same task.
- Use `general-purpose` only when the delegated task must modify state or cannot be completed by a read-only agent.

{{fullDescription}}
