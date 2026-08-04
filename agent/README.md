# Personal Pi Agent

Local Pi configuration, extensions, shared packages, and tests.

## Local development and delivery checks

Run checks from `~/.pi/agent` with a Node.js version supported by dependency-cruiser (`22`, `24`, or `26+`; Node `25` is unsupported):

- `npm run typecheck` runs TypeScript's strict, no-emit project check, including exact optional properties and checked side-effect imports.
- `npm run lint` runs Biome with zero warnings allowed, including hard bans on explicit `any`, non-null assertions, and focused tests.
- `npm run lint:imports` checks module resolution, package declarations, test boundaries, and circular dependencies.
- `npm test` runs the core Node tests and extension Vitest suite.

The only delivery gate is:

```bash
npm run check
```

A change is not ready if any subcommand fails, times out, or is skipped.
