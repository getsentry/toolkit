# Embedded Agent Azure OpenAI Provider

## Overview

Sentry MCP currently has a generic `openai` embedded-agent provider plus a
custom `--openai-base-url` override. The AI SDK upgrade changed the default API
surface toward `responses`, which broke Azure-style deployment URLs and
corporate proxies that previously worked through chat completions.

The right fix is to stop teaching the generic `openai` provider Azure-specific
behavior. Generic OpenAI-compatible endpoints are too heterogeneous to route
reliably from URL shape alone. Instead, Sentry MCP should introduce an explicit
`azure-openai` provider and keep `openai` intentionally simple.

## Motivation

- Preserve the 0.29.x compatibility path for Azure deployment URLs.
- Remove model-prefix heuristics such as `gpt-*` or `codex-*`.
- Avoid adding a generic routing flag like `--openai-api-surface`.
- Avoid brittle URL-shape inference for unknown OpenAI-compatible providers.
- Keep Azure compatibility opt-in instead of silently affecting all custom
  OpenAI endpoints.

## Design

### Provider Split

Supported embedded-agent providers become:

- `openai`
- `azure-openai`
- `anthropic`

### `openai` Provider

The generic `openai` provider remains the default OpenAI-family option.

Rules:

- `OPENAI_MODEL` and `--openai-model` are opaque identifiers.
- `--openai-base-url` is allowed for generic OpenAI-compatible proxies.
- The generic `openai` provider always uses the Responses API.
- The generic `openai` provider never switches behavior based on model prefixes.
- The generic `openai` provider never applies Azure deployment-path special
  cases.

This keeps unknown providers predictable.

### `azure-openai` Provider

Azure behavior becomes explicit instead of inferred.

Rules:

- `azure-openai` must be selected explicitly via `--agent-provider` or
  `EMBEDDED_AGENT_PROVIDER`.
- `OPENAI_MODEL` and `--openai-model` remain opaque deployment identifiers.
- `--openai-base-url` continues to provide the Azure or Azure-compatible base
  URL.
- `OPENAI_API_VERSION` is honored only when `azure-openai` is selected.
- URL-shape routing is allowed only inside `azure-openai`.

Within `azure-openai`, supported routing is:

- Base URL ending in `/openai/v1` or `/openai/v1/`: use Responses API
- Base URL ending in `/openai/deployments/<deployment>`:
  use chat completions

That gives Azure users compatibility without teaching generic OpenAI mode to
guess.

### Auto-Detection

Auto-detection should remain:

- `anthropic` when only `ANTHROPIC_API_KEY` is present
- `openai` when only `OPENAI_API_KEY` is present

`azure-openai` should never be auto-detected. It shares the same broad key
family as `openai`, and inferring Azure mode from a key or URL would recreate
the same footguns this change is intended to remove.

### Why This Is the Default

This follows the broad pattern used elsewhere:

- Azure's docs treat Azure as explicit configuration, and their v1 examples use
  deployment names as the `model` value on an Azure endpoint.
- OpenAI's official SDK exposes Azure through a distinct `AzureOpenAI` client.
- Vercel AI SDK exposes Azure through a separate Azure provider instead of
  adding Azure heuristics to the generic OpenAI provider.

## Interface

### CLI

No generic routing flag is added.

Add a new supported provider value:

```bash
--agent-provider <provider>   LLM provider: openai, azure-openai, or anthropic
```

The existing OpenAI-family flags continue to apply:

```bash
--openai-base-url <url>
--openai-model <model>
```

For Azure-specific API versioning, honor:

```bash
OPENAI_API_VERSION=<version>
```

The initial design does not require a dedicated `--openai-api-version` flag,
though one can be added later if CLI parity becomes important.

### Types

Update:

- `packages/mcp-core/src/internal/agents/types.ts`
- `packages/mcp-core/src/internal/agents/provider-factory.ts`
- `packages/cli/src/lib/mcp/args.ts`
- `packages/cli/src/lib/mcp/config.ts`
- `packages/cli/src/lib/mcp/usage.ts`

