# `sentry wizard` end-to-end tests

Each test copies an app from `test-applications/` to a temporary git
repository, runs the CLI's `sentry wizard` in it while answering its prompts,
and then checks the files the wizard wrote and that the app still builds and
runs. They were moved here from getsentry/sentry-wizard's `e2e-tests/`.

The wizard never talks to sentry.io. `global-setup.ts` starts a local mock
Sentry API (the routes in `../mocks/routes.ts`, plus org auth token creation).
Every run gets its URL in `SENTRY_URL` and its token in `SENTRY_AUTH_TOKEN`,
and `getWizardCommand()` runs `sentry wizard test-org/test-project <integration>`.
For a run without a project, pass `env: { SENTRY_SPOTLIGHT: "1" }` to
`withEnv()` and run `["wizard", <integration>]`. No secrets are needed.

## Running

```bash
# From packages/cli. Builds the npm bundle, then runs every test file.
pnpm run test:wizard-e2e

# One file
pnpm run test:wizard-e2e test/wizard-e2e/nextjs-15.test.ts
```

The tests run the npm bundle (`dist/bin.cjs`), or the CLI in
`SENTRY_CLI_BINARY` when set. They need network access for the apps' package
installs, and the package managers the tests pick (npm, pnpm and Yarn v1).

- `SENTRY_WIZARD_E2E_DEBUG=true` streams the wizard's output.
- `SENTRY_WIZARD_E2E_KEEP_TEMP=true` keeps the temporary app directories.

`test:unit` and `test:e2e` don't run these. In CI, `wizard-e2e.yml` runs one
job per test file on pull requests that change the wizard or these tests, and
on manual dispatch. Add a new test file to its matrix.

## Writing tests

Isolate each wizard run in its own `describe` block with
`createIsolatedTestEnv()`, run the wizard in `beforeAll`, and clean up in
`afterAll`. `withEnv().defineInteraction()` scripts the answers, in the shape
of the `clifty` builder the sentry-wizard tests used:

```ts
const { projectDir, cleanup } = createIsolatedTestEnv("nextjs-15-test-app");

beforeAll(async () => {
  wizardExitCode = await withEnv({ cwd: projectDir })
    .defineInteraction()
    .whenAsked("Please select your package manager.")
    .respondWith(KEYS.ENTER)
    .expectOutput("Successfully installed the Sentry Next.js SDK!")
    .run(getWizardCommand("nextjs"));
});

afterAll(() => {
  cleanup();
});
```

Each step waits for its text after the previous step's match, so list prompts
in the order the wizard asks them. Test apps have no lockfiles, so the wizard
picks the package manager the test selects.
