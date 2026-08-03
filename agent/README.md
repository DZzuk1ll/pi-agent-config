# Personal Pi Agent

Local Pi configuration, extensions, shared packages, and tests.

## Local development and delivery checks

Run checks from `~/.pi/agent` with a Node.js version supported by dependency-cruiser (`22`, `24`, or `26+`; Node `25` is unsupported):

- `npm run typecheck` runs TypeScript's strict, no-emit project check.
- `npm run lint` runs Biome's lint rules without formatting or writing files.
- `npm run lint:imports` checks module resolution, package declarations, test boundaries, and circular dependencies.
- `npm test` runs the core Node tests and extension Vitest suite.

The only delivery gate is:

```bash
npm run check
```

A change is not ready if any subcommand fails, times out, or is skipped.
