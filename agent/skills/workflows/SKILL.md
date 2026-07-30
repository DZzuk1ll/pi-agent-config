---
name: sandbox-workflows
description: Build an explicitly requested multi-stage fan-out/fan-in workflow with the sandboxed workflow tool and its agent(), parallel(), phase(), and args API. Do not load for simple tasks or a single delegation.
---

# Sandboxed workflows

Use `workflow` only when the user explicitly asks for a workflow or when a task genuinely requires several dependent or parallel agent calls followed by synthesis. Prefer direct tools or one `subagent` call for simpler work.

The script is JavaScript executed in a permission-restricted child process. It cannot read files, access the network, spawn commands, import modules, use `process`, or call Pi tools directly. It can only orchestrate named Pi subagents through the host API.

## API

```js
args
phase(title)
agent(prompt, {
  agent,      // defaults to "general-purpose"
  label,
  phase,
  model,
  thinking,   // off|minimal|low|medium|high|xhigh|max
  schema      // JSON Schema object for structured output
})
parallel([() => agent(...), () => agent(...)], { concurrency })
```

Every `agent()` must be awaited, directly or through `parallel()`. It resolves to:

```js
{ ok, output, structured, error, usage, runId }
```

A child failure is `{ ok: false }`; inspect it and decide whether to degrade, retry within budget, or return a failed summary. A bridge, IPC, or sandbox integrity failure terminates the workflow.

## Recommended structure

```js
phase("Independent investigation");
const findings = await parallel([
  () => agent("Inspect the parser boundary and report evidence.", { agent: "Explore", label: "parser" }),
  () => agent("Inspect lifecycle cleanup and report evidence.", { agent: "Explore", label: "lifecycle" }),
], { concurrency: 2 });

const usable = findings.filter((item) => item.ok).map((item) => item.output);
if (usable.length === 0) return { ok: false, errors: findings.map((item) => item.error) };

phase("Synthesis");
const synthesis = await agent(
  `Synthesize these findings without inventing evidence:\n${usable.join("\n\n---\n\n")}`,
  { agent: "general-purpose", label: "synthesis" },
);
return synthesis;
```

Use `argsJson` for user-supplied structured inputs instead of embedding them in source. `args` is immutable. Use `background: true` only when the parent can continue without the final result; do not poll after launch.

## Bounds and lifecycle

A workflow has a maximum of 32 agent calls, concurrency 4, and 30 minutes wall time. Source, args, IPC messages, and results are byte bounded. Foreground workflows follow the tool AbortSignal; background workflows survive Esc but are cancelled on reload or session shutdown. `/workflows` shows runs and can cancel them; `/subagents-fleet` remains the source for child transcripts.

Artifacts are private under `~/.pi/agent/workflows/<run-id>/` and retained for at most 30 days and 100 runs. Do not put secrets in script source or `argsJson` because both are persisted.
