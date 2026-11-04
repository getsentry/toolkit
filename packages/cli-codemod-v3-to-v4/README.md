# `@getsentry/cli-v3-to-v4`

A [Codemod](https://codemod.com) that migrates programmatic **`@sentry/cli` v3**
usage (the `SentryCli` class) to the **v4 `sentry` package** (`createSentrySDK`
factory + typed command methods).

It is referenced from the CLI's
[migration guide](https://cli.sentry.dev/migrating-from-v3/).

## Usage

```bash
npx codemod @getsentry/cli-v3-to-v4
```

Run it from your project root; it rewrites `.js`/`.ts` files in place. Review the
diff afterward — the codemod inserts `// TODO(sentry-v4): …` comments wherever an
option shape changed and needs a manual decision (it flags rather than guesses).

## What it does

- Rewrites the module specifier `@sentry/cli` → `sentry`, **keeping your local
  binding name** (so re-exports and pass-throughs stay valid).
- `new SentryCli(configFile?, options?)` → `SentryCli(options?)` — drops `new`
  (v4's default export is the `createSentrySDK` factory) and the removed
  `configFile` positional, and renames the `authToken` option to `token`.
- Maps the release/sourcemap methods:
  `releases.new`→`release.create`, `releases.finalize`→`release.finalize`,
  `releases.setCommits`→`release["set-commits"]`,
  `releases.uploadSourceMaps`→`sourcemap.upload`,
  `releases.newDeploy`→`release.deploy`,
  `releases.proposeVersion`→`release["propose-version"]`, and
  `execute([...])`→`run(...)`.
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
`codemod.yaml` and push a `cli-v3-to-v4@v<version>` tag; that runs
[`.github/workflows/publish-codemod.yml`](../../.github/workflows/publish-codemod.yml),
which publishes with GitHub Actions OIDC.