Add:

```ts
type AgentProviderType = "openai" | "azure-openai" | "anthropic";
```

### Provider Behavior

The provider factory becomes:

- `openai` -> generic OpenAI/OpenAI-compatible provider, Responses API only
- `azure-openai` -> Azure-aware provider with Azure-only URL-shape routing
- `anthropic` -> unchanged

Implementation options for `azure-openai`:

- use `@ai-sdk/azure` directly, if we want proper Azure semantics now
- or keep a minimal dedicated Azure wrapper around the existing OpenAI stack as
  an intermediate step

The key requirement is conceptual separation, not the specific SDK choice.

## Examples

### Direct OpenAI

```bash
npx -y sentry@latest mcp --access-token=TOKEN
```

Result: auto-detects `openai` when `OPENAI_API_KEY` is present and uses
Responses API.

### Generic OpenAI-Compatible Proxy

```bash
npx -y sentry@latest mcp \
  --access-token=TOKEN \
  --agent-provider=openai \
  --openai-base-url=https://proxy.example.com/v1 \
  --openai-model=my-company-assistant
```

Result: Responses API. `my-company-assistant` is treated as an opaque model or
deployment alias.

### Azure-Compatible Deployment Proxy

```bash
npx -y sentry@latest mcp \
  --access-token=TOKEN \
  --agent-provider=azure-openai \
  --openai-base-url=https://proxy.example.com/openai/deployments/my-assistant \
  --openai-model=my-assistant
```

Result: chat completions. `my-assistant` is treated as an opaque deployment
alias.

### Azure v1 Endpoint

```bash
export OPENAI_API_VERSION=2024-02-15-preview

npx -y sentry@latest mcp \
  --access-token=TOKEN \
  --agent-provider=azure-openai \
  --openai-base-url=https://my-resource.openai.azure.com/openai/v1/ \
  --openai-model=my-assistant
```

Result: Responses API on Azure v1, with `my-assistant` treated as an opaque
deployment alias.

## Startup Output

When an OpenAI-family provider is resolved, startup logs should show both the
provider and API surface. Examples:

- `Using openai responses API (generic OpenAI provider).`
- `Using azure-openai chat completions API (deployment-style Azure base URL).`
- `Using azure-openai responses API (Azure v1 base URL).`

This makes the compatibility path explicit.

## Implementation

1. Add `azure-openai` to the allowed embedded-agent provider values.
2. Keep generic `openai` on the Responses API only.
3. Add an `azure-openai` provider module.
4. Honor `OPENAI_API_VERSION` only in the `azure-openai` provider path.
5. Support Azure-only routing between:
   - `/openai/v1` -> Responses
   - `/openai/deployments/<deployment>` -> chat completions
6. Remove model-prefix routing logic and any canonical-model validation.
7. Update startup messages to show provider plus selected API surface.
8. Update docs and examples to steer Azure users toward
   `--agent-provider=azure-openai`.

## Testing

Add or update tests for:

- parsing and validation of `--agent-provider=azure-openai`
- explicit `EMBEDDED_AGENT_PROVIDER=azure-openai`
- generic `openai` staying on Responses API for custom base URLs
- `azure-openai` using Responses for `/openai/v1`
- `azure-openai` using chat completions for `/openai/deployments/<deployment>`
- opaque aliases such as `my-company-assistant`
- `gpt-*`-prefixed aliases that are not canonical model names
- `OPENAI_API_VERSION` being ignored outside `azure-openai`

Tests should assert request paths, not just selected models.

## Migration

- Existing direct OpenAI users remain on the generic `openai` provider and stay
  on Responses API.
- Existing generic proxy users remain on the generic `openai` provider and stay
  on Responses API.
- Azure users move from implicit OpenAI compatibility mode to explicit
  `azure-openai` mode.
- The “reject ambiguous deployment aliases” behavior should be removed rather
  than shipped.
- Documentation should stop claiming that deployment URLs require canonical
  OpenAI model names.

This introduces one explicit provider choice in exchange for removing hidden
heuristics.
