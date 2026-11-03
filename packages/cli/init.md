# Set up Sentry

You are a coding agent adding Sentry to the user's project. Work through the
steps below in order. Run the commands yourself. Stop and ask the user only
where a step tells you to: logging in, choosing a Sentry project, choosing
features, and anything that changes production configuration.

## Use the docs, not your memory

Sentry SDKs change often, and what you remember is often a major version
behind: `@sentry/tracing`, `new Sentry.BrowserTracing()`,
`Sentry.startTransaction()`, and `Sentry.Integrations.*` are all gone from
current SDKs. Look up package names, file names, init options, and APIs in
the current docs before you write any Sentry code, and follow them over what
you remember:

```bash
sentry docs "How do I set up Sentry in a Next.js app?"   # cited answer
sentry docs list "nextjs tracing"                         # matching doc pages
```

Every docs.sentry.io page is also available as Markdown: add `.md` to its
path, as in `https://docs.sentry.io/platforms/javascript/guides/nextjs.md`.
Never write an SDK version number from memory. Install without a version so
the package manager picks the current release.

## 1. Install the Sentry CLI

Check whether the CLI is installed:

```bash
sentry --version
```

If you are reading this from `sentry init`, it is. Otherwise install it:

```bash
curl https://cli.sentry.dev/install -fsS | bash   # macOS and Linux
irm https://cli.sentry.dev/install.ps1 | iex      # Windows PowerShell
npm install -g sentry                             # any OS with Node.js 20+
```

After an npm or Homebrew install, run `sentry cli setup` once to add shell
completions and the Sentry agent skills.

## 2. Log in

```bash
sentry auth status
```

If it reports that nobody is logged in, run `sentry auth login`. It prints a
URL and a one-time code. Show both to the user and wait while they approve
the login in their browser; the command finishes when they do. For a
self-hosted Sentry, ask the user for its URL and pass `--url <url>`.

## 3. Map the project

Read the manifests and framework configuration; don't guess from file names.
Work out three things.

**Which apps to set up.** In a monorepo, deployable apps usually live in
`apps/*`, and `packages/*` are usually libraries. Ask the user which apps
should get Sentry, and change only their files. Tests, examples, docs, and CI
jobs are not apps.

**Which SDKs each app needs.** It is often more than one. Each part of the
app that runs in its own environment gets the SDK for that environment:

- A full-stack framework usually has one SDK that covers its browser and
  server code, such as `@sentry/nextjs`.
- A framework deployed to a specific runtime can need the runtime's SDK too.
  TanStack Start on Cloudflare uses `@sentry/cloudflare` for the Worker and
  `@sentry/tanstackstart-react` for the app. Its setup page lives under the
  runtime's docs (Cloudflare → Frameworks → TanStack Start), not only under
  the framework's.
- Separately deployed workers, edge functions, or background services each
  get their own SDK, set up from their own docs page.
- Some features need extra packages, such as `@sentry/profiling-node` or
  `sentry-sdk[django]`.

Search the docs for the exact combination, for example
`sentry docs list "tanstack start cloudflare"`.

**Whether Sentry is already there.** Look for Sentry packages in the
dependency manifests (`package.json`, `requirements.txt`, `pyproject.toml`,
`Gemfile`, `go.mod`, `composer.json`, `pom.xml`, `build.gradle`,
`Cargo.toml`, `pubspec.yaml`, ...), a `Sentry.init`, `sentry_sdk.init`, or
`Sentry.withSentry` call, and a DSN in the code or environment files.

