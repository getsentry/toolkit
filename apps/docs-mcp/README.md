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

Both endpoints cap request bodies at 64 KiB before parsing JSON, whether or not
the request declares `Content-Length`. An oversized `/mcp` POST gets a 413 with a
JSON-RPC error (`code: -32000`); an oversized `/internal/docs` request gets a 413
with `{ "error": "Request body must not exceed 65536 bytes" }`. MCP tool calls
also accept at most 1,000 array elements plus object keys across `arguments`;
larger calls return an `isError` result before the tool runs. Both budgets live
in `src/request-limits.ts`, with the sizing rationale.

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
Wrangler follows the shared workspace catalog used by MCP and CLI docs.
The `execa` alias excludes Mastra's unsupported local-process execution path from
the Worker bundle.

## Deployment ownership

The `Deploy Docs MCP` GitHub Actions workflow deploys the existing `docs-mcp`
Worker after a successful `Test` push run for the current `main` commit. It uses
the same `production` environment, `CLOUDFLARE_API_TOKEN`, and
`CLOUDFLARE_ACCOUNT_ID` as the main MCP deployment, with a separate concurrency
group. The token must permit writing to the existing `docs-mcp` Worker.

The workflow captures the prior active version, uploads without autocreating a
Worker, and activates the exact uploaded version at 100%. It preserves runtime
variables and secrets, compatibility settings, and private access. The Actions
summary records the source SHA, previous version, and verified active version.
There is no public HTTP smoke test: verify functionality through a real consumer
of the private service binding after deployment.

Before merging the workflow for the first deployment, disconnect the source
repository under the existing Worker's **Settings → Builds** and ensure no old
build remains in flight. GitHub Actions does not disconnect Workers Builds;
leaving it connected would allow Init to overwrite a Toolkit deployment. Do not
connect the Worker to Toolkit's Workers Builds as well: Actions owns deployment.
Record the prior active version and preserve the existing Worker, bindings, and
`OPENROUTER_API_KEY`. Remove the source repository's copy only after verifying
the Toolkit deployment and service-binding calls.

The caller's `service: "docs-mcp"` binding still identifies the same Worker in
the same account. No consumer URL change is required. Runtime secrets belong to
the Worker and are separate from build secrets; never copy secret values into
this repository. See [Cloudflare's disconnect procedure](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds).
