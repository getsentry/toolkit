# Coding Guidelines

Repository-wide TypeScript and style guidance for Toolkit. See the
[CLI guide](../cli/README.md) and [MCP guide](../mcp/README.md) for
product-specific implementation patterns.

## TypeScript Configuration

```typescript
// tsconfig.json essentials
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "sourceMap": true,
    "noImplicitAny": true
  }
}
```

## Code Style

### Formatting and linting

- 2 spaces, double quotes, semicolons
- Formatter width: 80 characters
- Trailing commas in multiline
- Root, MCP, and CLI files use Oxlint and Oxfmt. The CLI-specific rules live in
  `packages/cli/lint-rules/cli-oxlint-plugin.js`, with inline Oxlint suppressions
  for intentional exceptions.
- VS Code uses the Oxc extension for formatting and linting. Run
  `pnpm exec oxfmt --write <file>` to format a file.

### Naming Conventions

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types/Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

### Import Order

```typescript
// 1. Node built-ins
import { readFile } from "node:fs/promises";
// 2. External deps
import { z } from "zod";
// 3. Internal packages
import { mockData } from "@sentry-mcp/mocks";
// 4. Relative imports
import { UserInputError } from "./errors.js";
```

## MCP Tool Implementation

```typescript
export const toolName = {
  description: "Clear, concise description",
  parameters: z.object({
    required: z.string().describe("Description"),
    optional: z.string().optional(),
  }),
  execute: async (params, context) => {
    // 1. Validate inputs
    // 2. Call API
    // 3. Format output
    return formatResponse(data);
  },
};
```

## Testing Standards

```typescript
describe("Component", () => {
  it("handles normal case", async () => {
    // Arrange
    const input = createTestInput();

    // Act
    const result = await method(input);

    // Assert
    expect(result).toMatchInlineSnapshot();
  });
});
```

Key practices:

- Use inline snapshots for formatting
- Mock with MSW
- Test success and error paths
- Keep tests isolated

## Quality Checklist

Before committing:

```bash
pnpm -w run lint        # Oxlint and ast-grep checks for root, MCP, and CLI
pnpm -w run lint:fix    # Fix issues
pnpm -w run format      # Format with Oxfmt
pnpm --filter sentry run lint  # CLI-specific lint and format checks
pnpm tsc --noEmit       # Type check
pnpm test               # Run tests
pnpm -w run build       # Build all
```

## JSDoc Pattern

````typescript
/**
 * Brief description.
 *
 * @param param - Description
 * @returns What it returns
 *
 * @example
 * ```typescript
 * const result = func(param);
 * ```
 */
````

## Security Essentials

- Never commit secrets
- Validate all inputs
- Use environment variables
- Sanitize displayed data

## Common Patterns

For shared patterns see:

- Error handling: [common-patterns.md](common-patterns.md#error-handling)
- Zod schemas: [common-patterns.md](common-patterns.md#zod-schema-patterns)
- API usage: [api-patterns.md](api-patterns.md)
- Testing: [../testing/overview.md](../testing/overview.md)

## Monorepo Commands

```bash
# Workspace-wide (from root)
pnpm -w run lint

# Package-specific (from package dir)
pnpm test
```

## References

- Architecture: [../architecture/overview.md](../architecture/overview.md)
- Testing guide: [../testing/overview.md](../testing/overview.md)
- API patterns: [api-patterns.md](api-patterns.md)
- Common patterns: [common-patterns.md](common-patterns.md)
