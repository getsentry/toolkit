---
title: Features
description: Advanced features of the Sentry CLI
---

The Sentry CLI includes several features designed to streamline your workflow, especially in complex project setups.

## DSN Auto-Detection

The CLI automatically detects your Sentry project from your codebase, eliminating the need to specify the target for every command. DSN detection is one part of the [resolution priority chain](./configuration/#resolution-priority) — it runs after checking for explicit arguments, environment variables, and `.sentryclirc` config files.

### How It Works

DSN detection follows this priority order (highest first):

1. **Source code** - Explicit DSN in `Sentry.init()` calls
2. **Environment files** - `.env.local`, `.env`, etc.
3. **Environment variable** - `SENTRY_DSN`

When a DSN is found, the CLI resolves it to your organization and project, then caches the result for fast subsequent lookups.

:::tip
For monorepos or when DSN detection picks up the wrong project, use a [`.sentryclirc` config file](./configuration/#configuration-file-sentryclirc) to pin your org/project explicitly.
:::

### Supported Languages

The CLI scans source files for DSN URLs (the `https://…@….ingest.sentry.io/…` pattern) using a universal regex — no language-specific parsing is needed. Any text file with a recognized extension is scanned, including:

| Language Family | File Extensions |
|----------------|-----------------|
| JavaScript/TypeScript | `.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.astro`, `.vue`, `.svelte` |
| Python | `.py` |
| Go | `.go` |
| JVM (Java, Kotlin, Scala, Groovy) | `.java`, `.kt`, `.kts`, `.scala`, `.groovy` |
| .NET (C#, F#, VB) | `.cs`, `.fs`, `.vb` |
| Ruby | `.rb`, `.erb` |
| PHP | `.php` |
| Swift/Objective-C | `.swift`, `.m`, `.mm` |
| Rust | `.rs` |
| Dart/Flutter | `.dart` |
| Elixir/Erlang | `.ex`, `.exs`, `.erl` |
| Config files | `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.properties` |

### Caching

To avoid scanning your codebase on every command, the CLI caches:

- **DSN location** - Which file contains the DSN
- **Resolved project** - The org/project slugs from the API

The cache is validated on each run by checking if the source file still contains the same DSN. If the DSN changes or the file is deleted, a full scan is triggered.

### Usage

Once your project has a DSN configured, commands automatically use it:

```bash
# Instead of:
sentry issue list my-org/my-project

# Just run:
sentry issue list
```

The CLI will show which project was detected:

```
Detected project: my-app (from .env)

ID          SHORT ID    TITLE                           COUNT
123456789   MYAPP-ABC   TypeError: Cannot read prop...  142
```

## Monorepo Support & Alias System

In monorepos with multiple Sentry projects, the CLI generates short aliases for each project, making it easy to work with issues across projects.

### How Aliases Work

When you run `sentry issue list`, the CLI:

1. Scans for DSNs in monorepo directories (`packages/`, `apps/`, etc.)
2. Generates unique short aliases for each project
3. Caches the aliases for use with other commands

Aliases are the shortest unique prefix of each project slug. For example:

| Project Slug | Alias |
|--------------|-------|
| `frontend` | `f` |
| `functions` | `fu` |
| `backend` | `b` |

For projects with a common prefix (like `spotlight-electron`, `spotlight-website`), the prefix is stripped first:

| Project Slug | Alias |
|--------------|-------|
| `spotlight-electron` | `e` |
| `spotlight-website` | `w` |
| `spotlight-backend` | `b` |

### Using Alias-Suffix Format

After running `issue list`, you can reference issues using the `alias-suffix` format:

```bash
# List issues - note the ALIAS column
sentry issue list
```

```
ALIAS  SHORT ID             TITLE                           COUNT
e      SPOTLIGHT-ELEC-4Y    TypeError: Cannot read prop...  142
w      SPOTLIGHT-WEB-ABC    Failed to fetch user data       89
b      SPOTLIGHT-BACK-XYZ   Connection timeout              34
```

```bash
# View issue using alias-suffix
sentry issue view e-4Y

# Explain using alias-suffix
sentry issue explain w-ABC

# Works with any issue command
sentry issue plan b-XYZ
```

### Cross-Organization Support

If you work with multiple organizations that have projects with the same slug, the CLI uses org-prefixed aliases:

```
ALIAS    SHORT ID        TITLE
o1:api   ORG1-API-123    Error in API handler
o2:api   ORG2-API-456    Database connection failed
```

## Issue ID Formats

The CLI accepts several formats for identifying issues:

### Numeric ID

The internal Sentry issue ID:

```bash
sentry issue view 123456789
sentry issue explain 987654321
```

### Full Short ID

The project-prefixed short ID shown in Sentry UI:

```bash
sentry issue view MYPROJECT-ABC
sentry issue explain FRONTEND-XYZ
```

### Short Suffix

Just the suffix portion when project context is provided via the `<org>/` prefix:

```bash
sentry issue view my-org/myproject-ABC
```

### GitHub-Style (`#` separator)

A `#` may be used in place of the final slash, matching how issues are referenced
on GitHub. This is handy for AI agents and tooling that emit `org/project#SHORTID`:

```bash
# Equivalent to my-org/my-project/PROJ-123
sentry issue view my-org/my-project#PROJ-123

# Project context only (org auto-detected)
sentry issue view my-project#PROJ-123
```

### Alias-Suffix

The short alias plus suffix, available after running `issue list`:

```bash
# First, list issues to populate the alias cache
sentry issue list

# Then use alias-suffix format
sentry issue view e-4Y
sentry issue explain w-ABC
sentry issue plan b-XYZ
```

This format is especially useful in monorepos where you're working across multiple projects.

## AI-Powered Analysis with Seer

The CLI integrates with Sentry's Seer AI to provide root cause analysis and fix plans directly in your terminal.

### Root Cause Analysis

Use `sentry issue explain` to understand why an issue is happening:

```bash
sentry issue explain MYPROJECT-ABC
```

Seer analyzes:
- Stack traces and error messages
- Related events and patterns
- Your codebase (via GitHub integration)

And provides:
- Detailed root cause explanation
- Reproduction steps
- Relevant code locations

### Fix Plans

After understanding the root cause, use `sentry issue plan` to get actionable fix steps:

```bash
sentry issue plan MYPROJECT-ABC
```

The plan includes:
- Specific files to modify
- Code changes to make
- Implementation guidance

### Requirements

For Seer integration to work, you need:

1. **Seer enabled** for your organization
2. **GitHub integration** configured with repository access
3. **Code mappings** set up to link stack frames to source files

See [Sentry's Seer documentation](https://docs.sentry.io/product/issues/issue-details/ai-suggested-solution/) for setup instructions.