- **Sentry is already set up.** Tell the user what you found: the SDKs and
  their versions, the Sentry project the DSN points to, and which features
  are on. Ask what they want: upgrade the SDKs, turn on more features
  (step 5), or fix something that isn't working. Skip step 4 and change only
  what they ask for. Compare the installed version with the latest release
  (`npm view @sentry/nextjs version`, `pip index versions sentry-sdk`, or the
  ecosystem's equivalent). Before a major-version upgrade, read the migration
  guide with `sentry docs "migrate <sdk> from v<old> to v<new>"`.
- **Sentry is not set up.** Continue with step 4.

## 4. Pick the Sentry project

Ask the user whether to use an existing Sentry project or create a new one.

Create a new project. Get the platform identifier first, then create the
project. The JSON output includes its DSN:

```bash
sentry platform list --search nextjs
sentry project create my-app:javascript-nextjs --json
```

If the CLI can't tell which organization or team to use, it says so. Ask the
user, then pass the organization as a prefix
(`my-org/my-app:javascript-nextjs`) and the team with `--team <slug>`.
`sentry org list` and `sentry team list my-org/` show the choices.

Or use an existing project and read its DSN:

```bash
sentry project list my-org/
sentry dsn list my-org/my-project --json --fields name,dsn
```

## 5. Choose features

Error monitoring is always on. Suggest the features that fit the app, check
in the docs that its SDKs support them, and ask the user which to enable:

| Feature             | What it gives you                                                 | Suggest it when                                    |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Errors and issues   | Exceptions and crashes, grouped into issues with stack traces     | Always on                                          |
| Tracing             | Request and transaction performance, distributed across services  | Web servers, APIs, frontends                       |
| Logs                | Structured logs, linked to the trace and the error they belong to | Backends, workers                                  |
| Metrics             | Custom counters, gauges, and distributions                        | Backends with business metrics                     |
| Session Replay      | Video-like replays of user sessions around errors                 | The app has browser code                           |
| Profiling           | Function-level CPU profiles of slow code                          | Backends, mobile apps                              |
| Crons               | Alerts when scheduled jobs fail, run late, or don't run           | The code runs a recurring production job           |
| User Feedback       | An in-app widget for users to report problems                     | Browser and mobile apps                            |
| AI agent monitoring | Traces of LLM calls, tool calls, tokens, and cost                 | Application code calls an LLM or runs an agent     |
| MCP monitoring      | Tool, prompt, and resource calls on an MCP server                 | Application code implements or hosts an MCP server |

Suggest Crons, AI agent monitoring, and MCP monitoring only when you found
the code for them. A scheduled CI job, a timeout, or a retry loop is not a
cron job; an MCP client is not an MCP server. Profiling, AI agent monitoring,
and MCP monitoring need tracing on.

Readable stack traces also need source maps (JavaScript) or debug symbols
(native and mobile) uploaded at build time. Offer that when it applies; it
needs a Sentry auth token in the build environment, which the user has to
add.

## 6. Install and configure the SDKs

For each SDK from step 3, fetch its setup page and follow it:

```bash
sentry docs "How do I set up Sentry in <framework> on <runtime>?"
sentry docs "How do I enable <feature> in <framework>?"
```

- Install every package the new code imports, with the project's package
  manager and without a version. A docs page's install command can list
  fewer packages than its code imports. In a workspace, install into the app,
  not the root, and keep the project's conventions (such as pnpm catalogs).
- Configure only the features the user chose. Docs snippets include options
  for other features; leave those out.
- Put the DSN in the SDK init code, the way the docs do; a DSN is not a
  secret. If the project already reads the DSN from an environment variable,
  keep that. Real secrets, such as the auth token for source map uploads, go
  in environment variables.
- Don't turn on `sendDefaultPii` or other options that collect personal data
  unless the user agrees.
- Sample rates of `1.0` are right for development. Tell the user to lower
  them for production traffic.
- Match the project's code style, and don't change code unrelated to Sentry.
- Don't run `npx @sentry/wizard`; it is interactive and expects a human.

A few setups need more than an init call. The docs cover them; check that
you didn't skip them:

- Browser profiling needs the `Document-Policy: js-profiling` response
  header from the dev server and in production.
- AI agent monitoring: AI integrations the docs mark as enabled by default
  don't need adding. In the handlers that make AI calls, set the conversation
  ID and the user with the SDK's API, using IDs the handler already has.
- iOS and React Native need changes to the Xcode project, and Android and
  React Native need changes to the Gradle build.

## 7. Verify the setup

Make sure events reach Sentry before you call the job done.

First read back every file you changed: each SDK initializes, each chosen
feature is configured, and the packages are in the manifest and lockfile.

Then add a temporary line right after the SDK initializes that reports a test
error, such as `Sentry.captureException(new Error("Sentry setup test"))`, or
the SDK's equivalent in other languages. For server code, start the app
through the CLI. `--verify` waits up to 30 seconds for the SDK to send an
event, then stops the app:

```bash
sentry local run --verify -- npm run dev
```

For a browser app, load the page instead, or ask the user to. Then confirm
that the issue reached Sentry. It can take a minute to show up:

```bash
sentry issue list my-org/my-project --query "Sentry setup test" --period 1h
```

Check the other features you turned on the same way. Run the app, send it a
request, and look for the data with `sentry trace list my-org/my-project` or
`sentry log list my-org/my-project`. Remove the test line when you're done,
unless the user wants to keep it.

If nothing arrives, check that the DSN is loaded where the SDK initializes,
that the SDK initializes before the rest of the app, and that the network
allows requests to the Sentry host. `sentry docs` has troubleshooting pages
for each SDK.

## 8. Report back

Tell the user, from what you actually checked:

- The SDKs and versions you installed or upgraded, and for which part of the
  app
- The Sentry organization and project, and where the DSN lives
- The features you turned on, and any you suggested that they declined
- What the verification showed, with the issue's short ID or link
- Anything left for them to do, such as adding an auth token for source map
  uploads or lowering sample rates for production
