# stdio Release

How the local stdio MCP server ships.

## Overview

The stdio MCP server ships as `@sentry/mcp-server`, released from the
`packages/mcp-server` Craft workspace. Its source lives in `packages/cli` so it
shares the CLI's auth, which also exposes it as `sentry mcp` in each CLI
release.

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
`packages/cli/script/bundle-mcp-server.ts` bundles
`packages/cli/src/mcp-server.ts` into `dist/sentry-mcp.cjs`:

- Full flags, environment variables, tools, and self-hosted support, using the
  CLI's credential store.
- `sentry-mcp auth login` runs the CLI's device flow with plain-text output.
  Other `auth` subcommands point to `npx -y sentry auth ...`.
- CLI-only code stays out: commands, the markdown renderer, agent skills,
  completions, terminal images, the Ink UI, and debug-file processing. The
  SQLite WASM fallback is left out too, so the package needs Node.js 22.15+.
  The bundle script fails if any of these reach the output or the file grows
  past its size budget.

`pnpm --filter @sentry/mcp-server run bundle` builds it and `run test:bundle`
smoke-tests the result. The `packages/mcp-server` Craft workspace releases it
from `release/mcp` branches; `.github/workflows/merge-jobs.yml` bundles, tests,
and packs it. Each release bundles the CLI source at that commit, so it does
not wait for a CLI release.

## MCP Registry

The **Publish MCP Registry** workflow publishes `server.json` on stable
`@sentry/mcp-server` releases (not `cli@` tags) using GitHub Actions OIDC; no
registry secret is needed. It reads the manifest from `main` and sets both
versions from the release, so there is no extra version bump to maintain. The
listing points at the `@sentry/mcp-server` npm package, plus the hosted
endpoint. npm verifies ownership through `mcpName` in
`packages/mcp-server/package.json`.

Craft publishes GitHub before npm. The workflow waits for the npm package before
publishing the listing. Check this Actions run separately from the Craft release.
To retry or publish an existing release:

```bash
gh workflow run mcp-registry.yml --repo getsentry/toolkit --ref main -f version=0.42.0
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

Sign in once with `npx @sentry/mcp-server@latest auth login` (or
`sentry auth login`), or add `"env": { "SENTRY_ACCESS_TOKEN": "sntryu_..." }`.
Pin a version with `@sentry/mcp-server@0.42.0`.

## Testing Before a Release

```bash
# Run the server from source
pnpm --silent --dir packages/cli run cli mcp --help

# Exercise it with the test client
pnpm -w run cli --transport stdio "who am I?"
```

## References

- Command entry: `packages/cli/src/lib/mcp.ts`
- Host (flags, env, telemetry): `packages/cli/src/lib/mcp/`
- stdio transport: `packages/mcp-core/src/transports/stdio.ts`
- `@sentry/mcp-server` entry: `packages/cli/src/mcp-server.ts`
- `@sentry/mcp-server` bundle: `packages/cli/script/bundle-mcp-server.ts`
