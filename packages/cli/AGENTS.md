# AGENTS.md

Guidelines for AI agents working in this codebase.

## Project Overview

**Sentry CLI** is a command-line interface for [Sentry](https://sentry.io), built with Node.js, [pnpm](https://pnpm.io), and [Stricli](https://bloomberg.github.io/stricli/). It lives in `packages/cli` of a pnpm workspace; the docs site lives in `apps/cli-docs`.

### Goals

- **Zero-config experience** - Auto-detect project context from DSNs in source code and env files
- **AI-powered debugging** - Integrate Seer AI for root cause analysis and fix plans
- **Developer-friendly** - Follow `gh` CLI conventions for intuitive UX
- **Agent-friendly** - JSON output and predictable behavior for AI coding agents
- **Fast** - Native binaries via Node SEA (fossilize), SQLite caching for API responses

### Key Features

- **DSN Auto-Detection** - Scans `.env` files and source code (JS, Python, Go, Java, Ruby, PHP) to find Sentry DSNs
- **Project Root Detection** - Walks up from CWD to find project boundaries using VCS, language, and build markers
- **Directory Name Inference** - Fallback project matching using bidirectional word boundary matching
- **Multi-Region Support** - Automatic region detection with fan-out to regional APIs (us.sentry.io, de.sentry.io)
- **Monorepo Support** - Generates short aliases for multiple projects
- **Seer AI Integration** - `issue explain` and `issue plan` commands for AI analysis
- **OAuth Device Flow** - Secure authentication without browser redirects

## Cursor Rules (Important!)

Before working on this codebase, read the Cursor rules:

- **`.cursor/rules/oxc.mdc`** - Code style, formatting, linting rules

## Quick Reference: Commands

> **Note**: Always check `package.json` for the latest scripts. All commands run
> from `packages/cli` (or via `pnpm --filter sentry run <script>` from the repo root).

```bash
# Development
pnpm install                             # Install dependencies (from repo root)
pnpm run dev                             # Run CLI in dev mode
pnpm run cli -- <args>                   # Run the CLI with arguments

# Build
pnpm run build                           # Build for current platform
pnpm run build:all                       # Build for all platforms

# Type Checking
pnpm run typecheck                       # Check types (tsc)

# Linting & Formatting
pnpm run lint                            # Check Oxlint and Oxfmt
pnpm run lint:fix                        # Auto-fix issues (run before committing)

# Testing (Vitest)
pnpm run test:unit                       # Run unit tests
pnpm run test:e2e                        # Run e2e tests
pnpm exec vitest run test/lib/foo.test.ts # Run a single test file (skips generate steps)
pnpm exec vitest                         # Watch mode
```

## Rules: No Runtime Dependencies

**CRITICAL**: All packages must be in `devDependencies`, never `dependencies`. Everything is bundled at build time via esbuild. CI enforces this with `pnpm run check:deps`.

When adding a package, always use `pnpm add -D <package>` (the `-D` flag).

When the `@sentry/api` SDK provides types for an API response, import them directly from `@sentry/api` instead of creating redundant Valibot schemas in `src/types/sentry.ts`.

## Rules: Use Node.js APIs

**CRITICAL**: This project runs on Node.js. Use Node.js standard-library
(`node:*`) APIs; there is no Bun runtime. (This project was migrated from Bun to
Node — do not reintroduce `Bun.*` globals, `bun:test`, or `bun` CLI commands.)

### Quick API Reference

| Task | Use This |
|------|----------|
| Read file | `await readFile(path, "utf-8")` (`node:fs/promises`) |
| Write file | `await writeFile(path, content)` (`node:fs/promises`) |
| Check file exists | `existsSync(path)` (`node:fs`) |
| Spawn process | `spawn()` / `execFile()` (`node:child_process`) |
| Shell commands | `execSync()` (`node:child_process`) |
| Find executable | `which` helper in `src/lib/which.ts` |
| Glob patterns | the scanner in `src/lib/scan/` |
| Sleep | `await setTimeout(ms)` (`node:timers/promises`) |
| Parse JSON file | `JSON.parse(await readFile(path, "utf-8"))` |

Use `node:fs` for directory creation with permissions:
```typescript
import { mkdirSync } from "node:fs";
mkdirSync(dir, { recursive: true, mode: 0o700 });
```

For shell commands, prefer `execFileSync` with array args over `execSync` with a
string when passing user-controlled values, to avoid shell injection:
```typescript
import { execFileSync } from "node:child_process";
const result = execFileSync("id", ["-u", "username"], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
```

## Architecture

The full project-structure tree — including the live command/subcommand list and the
domain API modules — is generated from the route tree and lives in
[`apps/cli-docs/src/content/docs/contributing.md`](apps/cli-docs/src/content/docs/contributing.md)
(the `project-structure` block produced by `script/generate-docs-sections.ts`). It is
kept in sync automatically, so it is **not** duplicated here to avoid drift. For the
current command list run `ls src/commands/` or `sentry --help`.

Top-level layout:

- **`src/bin.ts`** — entry point; **`src/app.ts`** — Stricli application setup;
  **`src/context.ts`** — dependency-injection context.
- **`src/commands/`** — one directory per command group (`agent-conversation`,
  `alert`, `auth`, `build`, `cli`, `code-mappings`, `dart-symbol-map`,
  `dashboard`, `debug-files`, `docs`, `event`, `feedback`, `issue`, `local`,
  `log`, `monitor`, `org`, `platform`, `proguard`, `project`, `react-native`,
  `release`, `replay`, `repo`, `snapshots`, `sourcemap`, `span`, `status`,
  `team`, `trace`, `trial`) plus standalone command files (`api.ts`,
  `explore.ts`, `help.ts`, `info.ts`, `init.ts`, `schema.ts`,
  `wasm-split.ts`).
- **`src/lib/`** — shared utilities. Key subtrees: `api/` (domain API modules),
  `db/` (SQLite layer), `dsn/` (DSN detection, with per-language extractors under
  `dsn/languages/`), and `formatters/` (output formatting). See the file-locations
  table below and the JSDoc in each module for details.
- **`src/types/`** — TypeScript types and Valibot schemas.
- **`test/`** — tests mirroring `src/` (unit, `*.property.test.ts`,
  `*.model-based.test.ts`, `e2e/`, `fixtures/`, `mocks/`).
- **`../../apps/cli-docs/`** — documentation site (Astro + Starlight);
  **`script/`** — build/utility scripts; **`.cursor/rules/`** — Cursor AI rules;
  **`lint-rules/cli-oxlint-plugin.js`** — CLI-specific lint rules.

## Key Patterns

### CLI Commands (Stricli)

Commands use [Stricli](https://bloomberg.github.io/stricli/docs/getting-started/principles) wrapped by `src/lib/command.ts`.

**CRITICAL**: Import `buildCommand` from `../../lib/command.js`, **NEVER** from `@stricli/core` directly — the wrapper adds telemetry, `--json`/`--fields` injection, and output rendering.

Pattern:

```typescript
import { buildCommand } from "../../lib/command.js";
import type { SentryContext } from "../../context.js";
import { CommandOutput } from "../../lib/formatters/output.js";

export const myCommand = buildCommand({
  docs: {
    brief: "Short description",
    fullDescription: "Detailed description",
  },
  output: {
    human: formatMyData,                // (data: T) => string
    jsonTransform: jsonTransformMyData, // optional: (data: T, fields?) => unknown
    jsonExclude: ["humanOnlyField"],    // optional: strip keys from JSON
  },
  parameters: {
    flags: {
      limit: { kind: "parsed", parse: Number, brief: "Max items", default: 10 },
    },
  },
  async *func(this: SentryContext, flags) {
    const data = await fetchData();
    yield new CommandOutput(data);
    return { hint: "Tip: use --json for machine-readable output" };
  },
});
```

**Key rules:**
- Functions are `async *func()` generators — yield `new CommandOutput(data)`, return `{ hint }`.
- `output.human` receives the same data object that gets serialized to JSON — no divergent-data paths.
- The wrapper auto-injects `--json` and `--fields` flags. Do NOT add your own `json` flag.
- Do NOT use `stdout.write()` or `if (flags.json)` branching — the wrapper handles it.

### Command File Structure

Command files in `src/commands/` should focus on three concerns:
1. **Argument parsing** — positional args, flags, URL detection
2. **API orchestration** — fetching data, error handling, enrichment
3. **Output dispatch** — `yield new CommandOutput(data)`

Formatting and rendering logic belongs in `src/lib/formatters/<domain>.ts`. If a command file exceeds ~400 lines, extract formatting helpers into a dedicated formatter module.

Reference: `src/lib/formatters/replay.ts` (extracted from `replay/view.ts`), `src/lib/formatters/trace.ts`, `src/lib/formatters/human.ts`.

Lint enforcement: `stderr.write()` is banned in command files (GritQL rule). Use `logger` for diagnostics and `CommandOutput` for data output.

### Route Maps (Stricli)

Route groups use Stricli's `buildRouteMap` wrapped by `src/lib/route-map.ts`.

**CRITICAL**: Import `buildRouteMap` from `../../lib/route-map.js`, **NEVER** from `@stricli/core` directly — the wrapper auto-injects standard subcommand aliases based on which route keys exist:

| Route    | Auto-aliases   |
|----------|----------------|
| `list`   | `ls`           |
| `view`   | `show`         |
| `delete` | `remove`, `rm` |
| `create` | `new`          |

Manually specified aliases in `aliases` are merged with (and take precedence over) auto-generated ones. Do NOT manually add aliases that are already in the standard set above.

```typescript
import { buildRouteMap } from "../../lib/route-map.js";

export const myRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
  },
  defaultCommand: "view",
  // No need for aliases — ls, show, and new are auto-injected.
  // Only add aliases for non-standard mappings:
  // aliases: { custom: "list" },
  docs: {
    brief: "Manage my resources",
  },
});
```

### Positional Arguments

Use `parseSlashSeparatedArg` from `src/lib/arg-parsing.ts` for the standard `[<org>/<project>/]<id>` pattern. Required identifiers (trace IDs, span IDs) should be **positional args**, not flags.

```typescript
import { parseSlashSeparatedArg, parseOrgProjectArg } from "../../lib/arg-parsing.js";

// "my-org/my-project/abc123" → { id: "abc123", targetArg: "my-org/my-project" }
const { id, targetArg } = parseSlashSeparatedArg(first, "Trace ID", USAGE_HINT);
const parsed = parseOrgProjectArg(targetArg);
// parsed.type: "auto-detect" | "explicit" | "project-search" | "org-all"
```

Reference: `span/list.ts`, `trace/view.ts`, `event/view.ts`

### Multiple Values in Arguments

Split by argument type — do not mix the conventions:

- **Required positionals → space-separated variadic.** Declare the arg as
  variadic and accept repeated tokens: `issue merge A B C`,
  `project create web:javascript api:python-django`. Do not split positional
  values on commas; commas may be part of the value. Every project passed to
  `project create` requires a `name:platform` pair — there is no space-separated
  form, with or without an explicit org. Project names cannot contain whitespace.
- **Exception: opted-in `org/project` list selectors.** Commands whose API can
  query several projects together may parse their single optional target token
  as a list because Sentry slugs cannot contain commas. For example,
  `issue list acme/web,api` selects two projects. Pass
  `{ multi: true }` to `parseOrgProjectArg`; never enable it for
  mutation or single-project commands.
- **Optional flags → comma-separated (sometimes also repeatable).** Split the
  flag value on `,`: `--features errors,tracing`, set-commits `--path a,b`,
  `auth login --scope a,b`. Use `value.split(",")` (repeatable array flags:
  `flags.x.flatMap((v) => v.split(","))`).

Reference: `project/create.ts`, `release/set-commits.ts` (`--path`), `auth/login.ts` (`--scope`)

### Markdown Rendering

All non-trivial human output must use the markdown rendering pipeline:

- Build markdown strings with helpers: `mdKvTable()`, `colorTag()`, `escapeMarkdownCell()`, `renderMarkdown()`
- **NEVER** use raw `muted()` / chalk in output strings — use `colorTag("muted", text)` inside markdown
- Tree-structured output (box-drawing characters) that can't go through `renderMarkdown()` should use the `plainSafeMuted` pattern: `isPlainOutput() ? text : muted(text)`
- `isPlainOutput()` precedence: `SENTRY_PLAIN_OUTPUT` > `NO_COLOR` > `FORCE_COLOR` (TTY only) > `!isTTY`
- `isPlainOutput()` lives in `src/lib/formatters/plain-detect.ts` (re-exported from `markdown.ts` for compat)

Reference: `formatters/trace.ts` (`formatAncestorChain`), `formatters/human.ts` (`plainSafeMuted`)

### Create & Delete Command Standards

Mutation (create/delete) commands use shared infrastructure from `src/lib/mutate-command.ts`,
paralleling `list-command.ts` for list commands.

**Delete commands** MUST use `buildDeleteCommand()` instead of `buildCommand()`. It:
1. Auto-injects `--yes`, `--force`, `--dry-run` flags with `-y`, `-f`, `-n` aliases
2. Runs a non-interactive safety guard before `func()` — refuses to proceed if
   stdin is not a TTY and `--yes`/`--force` was not passed (dry-run bypasses)
3. Options to skip specific injections (`noForceFlag`, `noDryRunFlag`, `noNonInteractiveGuard`)

```typescript
import { buildDeleteCommand, confirmByTyping, isConfirmationBypassed, requireExplicitTarget } from "../../lib/mutate-command.js";

export const deleteCommand = buildDeleteCommand({
  // Same args as buildCommand — flags/aliases auto-injected
  async *func(this: SentryContext, flags, target) {
    requireExplicitTarget(parsed, "Entity", "sentry entity delete <target>");
    if (flags["dry-run"]) { yield preview; return; }
    if (!isConfirmationBypassed(flags)) {
      if (!await confirmByTyping(expected, promptMessage)) return;
    }
    await doDelete();
  },
});
```

**Create commands** import `DRY_RUN_FLAG` and `DRY_RUN_ALIASES` for consistent dry-run support:

```typescript
import { DRY_RUN_FLAG, DRY_RUN_ALIASES } from "../../lib/mutate-command.js";

// In parameters:
flags: { "dry-run": DRY_RUN_FLAG, team: { ... } },
aliases: { ...DRY_RUN_ALIASES, t: "team" },
```

**Key utilities** in `mutate-command.ts`:
- `isConfirmationBypassed(flags)` — true if `--yes` or `--force` is set
- `guardNonInteractive(flags)` — throws in non-interactive mode without `--yes`
- `confirmByTyping(expected, message)` — type-out confirmation prompt
- `requireExplicitTarget(parsed, entityType, usage)` — blocks auto-detect for safety
- `DESTRUCTIVE_FLAGS` / `DESTRUCTIVE_ALIASES` — spreadable bundles for manual use

### List Command Pagination

All list commands with API pagination MUST use the shared cursor-stack
infrastructure for **bidirectional** pagination (`-c next` / `-c prev`):

```typescript
import { LIST_CURSOR_FLAG } from "../../lib/list-command.js";
import {
  buildPaginationContextKey, resolveCursor,
  advancePaginationState, hasPreviousPage,
} from "../../lib/db/pagination.js";

export const PAGINATION_KEY = "my-entity-list";

// In buildCommand:
flags: { cursor: LIST_CURSOR_FLAG },
aliases: { c: "cursor" },

// In func():
const contextKey = buildPaginationContextKey("entity", `${org}/${project}`, {
  sort: flags.sort, q: flags.query,
});
const { cursor, direction } = resolveCursor(flags.cursor, PAGINATION_KEY, contextKey);
const { data, nextCursor } = await listEntities(org, project, { cursor, ... });
advancePaginationState(PAGINATION_KEY, contextKey, direction, nextCursor);
const hasPrev = hasPreviousPage(PAGINATION_KEY, contextKey);
const hasMore = !!nextCursor;
```

**Cursor stack model:** The DB stores a JSON array of page-start cursors
plus a page index. Each entry is an opaque string — plain API cursors,
compound cursors (issue list), or extended cursors with mid-page bookmarks
(dashboard list). `-c next` increments the index, `-c prev` decrements it,
`-c first` resets to 0. The stack truncates on back-then-forward to avoid
stale entries. `"last"` is a silent alias for `"next"`.

**Hint rules:** Show `-c prev` when `hasPreviousPage()` returns true.
Show `-c next` when `hasMore` is true. Include both `nextCursor` and
`hasPrev` in the JSON envelope.

**Navigation hint generation:** Use `paginationHint()` from
`src/lib/list-command.ts` to build bidirectional navigation strings.
Pass it pre-built `prevHint`/`nextHint` command strings and it returns
the combined `"Prev: X | Next: Y"` string (or single-direction, or `""`).
Do NOT assemble `navParts` arrays manually — the shared helper ensures
consistent formatting across all list commands.

```typescript
import { paginationHint } from "../../lib/list-command.js";

const nav = paginationHint({
  hasPrev,
  hasMore,
  prevHint: `sentry entity list ${org}/ -c prev`,
  nextHint: `sentry entity list ${org}/ -c next`,
});
if (items.length === 0 && nav) {
  hint = `No entities on this page. ${nav}`;
} else if (hasMore) {
  header = `Showing ${items.length} entities (more available)\n${nav}`;
} else if (nav) {
  header = `Showing ${items.length} entities\n${nav}`;
}
```

**Three abstraction levels for list commands** (prefer the highest level
that fits your use case):

1. **`buildOrgListCommand`** (team/repo list) — Fully automatic. Pagination
   hints, cursor management, JSON envelope, and human formatting are all
   handled internally. New simple org-scoped list commands should use this.

2. **`dispatchOrgScopedList` with overrides** (project/issue list) — Automatic
   for most modes; custom `"org-all"` override calls `resolveCursor` +
   `advancePaginationState` + `paginationHint` manually.

3. **`buildListCommand` with manual pagination** (trace/span/dashboard list) —
   Command manages its own pagination loop. Must call `resolveCursor`,
   `advancePaginationState`, `hasPreviousPage`, and `paginationHint` directly.

**Auto-pagination for large limits:**

When `--limit` exceeds `API_MAX_PER_PAGE` (100), list commands MUST transparently
fetch multiple pages to fill the requested limit. Cap `perPage` at
`Math.min(flags.limit, API_MAX_PER_PAGE)` and loop until `results.length >= limit`
or pages are exhausted. This matches the `listIssuesAllPages` pattern.

```typescript
const perPage = Math.min(flags.limit, API_MAX_PER_PAGE);
for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
  const { data, nextCursor } = await listPaginated(org, { perPage, cursor });
  results.push(...data);
  if (results.length >= flags.limit || !nextCursor) break;
  cursor = nextCursor;
}
```

Never pass a `per_page` value larger than `API_MAX_PER_PAGE` to the API — the
server silently caps it, causing the command to return fewer items than requested.

Reference template: `trace/list.ts`, `span/list.ts`, `dashboard/list.ts`

### ID Validation

Use shared validators from `src/lib/hex-id.ts`:
- `validateHexId(value, label)` — 32-char hex IDs (trace IDs, log IDs). Auto-strips UUID dashes.
- `validateSpanId(value)` — 16-char hex span IDs. Auto-strips dashes.
- `validateTraceId(value)` — thin wrapper around `validateHexId` in `src/lib/trace-id.ts`.

All normalize to lowercase. Throw `ValidationError` on invalid input.

### Sort Convention

Use `"date"` for timestamp-based sort (not `"time"`). Export sort types from the API layer (e.g., `SpanSortValue` from `api/traces.ts`), import in commands. This matches `issue list`, `trace list`, and `span list`.

### Generated Docs & Skills

All command docs and skill files are generated via `pnpm run generate:docs` (which runs `generate:command-docs` then `generate:skill`). This runs automatically as part of `dev`, `build`, `typecheck`, and `test` scripts.

- **Command docs** (`docs/src/content/docs/commands/*.md`) are **gitignored** and generated from CLI metadata + hand-written fragments in `docs/src/fragments/commands/`.
- **Skill files** (`plugins/sentry-cli/skills/sentry-cli/`) are **committed** (consumed by external plugin systems) and auto-committed by CI when stale.
- Edit fragments in `docs/src/fragments/commands/` for custom examples and guides.
- `pnpm run check:fragments` validates fragment ↔ route consistency.
- Positional `placeholder` values must be descriptive: `"org/project/trace-id"` not `"args"`.

### Valibot Schemas for Validation

All config and API types use Valibot schemas:

```typescript
import { type InferOutput, object, string, optional, number } from "valibot";

export const MySchema = object({
  field: string(),
  optional: optional(number()),
});

export type MyType = InferOutput<typeof MySchema>;

// Validate data
import { safeParse } from "valibot";
const result = safeParse(MySchema, data);
if (result.success) {
  // result.output is typed
}
```

### Type Organization

- Define Valibot schemas alongside types in `src/types/*.ts`
- Key type files: `sentry.ts` (API types), `config.ts` (configuration), `oauth.ts` (auth flow), `seer.ts` (Seer AI)
- Re-export from `src/types/index.ts`
- Use `type` imports: `import type { MyType } from "../types/index.js"`

### SQL Utilities

Use the `upsert()` helper from `src/lib/db/utils.ts` to reduce SQL boilerplate:

```typescript
import { upsert, runUpsert } from "../db/utils.js";

// Generate UPSERT statement
const { sql, values } = upsert("table", { id: 1, name: "foo" }, ["id"]);
db.query(sql).run(...values);

// Or use convenience wrapper
runUpsert(db, "table", { id: 1, name: "foo" }, ["id"]);

// Exclude columns from update
const { sql, values } = upsert(
  "users",
  { id: 1, name: "Bob", created_at: now },
  ["id"],
  { excludeFromUpdate: ["created_at"] }
);
```

### Error Handling

All CLI errors extend the `CliError` base class from `src/lib/errors.ts`:

```typescript
// Error hierarchy in src/lib/errors.ts
// Exit codes are defined in the EXIT constant object — use EXIT.* constants
// when constructing errors, never hardcode numeric exit codes outside errors.ts.
CliError (base, exitCode=1)
├── HostScopeError (exitCode=13)
├── ApiError (exitCode=30 — HTTP/API failures)
├── AuthError (exitCode=10–12 by reason — 'not_authenticated' | 'expired' | 'invalid')
├── ConfigError (exitCode=20 — configuration/DSN)
├── OutputError (exitCode=60 — data rendered, but operation failed)
├── ContextError (exitCode=22 — missing context)
├── ResolutionError (exitCode=23 — value provided but not found)
├── ValidationError (exitCode=21 — input validation)
├── DeviceFlowError (exitCode=51 — OAuth flow)
├── SeerError (exitCode=40–42 by reason — 'not_enabled' | 'no_budget' | 'ai_disabled')
├── TimeoutError (exitCode=31 — operation timed out)
├── UpgradeError (exitCode=50 — upgrade failures)
└── WizardError (exitCode=61–64 by workflow step — init wizard error)
```

> Exit code ranges: 1x=auth, 2x=input/config, 3x=API/network, 4x=feature/billing,
> 5x=operations, 6x=command-specific. See `EXIT` in `src/lib/errors.ts` and
> https://cli.sentry.dev/exit-codes/ for the full reference.

**Choosing between ContextError, ResolutionError, and ValidationError:**

| Scenario | Error Class | Example |
|----------|-------------|---------|
| User **omitted** a required value | `ContextError` | No org/project provided |
| User **provided** a value that wasn't found | `ResolutionError` | Project 'cli' not found |
| User input is **malformed** | `ValidationError` | Invalid hex ID format |

**ContextError rules:**
- `command` must be a **single-line** CLI usage example (e.g., `"sentry org view <slug>"`)
- Constructor throws if `command` contains `\n` (catches misuse in tests)
- Pass `alternatives: []` when defaults are irrelevant (e.g., for missing Trace ID, Event ID)
- Use `" and "` in `resource` for plural grammar: `"Trace ID and span ID"` → "are required"

**CI enforcement:** `pnpm run check:errors` scans for `ContextError` with multiline commands and `CliError` with ad-hoc "Try:" strings. Silent `catch` blocks are enforced separately by the `no-silent-catch` CLI Oxlint rule (see below).

```typescript
// Usage examples
throw new ContextError("Organization", "sentry org view <org-slug>");
throw new ContextError("Trace ID", "sentry trace view <trace-id>", []); // no alternatives
throw new ResolutionError("Project 'cli'", "not found", "sentry issue list <org>/cli", [
  "No project with this slug found in any accessible organization",
]);
throw new ValidationError("Invalid trace ID format", "traceId");
```

**Fuzzy suggestions in resolution errors:**

When a user-provided name/title doesn't match any entity, use `fuzzyMatch()` from
`src/lib/fuzzy.ts` to suggest similar candidates instead of listing all entities
(which can be overwhelming). Show at most 5 fuzzy matches.

Reference: `resolveDashboardId()` in `src/commands/dashboard/resolve.ts`.

### Catch Block Logging

Silent `catch` blocks are prohibited in `src/` production code. Both empty `catch {}` blocks and blocks that only return without logging discard errors and make debugging impossible.

Every `catch` block must either:
1. Re-throw the error
2. Log with `log.debug()` or `log.warn()` for diagnostic visibility
3. Return a fallback value **with** a `log.debug()` call explaining the suppression

```typescript
// WRONG — error vanishes silently
try { data = await fetchOptionalData(); }
catch { return []; }

// RIGHT — error is visible in debug logs
try { data = await fetchOptionalData(); }
catch (error) {
  log.debug("Failed to fetch optional data", error);
  return [];
}
```

Use `logger.withTag("command-name")` for tagged logging in command files.

**CI enforcement:** the `no-silent-catch` CLI Oxlint rule
(`lint-rules/cli-oxlint-plugin.js`, registered in the root `.oxlintrc.json`) flags `catch`
blocks — statement and `.catch()` form — that are empty, comment-only, or
return-only without surfacing the error. The pre-existing backlog is
grandfathered in place with inline
`// oxlint-disable-next-line sentry-cli/no-silent-catch -- <reason>` comments.
Because `pnpm run lint` reports unused suppressions as errors, an *orphaned*
suppression (left behind when a grandfathered catch is fixed) fails — so the backlog
can only shrink, the same ratchet the old JSON baseline provided, with no
separate script or baseline file to maintain. Fix a grandfathered catch by
adding logging/re-throwing and deleting its suppression line; only add a new
suppression for a genuinely intentional silent catch, with a real reason.

### Auto-Recovery for Wrong Entity Types

When a user provides the wrong type of identifier (e.g., an issue short ID
where a trace ID is expected), commands should **auto-recover** when the
user's intent is unambiguous:

1. **Detect** the actual entity type using helpers like `looksLikeIssueShortId()`,
   `SPAN_ID_RE`, `HEX_ID_RE`, or non-hex character checks.
2. **Resolve** the input to the correct type (e.g., issue → latest event → trace ID).
3. **Warn** via `log.warn()` explaining what happened.
4. **Show** the result with a return `hint` nudging toward the correct command.

When recovery is **ambiguous or impossible**, keep the existing error but add
entity-aware suggestions (e.g., "This looks like a span ID").

**Detection helpers:**
- `looksLikeIssueShortId(value)` — uppercase dash-separated (e.g., `CLI-G5`)
- `SPAN_ID_RE.test(value)` — 16-char hex (span ID)
- `HEX_ID_RE.test(value)` — 32-char hex (trace/event/log ID)
- `/[^0-9a-f]/.test(normalized)` — non-hex characters → likely a slug/name

**Reference implementations:**
- `event/view.ts` — issue short ID → latest event redirect
- `span/view.ts` — `traceId/spanId` slash format → auto-split
- `trace/view.ts` — issue short ID → issue's trace redirect
- `hex-id.ts` — entity-aware error hints in `validateHexId`/`validateSpanId`

### Async Config Functions

All config operations are async. Always await:

```typescript
const token = await getAuthToken();
const isAuth = await isAuthenticated();
await setAuthToken(token, expiresIn);
```

### Adding New Utility Files

Before creating a new `src/lib/*.ts` utility file, check whether existing shared modules already cover your use case:

| If you need... | Check first... |
|----------------|---------------|
| Duration formatting | `src/lib/formatters/time-utils.ts` (`formatDurationCompact`, `formatDurationVerbose`) |
| Hex ID validation/normalization | `src/lib/hex-id.ts` (`validateHexId`, `tryNormalizeHexId`, `normalizeHexId`) |
| Relative time display | `src/lib/formatters/time-utils.ts` (`formatRelativeTime`) |
| Table/markdown output | `src/lib/formatters/` directory |
| Pagination | `src/lib/db/pagination.ts`, `src/lib/list-command.ts` |
| Error classes | `src/lib/errors.ts` (never create ad-hoc error types) |
| Search query building | `src/lib/search-query.ts`, `src/lib/arg-parsing.ts` |

If an existing module covers ≥80% of what you need, extend it with new exported functions rather than creating a new file. New files are appropriate when the domain is genuinely new (e.g., `replay-search.ts` for replay-specific field resolution).

Every new `src/lib/**/*.ts` file must start with a module-level JSDoc comment describing the module's purpose.

### Imports

- Use `.js` extension for local imports (ESM requirement)
- Group: external packages first, then local imports
- Use `type` keyword for type-only imports

```typescript
import { object, string, optional } from "valibot";
import { buildCommand } from "../../lib/command.js";
import type { SentryContext } from "../../context.js";
import { getAuthToken } from "../../lib/db/auth.js";
```

### Target Resolution

`parseOrgProjectArg()` owns target syntax: a value without `/` is a
`project-search`; `<org>/` is `org-all`; `<org>/<project>` is explicit.
`classifyProjectSearchTarget()` owns the lookup order for project-search:
exact project(s), exact organization, fuzzy project, then not found.

Commands select a capability wrapper instead of performing API lookups:

- `resolveProjectBoundSlug()`, `resolveProjectBoundTarget()`, and
  `resolveProjectBoundFromArg()` require one project. An organization match is
  an actionable error.
- `resolveProjectBoundTargets()` resolves one or more project targets.
- `resolveOrgOptionalTarget()` / `resolveOrgOptionalFromArg()` allow either an
  organization or a project.
- `resolveOrgOnlyTarget()` / `resolveOrgOnlyFromArg()` return the effective
  organization while preserving project-first precedence for bare targets.
- `resolveProjectIdsInOrg()` / `findProjectsInOrg()` resolve a
  comma-separated `org/a,b` selector: numeric IDs for a single request
  (unknown slugs are an error), or the projects themselves plus the slugs
  that returned 404.

Do not call `findProjectsBySlug()` or implement org fallback directly in a
command. `sentry init` is the intentional not-found exception: it calls the
classifier with fuzzy recovery disabled, then treats `not-found` as a new
project name. Issue-short-ID recovery in `commands/issue/utils.ts` is not CLI
target resolution and may perform its own project lookup. The
`no-direct-target-resolution` CLI Oxlint rule enforces this command-layer
boundary.

### List Command Infrastructure

Two abstraction levels exist for list commands:

1. **`src/lib/list-command.ts`** — `buildOrgListCommand` factory + shared Stricli parameter constants (`LIST_TARGET_POSITIONAL`, `LIST_JSON_FLAG`, `LIST_CURSOR_FLAG`, `buildListLimitFlag`). Use this for simple entity lists like `team list` and `repo list`.

2. **`src/lib/org-list.ts`** — `dispatchOrgScopedList` with `OrgListConfig` and a 4-mode handler map: `auto-detect`, `explicit`, `org-all`, `project-search`. Complex commands (`project list`, `issue list`) call `dispatchOrgScopedList` with an `overrides` map directly instead of using `buildOrgListCommand`.

Key rules when writing overrides:
- Each mode handler receives a `HandlerContext<T>` with narrowed `parsed`, `cwd`, `flags`, and optional request-scoped project-search classification. Access parsed fields via `ctx.parsed.org`, `ctx.parsed.projectSlug`, etc. — no manual `Extract<>` casts needed.
- Commands with extra fields (e.g., `stderr`, `setContext`) spread the context and add them: `(ctx) => handle({ ...ctx, flags, stderr, setContext })`. Override `ctx.flags` with the command-specific flags type when needed.
- `resolveCursor()` must be called **inside** the `org-all` override closure, not before `dispatchOrgScopedList`, so that `--cursor` validation errors fire correctly for non-org-all modes.
- For an unscoped bare target, `dispatchOrgScopedList` applies the shared
  classifier before dispatch: an organization match becomes `org-all`, while
  project results are passed request-scoped to the handler. Scoped and
  display-name searches stay in `project-search` and are classified there.

3. **Standalone list commands** (e.g., `span list`, `trace list`) that don't use org-scoped dispatch wire pagination directly in `func()`. See the "List Command Pagination" section above for the pattern.

### Project Filtering in API Calls

Different Sentry API endpoints use different project filtering mechanisms. Never apply both simultaneously:

| API Endpoint | Project filter | Helper |
|-------------|---------------|--------|
| Discover/Events (`queryEvents`) | `project:<slug>` in query string | `buildProjectQuery()` |
| Replay index (`listReplays`) | `projectSlugs` parameter | Direct parameter |
| Issue index (`listIssuesPaginated`) | `project` parameter or query string | Varies by mode |

When adding a new dataset to `explore`, verify which filtering mechanism the underlying API expects and handle it in `resolveDatasetConfig`. The `explore` command centralizes dataset-specific behavior (sort, query, fetch, field validation) in `resolveDatasetConfig` — add new datasets there rather than scattering `if (dataset === ...)` checks through the `func` body.

## Commenting & Documentation (JSDoc-first)

### Default Rule
- **Prefer JSDoc over inline comments.**
- Code should be readable without narrating what it already says.

### Required: JSDoc
Add JSDoc comments on:
- **Every exported function, class, and type** (and important internal ones).
- **Types/interfaces**: document each field/property (what it represents, units, allowed values, meaning of `null`, defaults).

Include in JSDoc:
- What it does
- Key business rules / constraints
- Assumptions and edge cases
- Side effects
- Why it exists (when non-obvious)

### Inline Comments (rare)
Inline comments are **allowed only** when they add information the code cannot express:
- **"Why"** - business reason, constraint, historical context
- **Non-obvious behavior** - surprising edge cases
- **Workarounds** - bugs in dependencies, platform quirks
- **Hardcoded values** - why hardcoded, what would break if changed

Inline comments are **NOT allowed** if they just restate the code:
```typescript
// Bad:
if (!person) // if no person  
i++          // increment i   
return result // return result 

// Good:
// Required by GDPR Article 17 - user requested deletion
await deleteUserData(userId)
```

### Prohibited Comment Styles
- **ASCII art section dividers** - Do not use decorative box-drawing characters like `─────────` to create section headers. Use standard JSDoc comments or simple `// Section Name` comments instead.

### Goal
Minimal comments, maximum clarity. Comments explain **intent and reasoning**, not syntax.

## Testing (Vitest + fast-check)

**Prefer property-based and model-based testing** over traditional unit tests. These approaches find edge cases automatically and provide better coverage with less code.

**fast-check Documentation**: https://fast-check.dev/docs/core-blocks/arbitraries/

### Testing Hierarchy (in order of preference)

1. **Model-Based Tests** - For stateful systems (database, caches, state machines)
2. **Property-Based Tests** - For pure functions, parsing, validation, transformations
3. **Unit Tests** - Only for trivial cases or when properties are hard to express

### Test File Naming

| Type | Pattern | Location |
|------|---------|----------|
| Property-based | `*.property.test.ts` | `test/lib/` |
| Model-based | `*.model-based.test.ts` | `test/lib/db/` |
| Unit tests | `*.test.ts` | `test/` (mirrors `src/`) |
| E2E tests | `*.test.ts` | `test/e2e/` |

### Test Environment Isolation (CRITICAL)

Tests that need a database or config directory **must** use `useTestConfigDir()` from `test/helpers.ts`. This helper:
- Creates a unique temp directory in `beforeEach`
- Sets `SENTRY_CONFIG_DIR` to point at it
- **Restores** (never deletes) the env var in `afterEach`
- Closes the database and cleans up temp files

**NEVER** do any of these in test files:
- `delete process.env.SENTRY_CONFIG_DIR` — This pollutes other test files that load after yours
- `const baseDir = process.env[CONFIG_DIR_ENV_VAR]!` at module scope — This captures a value that may be stale
- Manual `beforeEach`/`afterEach` that sets/deletes `SENTRY_CONFIG_DIR`

**Why**: Vitest runs each test file in a worker pool (see `test:unit` in `package.json`), so each file runs in its own worker process. That bounds most cross-file leaks to a single worker, but `process.env` is still shared within a file's lifecycle — if your `afterEach` deletes the env var, the next describe/test's module-level code (or a beforeEach that re-reads env) gets `undefined`, causing `TypeError: The "paths[0]" property must be of type string`. Also, `TEST_TMP_DIR` is namespaced by `VITEST_POOL_ID` in `test/constants.ts` so parallel workers don't wipe each other's temp state during preload.

```typescript
// CORRECT: Use the helper
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("my-test-prefix-");

// If you need the directory path in a test:
test("example", () => {
  const dir = getConfigDir();
});

// WRONG: Manual env var management
beforeEach(() => { process.env.SENTRY_CONFIG_DIR = tmpDir; });
afterEach(() => { delete process.env.SENTRY_CONFIG_DIR; }); // BUG!
```

### Property-Based Testing

Use property-based tests when verifying invariants that should hold for **any valid input**.

```typescript
import { describe, expect, test } from "vitest";
import { constantFrom, assert as fcAssert, property, tuple } from "fast-check";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Define arbitraries (random data generators)
const slugArb = array(constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
  minLength: 1,
  maxLength: 15,
}).map((chars) => chars.join(""));

describe("property: myFunction", () => {
  test("is symmetric", () => {
    fcAssert(
      property(slugArb, slugArb, (a, b) => {
        // Properties should always hold regardless of input
        expect(myFunction(a, b)).toBe(myFunction(b, a));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("round-trip: encode then decode returns original", () => {
    fcAssert(
      property(validInputArb, (input) => {
        const encoded = encode(input);
        const decoded = decode(encoded);
        expect(decoded).toEqual(input);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
```

**Good candidates for property-based testing:**
- Parsing functions (DSN, issue IDs, aliases)
- Encoding/decoding (round-trip invariant)
- Symmetric operations (a op b = b op a)
- Idempotent operations (f(f(x)) = f(x))
- Validation functions (valid inputs accepted, invalid rejected)

**See examples:** `test/lib/dsn.property.test.ts`, `test/lib/alias.property.test.ts`, `test/lib/issue-id.property.test.ts`

### Model-Based Testing

Use model-based tests for **stateful systems** where sequences of operations should maintain invariants.

```typescript
import { describe, expect, test } from "vitest";
import {
  type AsyncCommand,
  asyncModelRun,
  asyncProperty,
  commands,
  assert as fcAssert,
} from "fast-check";
import { createIsolatedDbContext, DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

// Define a simplified model of expected state
type DbModel = {
  entries: Map<string, string>;
};

// Define commands that operate on both model and real system
class SetCommand implements AsyncCommand<DbModel, RealDb> {
  constructor(readonly key: string, readonly value: string) {}
  
  check = () => true;
  
  async run(model: DbModel, real: RealDb): Promise<void> {
    // Apply to real system
    await realSet(this.key, this.value);
    
    // Update model
    model.entries.set(this.key, this.value);
  }
  
  toString = () => `set("${this.key}", "${this.value}")`;
}

class GetCommand implements AsyncCommand<DbModel, RealDb> {
  constructor(readonly key: string) {}
  
  check = () => true;
  
  async run(model: DbModel, real: RealDb): Promise<void> {
    const realValue = await realGet(this.key);
    const expectedValue = model.entries.get(this.key);
    
    // Verify real system matches model
    expect(realValue).toBe(expectedValue);
  }
  
  toString = () => `get("${this.key}")`;
}

describe("model-based: database", () => {
  test("random sequences maintain consistency", () => {
    fcAssert(
      asyncProperty(commands(allCommandArbs), async (cmds) => {
        const cleanup = createIsolatedDbContext();
        try {
          await asyncModelRun(
            () => ({ model: { entries: new Map() }, real: {} }),
            cmds
          );
        } finally {
          cleanup();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
```

**Good candidates for model-based testing:**
- Database operations (auth, caches, regions)
- Stateful caches with invalidation
- Systems with cross-cutting invariants (e.g., clearAuth also clears regions)

**See examples:** `test/lib/db/model-based.test.ts`, `test/lib/db/dsn-cache.model-based.test.ts`

### Test Helpers

Use `test/model-based/helpers.ts` for shared utilities:

```typescript
import { createIsolatedDbContext, DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Create isolated DB for each test run (prevents interference)
const cleanup = createIsolatedDbContext();
try {
  // ... test code
} finally {
  cleanup();
}

// Use consistent number of runs across tests
fcAssert(property(...), { numRuns: DEFAULT_NUM_RUNS }); // 50 runs
```

### When to Use Unit Tests

Use traditional unit tests only when:
- Testing trivial logic with obvious expected values
- Properties are difficult to express or would be tautological
- Testing error messages or specific output formatting
- Integration with external systems (E2E tests)

### Avoiding Unit/Property Test Duplication

When a `*.property.test.ts` file exists for a module, **do not add unit tests that re-check the same invariants** with hardcoded examples. Before adding a unit test, check whether the companion property file already generates random inputs for that invariant.

**Unit tests that belong alongside property tests:**
- Edge cases outside the property generator's range (e.g., self-hosted DSNs when the arbitrary only produces SaaS ones)
- Specific output format documentation (exact strings, column layouts, rendered vs plain mode)
- Concurrency/timing behavior that property tests cannot express
- Integration tests exercising multiple functions together (e.g., `writeJsonList` envelope shape)

**Unit tests to avoid when property tests exist:**
- "returns true for valid input" / "returns false for invalid input" — the property test already covers this with random inputs
- Basic round-trip assertions — property tests check `decode(encode(x)) === x` for all `x`
- Hardcoded examples of invariants like idempotency, symmetry, or subset relationships

When adding property tests for a function that already has unit tests, **remove the unit tests that become redundant**. Add a header comment to the unit test file noting which invariants live in the property file:

```typescript
/**
 * Note: Core invariants (round-trips, validation, ordering) are tested via
 * property-based tests in foo.property.test.ts. These tests focus on edge
 * cases and specific output formatting not covered by property generators.
 */
```

```typescript
import { describe, expect, test, vi } from "vitest";

describe("feature", () => {
  test("should return specific value", async () => {
    expect(await someFunction("input")).toBe("expected output");
  });
});

// Mock modules when needed
vi.mock("./some-module", () => ({
  default: () => "mocked",
}));
```

## File Locations

| What | Where |
|------|-------|
| Add new command | `src/commands/<domain>/` |
| Add API types | `src/types/sentry.ts` |
| Add config types | `src/types/config.ts` |
| Add Seer types | `src/types/seer.ts` |
| Add utility | `src/lib/` |
| Add DSN language support | `src/lib/dsn/languages/` |
| Add DB operations | `src/lib/db/` |
| Build scripts | `script/` |
| Add property tests | `test/lib/<name>.property.test.ts` |
| Add model-based tests | `test/lib/db/<name>.model-based.test.ts` |
| Add unit tests | `test/` (mirror `src/` structure) |
| Add E2E tests | `test/e2e/` |
| Test helpers | `test/model-based/helpers.ts` |
| Add documentation | `docs/src/content/docs/` |
| Hand-written command doc content | `docs/src/fragments/commands/` |

## Automated Fix PRs (BugBot / agents)

Automated bug-fix PRs (e.g. Cursor BugBot) must follow these rules to avoid the
duplication and staleness that caused five overlapping PRs to pile up:

1. **Check for existing work first.** Before opening a PR, search open PRs and
   recently-closed PRs/issues for the same file + symbol:
   ```bash
   gh pr list --state open --search "in:title <file-or-symbol>"
   gh issue list --state all --search "<symbol>"
   ```
   If an open PR already touches the target function, **comment on it** or extend
   it instead of opening a duplicate. Multiple BugBot PRs independently re-fixed
   the same `JSON.parse` guard, `withTTY` helper, and pagination code.

2. **Rebase before review.** A PR that is many commits behind `main` may fail CI
   on unrelated drift (e.g. a lint error in a file the PR never touched) and its
   fix may already be superseded. Rebase onto `main` and re-verify the bug still
   exists before requesting review. Verify against current `main`, not the
   snapshot the PR was generated from.

3. **Separate correctness fixes from opinion.** A real bug (wrong output, crash,
   skipped data) is in scope. A subjective UX change (different hint wording,
   different default) is **not** a bug — `main`'s current behavior is often
   deliberate. Do not bundle UX opinions into bug-fix PRs; they waste review
   cycles and are usually dropped.

4. **Prefer shared helpers over re-deriving fixes.** If a correct implementation
   already exists (e.g. `autoPaginate()` for pagination, `safeParseJson()` for
   cached JSON), use it rather than hand-rolling a one-off fix. The recurring
   pagination-overshoot and parse-crash bugs were classes solved once centrally.

<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

For long-term knowledge entries managed by [lore](https://github.com/BYK/loreai) (gotchas, patterns, decisions, architecture), see [`.lore.md`](.lore.md) in the project root.
<!-- End lore-managed section -->
