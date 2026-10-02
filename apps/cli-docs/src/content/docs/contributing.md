---
title: Contributing
description: How to contribute to the Sentry CLI
---

We welcome contributions to the Sentry CLI! This guide will help you get started.

## Development Setup

### Prerequisites

<!-- GENERATED:START dev-prereq -->
- [Node.js](https://nodejs.org) (v22.15 or later)
- [pnpm](https://pnpm.io) (v11.8 or later)
<!-- GENERATED:END dev-prereq -->
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/getsentry/toolkit.git
cd toolkit

# Install dependencies
pnpm install
cd packages/cli

# Run CLI in development mode
pnpm run cli -- --help

# Run tests
pnpm run test
```

### Environment Variables

Create a `.env.local` file for development:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your development credentials.

## Project Structure

<!-- GENERATED:START project-structure -->
```
toolkit/
├── packages/
│   └── cli/
│       ├── src/
│       │   ├── bin.ts          # Entry point
│       │   ├── app.ts          # Stricli application setup
│       │   ├── context.ts      # Dependency injection context
│       │   ├── commands/       # CLI commands
│       │   │   ├── agent-conversation/# list, view
│       │   │   ├── alert/       # create, delete, edit, list, view
│       │   │   ├── auth/        # login, logout, refresh, status, token, whoami
│       │   │   ├── build/       # download, upload
│       │   │   ├── cli/         # completion, defaults, feedback, fix, import, setup, uninstall, upgrade
│       │   │   ├── code-mappings/# upload
│       │   │   ├── dart-symbol-map/# upload
│       │   │   ├── dashboard/   # add, create, delete, edit, list, restore, revisions, view
│       │   │   ├── debug-files/ # bundle-jvm, bundle-sources, check, find, print-sources, upload
│       │   │   ├── docs/        # list, query
│       │   │   ├── dsn/         # list
│       │   │   ├── event/       # list, send, view
│       │   │   ├── feedback/    # list, resolve, spam, unresolve, view
│       │   │   ├── issue/       # archive, events, explain, link, list, merge, plan, resolve, unlink, unresolve, view
│       │   │   ├── local/       # run, serve
│       │   │   ├── log/         # list, view
│       │   │   ├── monitor/     # list, run
│       │   │   ├── org/         # list, view
│       │   │   ├── platform/    # list
│       │   │   ├── proguard/    # upload, uuid
│       │   │   ├── project/     # create, delete, list, view
│       │   │   ├── react-native/# gradle, xcode
│       │   │   ├── release/     # archive, create, delete, deploy, deploys, finalize, list, propose-version, restore, set-commits, view
│       │   │   ├── replay/      # download, list, view
│       │   │   ├── repo/        # list
│       │   │   ├── snapshots/   # diff, download, upload
│       │   │   ├── sourcemap/   # inject, resolve, upload
│       │   │   ├── span/        # list, view
│       │   │   ├── status/      # show
│       │   │   ├── team/        # list
│       │   │   ├── trace/       # list, logs, view
│       │   │   ├── trial/       # list, start
│       │   │   ├── api.ts       # Make an authenticated API request
│       │   │   ├── explore.ts   # Query aggregate event data (Explore)
│       │   │   ├── help.ts      # Help command
│       │   │   ├── info.ts      # Print configuration and verify authentication
│       │   │   ├── init.ts      # Initialize Sentry in your project (experimental)
│       │   │   ├── schema.ts    # Browse the Sentry API schema
│       │   │   └── wasm-split.ts# Add build ids to WebAssembly modules and split out debug data
│       │   ├── lib/            # Shared utilities
│       │   └── types/          # TypeScript types and Valibot schemas
│       ├── test/               # Test files (mirrors src/ structure)
│       ├── script/             # Build and utility scripts
│       └── plugins/            # Agent skill files
└── apps/
    └── cli-docs/             # Documentation site (Astro + Starlight)
```
<!-- GENERATED:END project-structure -->

## Building

<!-- GENERATED:START build-commands -->
```bash
# Build for current platform (uses esbuild + fossilize for Node SEA packaging)
pnpm run build

# Build for all platforms
pnpm run build:all

# Create npm bundle
pnpm run bundle
```
<!-- GENERATED:END build-commands -->

## Testing

```bash
# Run all tests
pnpm run test

# Run specific test file
pnpm run test -- test/path/to/test.ts

# Run with watch mode
pnpm run test -- --watch

# Run with coverage
pnpm run test -- --coverage
```

## Code Style

The project uses [Ultracite](https://github.com/getsentry/ultracite) for linting and formatting:

```bash
# Check for issues
pnpm run lint

# Auto-fix issues
pnpm run lint:fix

# Type checking
pnpm run typecheck
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests and linting: `pnpm run test && pnpm run lint`
5. Commit with [conventional commits](https://www.conventionalcommits.org/): `git commit -m "feat: add new feature"`
6. Push and create a pull request

## Conventional Commits

We use conventional commits for automatic changelog generation:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test changes
- `chore:` - Maintenance tasks

## Getting Help

- [GitHub Issues](https://github.com/getsentry/toolkit/issues) - Bug reports and feature requests
