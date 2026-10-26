# Quality Checks

Required checks before completing any code changes.

## Required Commands

```bash
pnpm run tsc && pnpm run lint && pnpm run test
```

Do not proceed if any check fails.

`pnpm run lint` includes `oxfmt --check`. If it fails, run `pnpm run format`.

## Tool Count Limits

See [adding-tools.md](adding-tools.md#tool-count-limits) for current limits and guidance on when to add vs. combine tools.

## Testing Requirements

See [../testing/overview.md](../testing/overview.md) for testing philosophy,
patterns, and snapshot guidelines. Every tool must have at least one
happy-path inline snapshot test. Review tool output snapshots against
[tool-responses.md](tool-responses.md).

## Pre-Commit Checklist

- [ ] Quality checks pass (`pnpm run tsc && pnpm run lint && pnpm run test`)
- [ ] Tool count within limits
- [ ] New tools have tests with inline snapshots
- [ ] Tool/skill definitions regenerated if tools changed (`pnpm run --filter @sentry/mcp-core generate-definitions`)
- [ ] Documentation updated if patterns changed
