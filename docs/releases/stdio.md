# stdio Release

How the local stdio MCP server ships.

## Overview

The stdio MCP server is the `sentry mcp` command in the `sentry` npm package
(`packages/cli`). It ships with every CLI release (the `packages/cli` Craft
workspace in `.craft.yml`); there is no separate MCP package to version or
publish.

`sentry mcp` bundles `@sentry/mcp-core` (tools, server, and the stdio
transport) and uses the CLI's own authentication:

- `sentry auth login` session (refreshed automatically, including after an
  upstream 401)
- `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN`, as for every CLI command
- `--access-token` / `SENTRY_ACCESS_TOKEN`: a static token for `sentry mcp`
  only, kept for configurations written for the retired `@sentry/mcp-server`
  package. It is never refreshed, and org auth tokens (`sntrys_`) are still
  scoped to the host they were issued for.

## Retired `@sentry/mcp-server` package

`packages/mcp-server` is a deprecation shim kept for one last release. Its
`sentry-mcp` bin prints a one-line stderr notice and runs `sentry mcp` with the
same arguments (`auth login|logout|status` map to `sentry auth ...`). It depends
on `sentry` (`>=0.48.0`, the first release with full flag parity), so publish
it only after that CLI release is on npm.

Remaining maintainer steps:

1. Release `@sentry/mcp-server` once more through the `packages/mcp-server`
   Craft workspace (`release/mcp` branches).
2. Deprecate it on npm with `npm deprecate @sentry/mcp-server "<message>"`,
   pointing users at `npx -y sentry mcp`.
3. Delete `packages/mcp-server`, its Craft workspace, and the pack step in
   `.github/workflows/merge-jobs.yml`.

## MCP Registry

The **Publish MCP Registry** workflow publishes `server.json` on stable CLI
releases (`cli@X.Y.Z` tags) using GitHub Actions OIDC; no registry secret is
needed. It reads the manifest from `main` and sets both versions from the
release, so there is no extra version bump to maintain. The listing points at
the `sentry` npm package with `mcp` as a package argument, plus the hosted
endpoint. npm verifies ownership through `mcpName` in
`packages/cli/package.json`.

Craft publishes GitHub before npm. The workflow waits for the npm package before
publishing the listing. Check this Actions run separately from the Craft release.
To retry or publish an existing release:

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
      "args": ["-y", "sentry@latest", "mcp"]
    }
  }
}
```

Without a `sentry auth login` session, add `"env": { "SENTRY_ACCESS_TOKEN":
"sntryu_..." }`. Pin a version with `sentry@0.48.0`.

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
- Deprecation shim: `packages/mcp-server/`
