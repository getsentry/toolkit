# stdio Release

How the stdio MCP entry points ship.

## Overview

There are two:

- **`sentry mcp`**, the full local server in the `sentry` npm package
  (`packages/cli`). It ships with every CLI release (the `packages/cli` Craft
  workspace in `.craft.yml`) and owns the MCP registry entry.
- **`@sentry/mcp-server`** (`packages/mcp-server`), a small stdio proxy to the
  hosted MCP for sentry.io users who do not want to download the CLI.

`sentry mcp` bundles `@sentry/mcp-core` (tools, server, and the stdio
transport) and uses the CLI's own authentication:

- `sentry auth login` session (refreshed automatically, including after an
  upstream 401)
- `SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN`, as for every CLI command
- `--access-token` / `SENTRY_ACCESS_TOKEN`: a static token for `sentry mcp`
  only, kept for configurations written for the original `@sentry/mcp-server`
  local server. It is never refreshed, and org auth tokens (`sntrys_`) are still
  scoped to the host they were issued for.

## `@sentry/mcp-server` proxy

`packages/mcp-server` is plain JavaScript in `bin/` and `lib/`. Its only
library is `@modelcontextprotocol/sdk`, which tsdown bundles into
`dist/sentry-mcp.js` on `pnpm pack` (`prepack`), so the published package has
no runtime dependencies (about 80 kB packed, versus about 95 packages for an
unbundled SDK). `pnpm run lint:deps` fails if it gains a workspace dependency,
so the CLI and the MCP core never end up in it.

The `sentry-mcp` bin forwards every JSON-RPC message between stdio and
`https://mcp.sentry.dev/mcp` (Streamable HTTP) with
`Authorization: Sentry-Bearer <token>`. It maps the old local server's flags
onto the hosted URL:

| Flag or variable                               | Hosted MCP                     |
| ---------------------------------------------- | ------------------------------ |
| `--organization-slug`, `--project-slug`        | `/mcp/<org>/<project>`         |
| `--skills`, `MCP_SKILLS`                       | `?skills=`                     |
| `--disable-skills`, `MCP_DISABLE_SKILLS`       | `?disable-skills=`             |
| `--all-skills`                                 | Default (no parameter)         |
| `--experimental`                               | `?experimental=1`              |
| `--mcp-url`, `MCP_URL`                         | Hosted MCP origin (testing)    |
| `--host`, `--url`, `SENTRY_HOST`, `SENTRY_URL` | Must be sentry.io; else exit 1 |

`--insecure-http` and the embedded agent flags (`--agent-provider`,
`--openai-*`, `--anthropic-*`) exit 1 and point to `sentry mcp`. `--sentry-dsn`
and the agent environment variables (`OPENAI_API_KEY`, ...) print a warning
and are ignored.

It releases through the `packages/mcp-server` Craft workspace (`release/mcp`
branches) together with the other `packages/mcp-*` versions. CI packs it in
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

On sentry.io, the proxy is a smaller download:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server@latest"],
      "env": { "SENTRY_ACCESS_TOKEN": "sntryu_..." }
    }
  }
}
```

## Testing Before a Release

```bash
# Run the server from source
pnpm --silent --dir packages/cli run cli mcp --help

# Exercise it with the test client
pnpm -w run cli --transport stdio "who am I?"

# Proxy tests (unit plus end to end against a local Streamable HTTP server)
pnpm --filter @sentry/mcp-server test
```

## References

- Command entry: `packages/cli/src/lib/mcp.ts`
- Host (flags, env, telemetry): `packages/cli/src/lib/mcp/`
- stdio transport: `packages/mcp-core/src/transports/stdio.ts`
- Proxy: `packages/mcp-server/`
