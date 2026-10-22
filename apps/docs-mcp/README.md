# Docs MCP

An independent Cloudflare Worker for Sentry documentation search, cited answers,
and tailored SDK integration guides. It reads the Markdown exports and doctree
from `docs.sentry.io`; AI-backed operations use OpenRouter through Mastra.

Imported from [getsentry/cli-init-api at f3b32b49](https://github.com/getsentry/cli-init-api/tree/f3b32b49ebaa5eb13378e1e5ab9f05be2f39ba5d/apps/docs-mcp).
The Worker has no build or runtime dependency on Init Server. Its Cloudflare name
remains `docs-mcp`.

## Interfaces

Production access is through Cloudflare service bindings. `workers.dev` and
preview URLs are disabled. Both docs endpoints accept the `docs-mcp.internal`
origin used by the binding, or localhost during development.

| Endpoint              | Contract                                                    |
| --------------------- | ----------------------------------------------------------- |
| `GET /health`         | Readiness response `{ "status": "ok" }`.                    |
| `/mcp`                | Streamable HTTP MCP with the four tools below.              |
| `POST /internal/docs` | JSON API with `operation: "search-docs"` or `"query-docs"`. |

| MCP tool                 | Input                                       | Output inside text content                                       |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| `search-docs`            | `query`, optional `limit`                   | JSON `{ results: [{ title, url, description? }] }`; no LLM call. |
| `query-docs`             | `query`, optional safe project `context`    | JSON `{ answer, sources }` with validated citations.             |
| `get-available-features` | `libs`                                      | JSON `{ features }` with canonical feature slugs.                |
| `get-docs`               | `libs`, `features`, optional `stackSummary` | Tailored Markdown integration guide.                             |

The internal API uses the same search and query implementations. Query context is
limited to `frameworks`, `languages`, and `sentryConfigured`. Model failures and
unverifiable answers retain the safe `DOCS_MODEL_UNAVAILABLE` and
`DOCS_UNGROUNDED` error codes.

The existing `sentry docs` CLI calls Init Server's authenticated `/api/docs/*`
facade, which forwards requests through its `DOCS_MCP` binding. Moving this app
does not change that contract. Retiring Init Server would require a separate
decision about the CLI's entry point; it would not stop this Worker. Toolkit's
main MCP server has its own `search_docs` and `get_doc` tools and does not consume
this Worker.

## Development

From the Toolkit root:

```sh
pnpm install
cp apps/docs-mcp/.env.example apps/docs-mcp/.dev.vars
# Set OPENROUTER_API_KEY in the ignored .dev.vars file for AI-backed calls.
pnpm --filter docs-mcp dev
```

The server listens on `http://localhost:8788`. Search and readiness checks do not
require an OpenRouter key:

```sh
curl http://localhost:8788/health
curl http://localhost:8788/internal/docs \
  -H 'Content-Type: application/json' \
  -d '{"operation":"search-docs","query":"tracing","limit":3}'
```

Validation runs without model credentials:

```sh
pnpm --filter docs-mcp test
pnpm --filter docs-mcp typecheck
pnpm --filter docs-mcp build
```

`build` only bundles with `wrangler deploy --dry-run`; it does not deploy.
Toolkit's workspace CI discovers the app's build, typecheck, and `test:ci`
scripts automatically. Keep the app's AI SDK 5 and Sentry 10 dependencies
separate from Toolkit's newer catalogs until a dedicated upgrade is validated.
The `execa` alias excludes Mastra's unsupported local-process execution path from
the Worker bundle.

## Deployment ownership

Importing this app does not change Cloudflare or enable a new deployment workflow.
The existing Worker is connected to the source repository through Workers Builds.
Toolkit's MCP deployment workflow targets `sentry-mcp`, not this app.

When a production cutover is scheduled:

1. Record the existing Worker's account, build settings, runtime secrets, and
   active version. Keep the name `docs-mcp`, compatibility settings, private
   access configuration, and `OPENROUTER_API_KEY` runtime secret.
2. Disconnect the old repository under the existing Worker's **Settings →
   Builds**. Ensure no old build remains in flight before enabling a new deploy.
3. Connect that same Worker to `getsentry/toolkit`. Configure the workspace
   installation and the `apps/docs-mcp` build/deploy commands, with watch paths
   covering this app, the root lockfile/workspace configuration, and its patches.
   Review preview settings so the private service is not exposed publicly.
4. Deploy the tested revision and verify its active version and service-binding
   calls before removing the source repository's copy.

The caller's `service: "docs-mcp"` binding still identifies the same Worker in
the same account. No consumer URL change is required. Runtime secrets belong to
the Worker and are separate from build secrets; never copy secret values into
this repository. See [Cloudflare's repository-switch procedure](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds).
