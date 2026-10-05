# Contributor Docs

This directory contains contributor documentation used by humans and LLMs. The
canonical workflow and required docs live in [../AGENTS.md](../AGENTS.md)
(`CLAUDE.md` is a symlink to the same file).

## Start Here

- Tool implementation: [contributing/adding-tools.md](contributing/adding-tools.md)
- Tool output policy: [contributing/tool-responses.md](contributing/tool-responses.md)
- Testing: [testing/overview.md](testing/overview.md)
- Shared implementation patterns: [contributing/common-patterns.md](contributing/common-patterns.md)

## Topic Map

### Contributing

- [contributing/adding-tools.md](contributing/adding-tools.md) - Tool structure, visibility, implementation, and registration
- [contributing/api-patterns.md](contributing/api-patterns.md) - Sentry API client and MSW patterns
- [contributing/coding-guidelines.md](contributing/coding-guidelines.md) - TypeScript and code style guidance
- [contributing/common-patterns.md](contributing/common-patterns.md) - Shared Zod, validation, and formatting patterns
- [contributing/documentation-style-guide.md](contributing/documentation-style-guide.md) - Documentation style guide
- [contributing/error-handling.md](contributing/error-handling.md) - Error hierarchy and propagation
- [contributing/pr-management.md](contributing/pr-management.md) - Commit and PR guidelines
- [contributing/quality-checks.md](contributing/quality-checks.md) - Quality gates and pre-commit checks
- [contributing/search-events-api-patterns.md](contributing/search-events-api-patterns.md) - Search Events API guidance
- [contributing/tool-responses.md](contributing/tool-responses.md) - User-facing tool output policy, snapshot review, and QA expectations

### Testing

- [testing/overview.md](testing/overview.md) - Unit, snapshot, eval, and agent CLI testing
- [testing/stdio.md](testing/stdio.md) - Stdio transport testing
- [testing/remote.md](testing/remote.md) - Remote server and OAuth testing

### Architecture And Operations

- [architecture/overview.md](architecture/overview.md) - System design
- [operations/embedded-agents.md](operations/embedded-agents.md) - Embedded LLM provider configuration
- [operations/github-actions.md](operations/github-actions.md) - GitHub Actions guidance
- [operations/logging.md](operations/logging.md) - Logging guidance
- [operations/monitoring.md](operations/monitoring.md) - Monitoring guidance
- [operations/oauth-signout-playbook.md](operations/oauth-signout-playbook.md) - Remote OAuth diagnostic runbook
- [operations/security.md](operations/security.md) - Authentication and security patterns
- [operations/stdio-auth.md](operations/stdio-auth.md) - Device code auth and token caching
- [operations/token-cost-tracking.md](operations/token-cost-tracking.md) - Tool definition token cost tracking

### Cloudflare

- [cloudflare/overview.md](cloudflare/overview.md) - Cloudflare package overview
- [cloudflare/architecture.md](cloudflare/architecture.md) - Cloudflare architecture
- [cloudflare/oauth-architecture.md](cloudflare/oauth-architecture.md) - Cloudflare OAuth architecture

### Integrations

- [integrations/claude-code-plugin.md](integrations/claude-code-plugin.md) - Plugin structure and agent prompts
- [integrations/ide-instructions-refactor.md](integrations/ide-instructions-refactor.md) - IDE instruction refactor notes

### Specs

- [specs/README.md](specs/README.md) - Specs index
- [specs/alert-rules.md](specs/alert-rules.md) - Alert inspection, editing, options, and connected sources
- [specs/embedded-agent-openai-routing.md](specs/embedded-agent-openai-routing.md) - Embedded agent OpenAI routing spec
- [specs/project-management.md](specs/project-management.md) - Project management tools spec
- [specs/remembered-oauth-skills.md](specs/remembered-oauth-skills.md) - Remembered OAuth skill defaults spec
- [specs/search-events.md](specs/search-events.md) - Search Events spec
- [specs/sentry-bearer-cloudflare-auth.md](specs/sentry-bearer-cloudflare-auth.md) - Direct Sentry token auth for the Cloudflare transport
- [specs/subpath-constraints.md](specs/subpath-constraints.md) - Subpath constraints spec

### Releases

- [releases/stdio.md](releases/stdio.md) - npm package release
- [releases/cloudflare.md](releases/cloudflare.md) - Cloudflare deployment

## Maintenance

Update docs when patterns change, new tools are added, or common issues arise.
Prefer cross-links over duplicated guidance: topic docs should link to the
canonical policy or pattern that owns the detail.
