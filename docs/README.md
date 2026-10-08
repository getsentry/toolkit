# Toolkit Documentation

This directory is the documentation home for the Toolkit repository. It covers
the Sentry CLI, the MCP server, and the code they share. Start with the product
you are working on:

- [Sentry CLI](cli/README.md) — commands, contributor guides, generated docs,
  and the published CLI documentation site.
- [Sentry MCP](mcp/README.md) — tools, transports, Cloudflare, operations, and
  MCP-specific tests and specs.

The published CLI site lives in `apps/cli-docs/` because CLI releases build
and package it from that workspace. The contributor index here links to its
source and to <https://cli.sentry.dev/>. MCP documentation lives in the topic
directories below; the MCP index explains which guides apply to that product.

## Shared Contributor Guides

- [Coding guidelines](contributing/coding-guidelines.md) — repository-wide style
  and the separate CLI and MCP patterns.
- [Documentation style](contributing/documentation-style-guide.md) — how to
  write and link Toolkit docs.
- [Pull requests](contributing/pr-management.md) — contribution and review
  workflow.
- [Quality checks](contributing/quality-checks.md) — repository checks before
  a change is proposed.

For package-specific rules, see the root [AGENTS.md](../AGENTS.md) and the
[CLI AGENTS.md](../packages/cli/AGENTS.md). `packages/toolkit-core/` contains
shared primitives used by both products.

## Ownership

Keep repository-wide contributor guidance in `docs/contributing/`. Put product
guides under the relevant product index, and link to existing material rather
than copying it. CLI website pages and generated command documentation remain
in `apps/cli-docs/`; changes there follow the CLI documentation build and
release. Root `docs/` changes run the repository documentation checks; they do
not deploy a website or select a product build on their own.
