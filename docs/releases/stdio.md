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
- `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN`, which win over a stored login (other
  CLI commands need `SENTRY_FORCE_ENV_TOKEN=1` for that)
- the deprecated `--access-token` / `SENTRY_ACCESS_TOKEN`, as an alias for
  `SENTRY_AUTH_TOKEN`. It prints a deprecation
  warning on stderr (see `docs/operations/stdio-auth.md`).

## Bundle

The package is a single file with no runtime dependencies.
`packages/mcp-server/script/bundle.ts` bundles the CLI's
`packages/cli/src/mcp-server.ts` into `dist/sentry-mcp.cjs`:

- The entry runs the CLI's own runner (`packages/cli/src/cli.ts`) with a
  smaller application, `packages/cli/src/mcp-server-app.ts`: `mcp` (the
  default command), `auth`, and `help`. So `sentry-mcp` starts the server,
  `sentry-mcp auth login|status|list|switch|logout` are the CLI's `auth`
  commands, and flags and `--help` come from the same Stricli definitions as
  `sentry mcp`. Hints name the package: `sentry-mcp auth login`, or
  `npx -y @sentry/mcp-server auth login` when npx started it
  (`packages/cli/src/lib/app-identity.ts`).
- The runner starts `mcp` without the CLI's telemetry, error recovery, and
  update check: the server owns stdout and reports its own telemetry. The
  command resolves when the client closes stdin, and only then does the
  runner release the network. The server stack (`@sentry/mcp-core`'s server
  and tools, the agent providers, MCP telemetry) loads only when the server
  starts, and a bare `--version` (or a lone `-v`, as in the old package)
  returns before the application loads.
- stdio runs on MCP SDK v2 (`@modelcontextprotocol/server`), like the
  Cloudflare worker; mcp-core no longer ships SDK v1's server. `zod/v3` is
  stubbed in this bundle and the CLI's
  (`packages/cli/script/lib/zod-v3-stub-plugin.ts`): only Zod 3 code paths in
  `@ai-sdk/provider-utils` and `@mastra/schema-compat` use it, and everything
  bundled builds Zod 4 schemas. Zod keeps only its English locale
  (`packages/cli/script/lib/zod-locales-plugin.ts`).
- CLI-only code stays out: the other commands, agent skills, completions,
  syntax highlighting, the Ink UI, and debug-file processing. Help and `auth`
  output render code blocks without colors, and account pickers take the
  account as an argument instead of the Ink picker. The SQLite WASM fallback
  is left out too, so the package needs Node.js 22.15+. The bundle script
  fails if any of these reach the output or the file grows past its size
  budget. Packages that only those code paths import resolve to empty stub
  modules, so the output never `require`s a package the tarball does not
  ship.

`pnpm --filter @sentry/mcp-server run bundle` builds it and `run test:bundle`
smoke-tests the result.

## Release

The `packages/cli` Craft workspace releases both packages: run the **Release**
workflow with `product: cli`.

- `packages/cli/script/bump-version.ts` sets `packages/mcp-server/package.json`
  to the CLI's version, both for the release and for the next `-dev` version.
  The bundle script fails if the two versions differ.
- `.github/workflows/cli-build.yml` bundles, tests, and packs the package next
  to the CLI's npm package and uploads it as `mcp-server-npm-package`.
- Craft publishes it to npm with the CLI and attaches the tarball to the
  `cli@<version>` GitHub release.

The other `mcp-*` packages are private and keep their own versions.

## MCP Registry

Craft's `mcp-registry` target (Craft 3.5.0+) publishes `server.json` with every
CLI release, after the npm targets. It sets both versions in the manifest to
the release version, so there is no extra version bump to maintain, and it
authenticates with GitHub Actions OIDC from getsentry/publish; no registry
secret is needed. The listing points at the `@sentry/mcp-server` npm package,
plus the hosted endpoint. The registry checks ownership through `mcpName` in
`packages/mcp-server/package.json`.

The registry rejects a version npm does not serve yet. If that happens, rerun
the publish once the package is on npm; targets that already finished are
skipped. An identical active listing is a no-op, so reruns are safe. Different
metadata for an existing version fails because registry versions are
immutable; publish those changes with the next release.

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
`"env": { "SENTRY_AUTH_TOKEN": "sntryu_..." }`.
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

- Command: `packages/cli/src/commands/mcp.ts` (flags and help)
- Credentials and startup: `packages/cli/src/lib/mcp.ts`
- Host (env, config, telemetry): `packages/cli/src/lib/mcp/`
- stdio transport: `packages/mcp-core/src/transports/stdio.ts`
- `@sentry/mcp-server` entry: `packages/cli/src/mcp-server.ts`
- `@sentry/mcp-server` application: `packages/cli/src/mcp-server-app.ts`
- `@sentry/mcp-server` bundle: `packages/mcp-server/script/bundle.ts`
