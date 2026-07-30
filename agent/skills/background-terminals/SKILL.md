---
name: background-terminals
description: Use Pi's bg_start/bg_status/bg_list/bg_kill tools for servers, watchers, and long-running non-interactive commands that should continue while the main agent works. Load only when background process lifecycle matters.
---

# Background terminals

Use an ordinary `bash` call for short commands whose result is needed immediately. Use `bg_start` only for a server, watcher, long test suite, or other process that should keep running while useful parent work continues.

## Operating rules

1. Start one bounded task with a clear `title`. `cwd` must be the current project or a descendant.
2. The process has no stdin. Do not launch commands that require prompts, passwords, confirmations, editors, or interactive REPL input.
3. After `bg_start`, record the returned ID and continue other work. Do not immediately call `bg_status`, sleep, or build a polling loop. Completion is delivered automatically as a follow-up.
4. Use `bg_status` only when current output becomes a real dependency or the user explicitly asks for progress. Use `bg_list` for discovery rather than guessing IDs.
5. Stop no-longer-needed processes with `bg_kill`. It terminates the process tree, not only the shell.
6. A failed, killed, or aborted process is not successful even if it emitted useful partial output. Report its terminal state and relevant tail.

## Environment and output

Background commands receive a small environment allowlist, not API tokens, cookies, cloud credentials, or arbitrary parent variables. If a trusted project genuinely requires secrets, use a user-approved project-local launcher that loads them explicitly; never place secret values directly in tool arguments.

Tool output is sanitized and bounded. stdout and stderr remain separate, and private full-log paths are reported when available. Logs are deleted on reload or session shutdown. A stream can be capped, so treat the cap notice as incomplete evidence.

## Examples

Start a development server and continue reviewing code:

```json
{"command":"npm run dev","title":"web dev server","cwd":"apps/web"}
```

Inspect only when needed:

```json
{"id":"bt-1","tailLines":120}
```

Always clean up watchers and servers once they are no longer useful.
