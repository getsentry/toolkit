# Contributing to Sentry CLI

This guide documents the patterns and conventions used in this CLI for consistency.

## Command Patterns

We follow [gh CLI](https://cli.github.com/) conventions for best-in-class developer experience.

### List Commands

List commands use **optional positional arguments** for context with smart auto-detection.

```bash
sentry org list [--limit N] [--json]
sentry project list [org] [--limit N] [--json]
sentry issue list [<org>/<project>] [--json]
```

**Target syntax**:
- `<org>/<project>` - Explicit organization and project (e.g., `my-org/frontend`)
- `<org>/` - All projects in the specified organization
- `<project>` - Search for project by name across all accessible organizations
- *(omit)* - Auto-detect from DSN or config

**Rationale**: Positional arguments follow `gh` CLI conventions and are more concise than flags.

### View Commands

View commands use **optional positional arguments** for the primary identifier, supporting auto-detection when omitted.

```bash
sentry org view [org-slug] [--json] [-w]                       # works with DSN if no arg
sentry project view [<org>/<project>] [--json] [-w]            # works with DSN if no arg
sentry issue view <issue-id> [<issue-id>...] [--json] [-w]     # one or more issue IDs
sentry event view [<org>/<project>] <event-id> [--json] [-w]   # event ID required
```

**Key insight**: `org view` and `project view` mirror `gh repo view` - works in context (DSN) or with explicit arg.

**Browser flag**: All view commands support `-w` (or `--web`) to open the resource in your default browser instead of displaying it in the terminal. Batch `issue view` opens at most 5 tabs unless `--force` is passed.

## Context Resolution

Context (org, project) is resolved in this priority order:

1. **Positional arguments** (`<org>/<project>`) - explicit, always wins
2. **Config defaults** - set via `sentry cli defaults`
3. **DSN auto-detection** - from `SENTRY_DSN` env var or source code

## Common Flags

| Flag | Description | Used In |
|------|-------------|---------|
| `--json` | Output as JSON | All view/list commands |
| `-w`, `--web` | Open in browser | All view commands |
| `--limit` | Max items to return | List commands |

## Error Handling

Use `ContextError` for missing required context. This provides consistent formatting:

```typescript
import { ContextError } from "../../lib/errors.js";

if (!resolved) {
  throw new ContextError(
    "Organization",                           // What is required
    "sentry org view <org-slug>",            // Primary usage
    ["Set SENTRY_DSN for auto-detection"]    // Alternatives
  );
}
```

This produces:

```
Organization is required.

Specify it using:
  sentry org view <org-slug>

Or:
  - Set SENTRY_DSN for auto-detection
```

## Adding New Commands

1. **Choose the right pattern**: list (flags only) or view (optional positional)
2. **Use existing utilities**: `resolveOrg()`, `resolveOrgAndProject()` from `lib/resolve-target.ts`
3. **Support JSON output**: All commands should have `--json` flag
4. **Support browser viewing**: View commands should have `-w`/`--web` flag
5. **Use ContextError**: For missing context errors, use `ContextError` class
6. **Add tests**: E2E tests in `test/e2e/` directory

## Code Style

- Use TypeScript strict mode
- Prefer explicit types over inference for public APIs
- Document functions with JSDoc comments
- Keep functions small and focused
