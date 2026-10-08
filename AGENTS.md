# AGENTS.md

Toolkit contains the Sentry CLI, the Sentry MCP server, and shared code. Product-specific instructions live in their packages; start with the shared [documentation index](docs/README.md).

## Principles

- **Type Safety**: Prefer strict types over `any` - they catch bugs and improve tooling. Use `unknown` for truly unknown types.
- **Security**: Never log secrets. Validate external input. See docs/operations/security.md.
- **Simplicity**: Follow existing patterns. Check neighboring files before inventing new approaches.

## Constraints

- **MCP tool count**: Target ≤20, hard limit 25 (AI agents have limited tool slots).
- **Quality gate**: `pnpm run tsc && pnpm run lint && pnpm run test` must pass before committing.

## Repository Structure

```
toolkit/
├── apps/
│   └── cli-docs/            # CLI documentation site and generated command pages
├── packages/
│   ├── cli/                 # Sentry CLI (see packages/cli/AGENTS.md)
│   ├── toolkit-core/        # Shared CLI/MCP primitives
│   ├── mcp-core/            # Core MCP implementation (private)
│   ├── mcp-server/          # stdio transport (@sentry/mcp-server on npm)
│   ├── mcp-cloudflare/      # Web app + OAuth
│   ├── mcp-server-evals/    # AI evaluation tests
│   ├── mcp-server-mocks/    # MSW mocks
│   └── mcp-test-client/     # CLI test client
└── docs/                    # Toolkit contributor docs for CLI and MCP
```

## Documentation Map

- docs/README.md — Toolkit documentation index
- docs/cli/README.md — CLI guides and the published CLI site
- docs/mcp/README.md — MCP guides across its packages
- packages/cli/AGENTS.md — CLI-specific rules

**Read before MCP tool changes:**

- docs/contributing/adding-tools.md — Tool implementation guide
- docs/contributing/tool-responses.md — Tool output policy and QA review checklist
- docs/testing/overview.md — Testing requirements and snapshot policy
- docs/contributing/common-patterns.md — Error handling, Zod schemas, shared formatting patterns
- docs/contributing/error-handling.md — Error types and propagation

**Shared contributing:**

- docs/contributing/coding-guidelines.md — TypeScript and code style guidance
- docs/contributing/documentation-style-guide.md — Documentation style guide
- docs/contributing/pr-management.md — Commit and PR guidelines
- docs/contributing/quality-checks.md — Pre-commit checklist

**MCP contributing:**

- docs/contributing/api-patterns.md — Sentry API client usage
- docs/contributing/search-events-api-patterns.md — Search Events API patterns

**MCP testing:**

- docs/testing/overview.md — Unit, snapshot, eval, and agent CLI testing
- docs/testing/stdio.md — Stdio transport testing
- docs/testing/remote.md — Remote server and OAuth testing

**MCP architecture and operations:**

- docs/architecture/overview.md — MCP system design
- docs/operations/security.md — Authentication and security patterns
- docs/operations/stdio-auth.md — Device code flow, token caching, client ID architecture
- docs/operations/oauth-signout-playbook.md — Remote OAuth diagnostic runbook
- docs/operations/embedded-agents.md — LLM provider configuration for AI-powered tools
- docs/operations/github-actions.md — MCP deployment workflows
- docs/operations/logging.md — Logging guidance
- docs/operations/monitoring.md — Monitoring guidance
- docs/operations/token-cost-tracking.md — Tool definition token cost tracking

**MCP Cloudflare:**

- docs/cloudflare/overview.md — Cloudflare package overview
- docs/cloudflare/architecture.md — Cloudflare architecture
- docs/cloudflare/oauth-architecture.md — Cloudflare OAuth architecture

**MCP integrations:**

- docs/integrations/claude-code-plugin.md — Plugin structure and agent prompts
- docs/integrations/ide-instructions-refactor.md — IDE instruction refactor notes

**MCP specs:**

- docs/specs/README.md — Specs index
- docs/specs/embedded-agent-openai-routing.md — Embedded agent OpenAI routing spec
- docs/specs/search-events.md — Search Events spec
- docs/specs/subpath-constraints.md — Subpath constraints spec

**MCP releases:**

- docs/releases/stdio.md — npm package release
- docs/releases/cloudflare.md — Cloudflare deployment

## Commands

```bash
# Development
pnpm run dev                              # Start MCP dev server
pnpm run build                            # Build non-CLI workspace packages
pnpm --filter sentry run cli help         # Run CLI help from repository root

# MCP testing
pnpm -w run cli --transport stdio "q"      # Test MCP tools
pnpm -w run cli --transport stdio --access-token=TOKEN "q"

# Quality (run before committing)
pnpm run tsc && pnpm run lint && pnpm run test

# Token overhead
pnpm run measure-tokens                   # Check tool definition size

# Definitions (run after changing tools, skills, or agent prompts)
pnpm run --filter @sentry/mcp-core generate-definitions
```

## QA Playbook

For MCP tool QA, use the `mcp-qa` skill at `.agents/skills/mcp-qa/SKILL.md`:
stdio-first local CLI and real agent clients; Cloudflare HTTP or `/mcp` only
for transport, OAuth, routing, or hosted-server compatibility.

## Task Management

Use `/dex` skill to coordinate complex work. Create tasks with full context, break down into subtasks, complete with detailed results.

## Workflow

1. Check neighboring files for existing patterns before writing new code.
2. When adding or modifying Sentry API endpoint usage, ALWAYS validate the endpoint behavior against the Sentry source code in `~/src/sentry` instead of assuming docs or client parameters are authoritative.
3. Update relevant docs when changing functionality.
4. Follow docs/contributing/error-handling.md for MCP error types and
   packages/cli/src/lib/errors.ts for CLI error classes.
5. Follow docs/contributing/pr-management.md for commits and PRs.

## Commit Attribution

AI commits MUST include:

```
Co-Authored-By: (the agent model's name and attribution byline)
```
