# Vendored Pi extensions

This directory contains the Pi extension packages used by this configuration. Their executable resources are loaded from this repository instead of being installed as Pi packages from npm.

The initial import was copied from the exact npm packages installed under `agent/npm/node_modules` on 2026-07-31. Runtime dependencies that are not themselves Pi extensions remain managed by the root `package.json` and `package-lock.json`.

`upstream.json` records each imported version, repository, license declaration, and known local modifications. Package-level `README.md`, `LICENSE`, and `package.json` files are retained when they were present in the published artifact.

The `@spences10` npm artifacts publish compiled JavaScript only. Their original TypeScript sources and tests were recovered from exact matching upstream Git tags. Extension entries and the locally linked Pi-specific helper packages load those TypeScript sources directly; the published `dist/` directories are retained as import baselines.

Locally linked helper package manifests intentionally export `src/index.ts` instead of `dist/index.js`. `pi-project-trust` also resolves `pi-settings` through a sibling `file:` dependency, so none of these Pi-specific helpers is downloaded from npm.

Large gallery-only media files and upstream CI metadata are intentionally excluded because they are not required to run or maintain the extensions.
