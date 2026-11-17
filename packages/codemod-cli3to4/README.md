# `@getsentry/cli3to4`

A [Codemod](https://codemod.com) that migrates programmatic **`@sentry/cli` v3**
usage (the `SentryCli` class) to the **v4 `sentry` package** (`createSentrySDK`
factory + typed command methods).

It is referenced from the CLI's
[migration guide](https://cli.sentry.dev/migrating-from-v3/).

## Usage

```bash
npx codemod @getsentry/cli3to4
```

Run it from your project root; it rewrites `.js`/`.ts`/`.jsx`/`.tsx` files (and
their `.mjs`/`.cjs`/`.mts`/`.cts` variants) in place. Review the diff afterward —
the codemod inserts `// TODO(sentry-v4): …` comments wherever an option shape
changed and needs a manual decision (it flags rather than guesses).

## What it does

- Rewrites the module specifier `@sentry/cli` → `sentry`, **keeping your local
  binding name** (so re-exports and pass-throughs stay valid). v3's named
  export becomes v4's factory: `import { SentryCli }` →
  `import { createSentrySDK as SentryCli }`, `const { SentryCli } = require(…)`
  → `const { createSentrySDK: SentryCli } = require(…)`, and `X.SentryCli` →
  `X.createSentrySDK`. The v2 default-export shapes (`import X from`, bare
  `require`) map to v4's default export.
- `new SentryCli(configFile?, options?)` → `SentryCli(options?)` — drops `new`
  (v4 exports a factory, not a class) and the removed `configFile` positional,
  and renames the `authToken` option to `token`.
- Maps the release/sourcemap methods to the typed v4 SDK:
  `releases.new`→`release.create`, `releases.finalize`→`release.finalize`,
  `releases.setCommits`→`release["set-commits"]`,
  `releases.newDeploy`→`release.deploy` (renaming `env` to `environment`),
  `releases.listDeploys`→`release.deploys`,
  `releases.proposeVersion`→`release["propose-version"]`,
  `releases.uploadSourceMaps`→`sourcemap.upload`,
  `sourceMaps.inject`→`sourcemap.inject`, and `execute([...])`→`run(...)`.
  The release version moves into the options object as `orgVersion` (or
  `release` for `sourcemap.upload`).
- Only touches files that actually import `@sentry/cli`, and only rewrites
  method calls on instances it can see created via `new SentryCli(...)`.

## Development

```bash
# Run the test fixtures (tests/<case>/input.ts + expected.ts)
pnpm test

# Type-check the transform
pnpm run typecheck

# Update expected fixtures after an intentional change
pnpm dlx codemod@1.12.7 jssg test -l typescript ./scripts/codemod.ts -u
```

## Publishing

Published to the [Codemod Registry](https://codemod.com/registry) under the
`@getsentry` scope. Codemod verifies that scope against this repository
(`.codemod/verification` at the repo root). To release, bump `version` in
`codemod.yaml` and merge to `main`.
[`.github/workflows/publish-codemod.yml`](../../.github/workflows/publish-codemod.yml)
runs on pushes to `main` that touch `codemod.yaml` and publishes with GitHub
Actions OIDC when the version changed. You can also run it by hand from the
Actions tab.
