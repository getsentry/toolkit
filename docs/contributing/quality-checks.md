# Quality Checks

Required checks before completing any code changes.

## Required Commands

```bash
pnpm run tsc && pnpm run lint && pnpm run test
```

Do not proceed if any check fails.

`pnpm run lint` includes `oxfmt --check`. If it fails, run `pnpm run format`.

## Package CI Checks

CI runs each workspace package's build, lint, typecheck, test, and E2E scripts
from `test.yml`. To add a check for one package, add a script and, if its name
is not a default, point `package.json#sentryCi` at it. Do not add a workflow.
See [Package CI checks](../operations/github-actions.md#package-ci-checks).

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
- [ ] Package-specific CI checks are in `package.json#sentryCi`, not a new workflow
- [ ] Documentation updated if patterns changed
