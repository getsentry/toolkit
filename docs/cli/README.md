# Sentry CLI Documentation

The CLI lives in `packages/cli/`. Its published user guide and command reference
are at <https://cli.sentry.dev/>. The site source lives in `apps/cli-docs/`, and
CLI releases build it from that workspace. Start here for repository guides:

- [Getting started](../../apps/cli-docs/src/content/docs/getting-started.mdx),
  [features](../../apps/cli-docs/src/content/docs/features.md), and
  [self-hosted use](../../apps/cli-docs/src/content/docs/self-hosted.md) —
  hand-written user guides.
- [Contributing to the CLI](../../apps/cli-docs/src/content/docs/contributing.md)
  — setup, generated project layout, testing, and builds.
- [CLI development notes](../../packages/cli/DEVELOPMENT.md) and
  [command conventions](../../packages/cli/CONTRIBUTING.md) — implementation
  details and command design.
- [CLI build workflow](../../.github/workflows/cli-build.yml) and
  [release configuration](../../.craft.yml) — binaries, npm packaging, and
  release-gated website artifacts.
- [CLI AGENTS.md](../../packages/cli/AGENTS.md) — package-specific coding and
  testing rules.
- [CLI docs fragments](../../apps/cli-docs/src/fragments/commands/index.md)
  — hand-written additions to generated command pages. Command metadata and
  examples belong to the commands; the generated pages are not checked in.
- [CLI overview](../../packages/cli/README.md) — installation, supported
  platforms, and library use.

Run CLI commands from `packages/cli/` or use `pnpm --filter sentry run <script>`
at the repository root. Check `packages/cli/package.json` for current scripts
before running them. The CLI docs workspace uses `pnpm --filter sentry-cli-docs`
and depends on generated CLI documentation. The root
[coding guidelines](../contributing/coding-guidelines.md) and
[quality checks](../contributing/quality-checks.md) apply alongside the CLI's
own rules.
