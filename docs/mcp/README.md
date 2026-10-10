# Sentry MCP Documentation

MCP spans `packages/mcp-core/`, `packages/mcp-server/`, and
`packages/mcp-cloudflare/`, with mocks, evals, and a test client in neighboring
packages. Its guides stay in root `docs/` because no single MCP package owns
them. The [Toolkit index](../README.md) also links the CLI and shared guides.

## Develop and Test

- [Architecture](../architecture/overview.md) — MCP packages and transports.
- [Adding tools](../contributing/adding-tools.md) and
  [tool responses](../contributing/tool-responses.md) — tool implementation and
  output policy.
- [API patterns](../contributing/api-patterns.md),
  [search events](../contributing/search-events-api-patterns.md),
  [common patterns](../contributing/common-patterns.md), and
  [error handling](../contributing/error-handling.md) — MCP client conventions.
- [Testing](../testing/overview.md), [stdio](../testing/stdio.md), and
  [remote](../testing/remote.md) — tests and transport QA.

## Run and Release

- [Security](../operations/security.md),
  [stdio authentication](../operations/stdio-auth.md), and
  [OAuth sign-out](../operations/oauth-signout-playbook.md).
- [Embedded agents](../operations/embedded-agents.md),
  [monitoring](../operations/monitoring.md), and
  [logging](../operations/logging.md).
- [Cloudflare overview](../cloudflare/overview.md),
  [architecture](../cloudflare/architecture.md), and
  [OAuth](../cloudflare/oauth-architecture.md).
- [Stdio release](../releases/stdio.md) and
  [Cloudflare deployment](../releases/cloudflare.md).
- [MCP specs](../specs/README.md) and
  [integrations](../integrations/claude-code-plugin.md).
