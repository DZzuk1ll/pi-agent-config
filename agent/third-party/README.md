# Community source provenance

Community code is organized by runtime role:

- `agent/extensions/community/` contains Pi extension sources.
- `agent/lib/community/` contains Pi-coupled helper libraries that do not register extension entry points themselves.
- `agent/themes/community/` contains theme resources.

The executable resources load directly from this repository. `agent/package.json` is both the local Pi package manifest and the single npm dependency manifest; npm is used only for generic runtime dependencies and links to local helper libraries.

`upstream.json` records each imported version, repository, license declaration, local path, and known local modification. The repository keeps TypeScript source, maintenance tests, runtime assets, package manifests required for module resolution, and one `tsconfig.json` per recovered source package.

Per-package README, LICENSE, CHANGELOG, generated `dist/`, build-only TypeScript configs, publishing metadata, installation scripts, examples, and unused bundled resources are intentionally omitted from this private source-only configuration.
