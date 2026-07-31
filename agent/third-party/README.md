# Community source provenance

Community code is organized by runtime role instead of being stored under the npm installation directory:

- `agent/extensions/community/` contains Pi extension packages.
- `agent/lib/community/` contains Pi-coupled helper libraries that do not register extension entry points themselves.
- `agent/themes/community/` contains theme packages.

The executable resources are loaded directly from this repository. `agent/package.json` is both the local Pi package manifest and the single npm dependency manifest; npm is used only to install generic runtime dependencies and create links to the local helper libraries.

`upstream.json` records each imported version, repository, license declaration, local path, and known local modification. Package-level `README.md`, `LICENSE`, tests, and `package.json` files are retained when they were available.

The `@spences10` npm artifacts publish compiled JavaScript only. Their original TypeScript sources and tests were recovered from exact matching upstream Git tags. Extension entries and locally linked helpers load those TypeScript sources directly; published `dist/` directories are retained as import baselines.

Large gallery-only media and upstream CI metadata are excluded because they are not needed to run or maintain this configuration.
