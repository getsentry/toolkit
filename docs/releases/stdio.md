# stdio Release

How the local stdio MCP server ships.

## Overview

The stdio MCP server ships as `@sentry/mcp-server`. Its source lives in
`packages/cli` so it shares the CLI's auth, which also exposes it as
`sentry mcp`. Every CLI release publishes the package at the CLI's version, so
`@sentry/mcp-server@0.48.0` runs the same server as `sentry mcp` in CLI 0.48.0.

It bundles `@sentry/mcp-core` (tools, server, and the stdio transport) and
accepts these credentials:

- the shared login from `npx @sentry/mcp-server auth login` or `sentry auth
  login` (refreshed automatically, including after an upstream 401)
- `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN`, as for every CLI command
- `--access-token` / `SENTRY_ACCESS_TOKEN`: a static token for the MCP server
  only. It is never refreshed, and org auth tokens (`sntrys_`) are still
  scoped to the host they were issued for.

## Bundle

The package is a single file with no runtime dependencies.
`packages/mcp-server/script/bundle.ts` bundles the CLI's
`packages/cli/src/mcp-server.ts` into `dist/sentry-mcp.cjs`:

- Full flags, environment variables, tools, and self-hosted support, using the
  CLI's credential store.
- `sentry-mcp auth login` runs the CLI's device flow with plain-text output.
  Other `auth` subcommands point to `npx -y sentry auth ...`.
- CLI-only code stays out: commands, the markdown renderer, agent skills,
  completions, terminal images, the Ink UI, and debug-file processing. The
  SQLite WASM fallback is left out too, so the package needs Node.js 22.15+.
  The bundle script fails if any of these reach the output or the file grows
  past its size budget. Packages that only those code paths import (Ink,
  React, the SQLite WASM fallback) resolve to empty stub modules, so the
  output never `require`s a package the tarball does not ship.

`pnpm --filter @sentry/mcp-server run bundle` builds it and `run test:bundle`
smoke-tests the result.

## Release

The `packages/cli` Craft workspace releases both packages through the **Release**
workflow.

- `packages/cli/script/bump-version.ts` sets `packages/mcp-server/package.json`
  to the CLI's version, both for the release and for the next `-dev` version.
  The bundle script fails if the two versions differ.
- `.github/workflows/cli-build.yml` bundles, tests, and packs the package next
  to the CLI's npm package and uploads it as `mcp-server-npm-package`.
- Craft publishes it to npm with the CLI and attaches the tarball to the
  `cli@<version>` GitHub release.

The other `mcp-*` packages are private and keep their own versions.

## MCP Registry

The **Publish MCP Registry** workflow publishes `server.json` on stable
`cli@<version>` releases using GitHub Actions OIDC; no registry secret is
needed. It reads the manifest from `main` and sets both
versions from the release, so there is no extra version bump to maintain. The
listing points at the `@sentry/mcp-server` npm package, plus the hosted
endpoint. npm verifies ownership through `mcpName` in
`packages/mcp-server/package.json`.

Craft publishes GitHub before npm. The workflow waits for the npm package before
publishing the listing. Check this Actions run separately from the Craft release.
To retry or publish an existing release (CLI release tags, or the bare tags
used up to 0.42.0):

```bash
gh workflow run mcp-registry.yml --repo getsentry/toolkit --ref main -f version=0.48.0
```

An identical active listing is safe to rerun. Different metadata for an existing
version fails verification because registry versions are immutable; publish those
changes with the next release. Registry failures do not undo the npm release.

## User Installation

Users run the server through npx in their MCP client configuration:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["@sentry/mcp-server@latest"]
    }
  }
}
```

Sign in once with `npx @sentry/mcp-server@latest auth login`, or add
`"env": { "SENTRY_ACCESS_TOKEN": "sntryu_..." }`.
Pin a version with `@sentry/mcp-server@0.48.0`.

## Testing Before a Release

Test the package itself, not just the CLI source it is built from:

```bash
# Build and smoke-test the bundle
pnpm --filter @sentry/mcp-server run bundle
pnpm --filter @sentry/mcp-server run test:bundle

# Exercise the built bundle with the test client
pnpm -w run cli --transport stdio --stdio-bundle "who am I?"

# Install the packed tarball the way users do
(cd packages/mcp-server && pnpm pack)
npx -y --package=./packages/mcp-server/sentry-mcp-server-*.tgz sentry-mcp --help
```

While iterating, `pnpm -w run cli --transport stdio` (without
`--stdio-bundle`) runs `sentry mcp` from CLI source, which needs no build.

## References

- Command entry: `packages/cli/src/lib/mcp.ts`
- Host (flags, env, telemetry): `packages/cli/src/lib/mcp/`
- stdio transport: `packages/mcp-core/src/transports/stdio.ts`
- `@sentry/mcp-server` entry: `packages/cli/src/mcp-server.ts`
- `@sentry/mcp-server` bundle: `packages/mcp-server/script/bundle.ts`
