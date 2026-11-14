# Coding Guidelines

Repository-wide TypeScript and style guidance for Toolkit. See the
[CLI guide](../cli/README.md) and [MCP guide](../mcp/README.md) for
product-specific implementation patterns.

## TypeScript Configuration

Every first-party TypeScript file is type-checked with TypeScript 7 (`tsc`
from the `typescript` catalog entry).

- **Shared base.** Every project extends the root `tsconfig.base.json`. Its
  checking options apply everywhere. They include `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, and
  `skipLibCheck: false`. A project sets only its runtime: `target`, `module`,
  `moduleResolution`, `lib`, `types`, JSX, and emit. The codemod is the one
  exception: `jssg` cannot follow an `extends` outside its package, so its
  tsconfig repeats the checking options.
- **Don't weaken the policy.** `scripts/tsconfig-policy.test.mjs` runs in CI. It
  fails when a project overrides a policy option, when a tracked TypeScript file
  is in no checked program, or when a package that has a `tsconfig.json` has no
  `typecheck` script.
- **Library-check exceptions.** If a dependency's declarations fail and no
  dependency fix exists, set `skipLibCheck: true` in the affected program only.
  Add one comment line per dependency:
  `// skipLibCheck exception: <dependency> <diagnostic>. Remove when <condition>.`
- **Running the check.** `pnpm run typecheck` builds the workspace and runs
  every package's `typecheck` script; `pnpm run tsc` is an alias. In a package,
  run `pnpm run typecheck`. CI runs each package's script through
  `package.json#sentryCi`. If results look stale after a tsconfig change,
  delete the package's `node_modules/.tmp` build info.
- **Optional properties.** Under `exactOptionalPropertyTypes`, `x?: T` does not
  accept `undefined`. Omit the key with a conditional spread, or with
  `omitUndefined()` in mcp-core. Declare `x?: T | undefined` only when callers
  forward a value that can be undefined, such as an optional zod field.
- **Compiler API.** TypeScript 7 has no JavaScript compiler API. Code that
  parses or prints TypeScript imports `@typescript/typescript6`. `tsc` stays
  on TypeScript 7.
- **Known exceptions.** `apps/cli-docs` runs `astro check` on TypeScript 6
  (the `astro-check` catalog) until `@astrojs/check` supports TypeScript 7.
  `@sentry/mcp-core` emits declarations through tsdown's tsgo backend.
- **tsrs (experimental, opt-in).** [tsrs](https://github.com/oxc-project/tsrs)
  is a faster TypeScript-compatible checker. Toolkit doesn't depend on it, and
  CI never runs it. Oxlint picks `tsrs-lint` automatically when the package is
  installed, so keep it out of the workspace: install it into a scratch
  directory and select it explicitly.

  ```bash
  npm install --prefix ~/.cache/tsrs tsrs@0.25.0-ts7.1.0-beta
  # Type-aware lint with the tsrs backend (same diagnostics, ~3x faster here):
  OXLINT_TSGOLINT_PATH=~/.cache/tsrs/node_modules/.bin/tsrs-lint pnpm exec oxlint .
  # Check one program:
  ~/.cache/tsrs/node_modules/.bin/tsrs -p packages/cli/tsconfig.json --noEmit
  ```

  tsrs implements TypeScript 7.1 beta, so it can report errors that the
  TypeScript 7.0 gate doesn't. `pnpm run typecheck` decides. Don't use
  `--fast` mode, which has reported false errors here. Don't use
  `oxlint --type-check` as a substitute for `typecheck` either: it checks each
  file under one tsconfig, so it misses programs such as toolkit-core's
  browser build.

## Code Style

### Formatting and linting

- 2 spaces, double quotes, semicolons
- Formatter width: 80 characters
- Trailing commas in multiline
- Root, MCP, and CLI files use Oxlint and Oxfmt. The CLI-specific rules live in
  `packages/cli/lint-rules/cli-oxlint-plugin.js`, with inline Oxlint suppressions
  for intentional exceptions.
- Write new lint rules for Oxlint: turn on a built-in rule in `.oxlintrc.json`
  (for example `no-restricted-imports`), or add a custom rule to the Oxlint JS
  plugin above and register it in `.oxlintrc.json`. Do not add new ast-grep
  rules; the few left in `ast-grep-rules/` predate this.
- Oxlint runs type-aware (`options.typeAware` in `.oxlintrc.json`, backed by
  `oxlint-tsgolint`). `typescript/return-await` (`always`) is on repo-wide:
  write `return await` in async functions so callers stay in async stack
  traces.
- Repo-wide promise and error rules: `no-misused-promises`,
  `switch-exhaustiveness-check` (a `default` branch counts),
  `only-throw-error`, `prefer-promise-reject-errors`, `no-base-to-string`, and
  `no-unsafe-enum-comparison`. In the CLI, rethrow a caught value recorded
  earlier (for example by a callback) with `rethrow()` from
  `src/lib/rethrow.ts`, so it reaches callers unchanged.
- Non-test source outside the CLI also gets `no-explicit-any`,
  `no-non-null-assertion`, `no-unnecessary-condition`, and the `no-unsafe-*`
  rules. Validate untrusted data (zod or a type guard) instead of reading it as
  `any`. `packages/cli/src` already bans `any` and `!`.
- Type-aware lint reads workspace packages through their built declarations.
  Build them before linting, or imports read as error types:
  `pnpm --filter '@sentry/mcp-core...' --filter @sentry/logger run build`.
- Copy and combine iterables with spread: `[...set]`, `[...a, ...b]`,
  `[...path, key]`. `unicorn/prefer-spread` enforces this repo-wide and
  autofixes `Array.from(x)` and `.slice()`. Spread rejects non-iterables at
  compile time and at runtime, where `Array.from` accepts any `{ length }`
  object. Keep `Array.from` for array-likes and `Array.from({ length: n }, fn)`.
  To walk a string's UTF-16 code units, use `split("")`. Spread a string only
  when you mean code points, and suppress `typescript/no-misused-spread` with
  the reason.
- Don't pass an async callback to `.catch()`. Use `try`/`await`/`catch`, or a
  wrapper such as `withDashboardErrors(ctx, fn)`. The `no-async-catch-callback`
  ast-grep rule enforces this.
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
pnpm -w run typecheck   # Type check every package
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
