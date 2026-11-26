

## Setting up Sentry interactively

`sentry wizard` sets up the Sentry SDK in the project in the current
directory. It asks a few questions, installs the SDK for your framework,
writes its configuration, and sets up source map or debug file uploads. It
takes an optional `<org>/<project>` first, then an optional integration:

- Pass an integration, such as `nextjs`, to skip the integration picker.
- Pass `<org>/<project>` first to skip the org and project pickers, or
  `<org>/` to pick only the project. Without it, the wizard asks; it doesn't
  detect a project from your files.
- An integration id is never read as a project or org, and a single bare
  word is always read as an integration. Write a project or org with a `/`:
  `my-org/my-project`, `my-org/`, or `/my-project`. For a project spelled
  like an integration, write `my-org/nextjs`.
- `-f`/`--force` changes a project with uncommitted changes without asking,
  and installs the SDK even when the package manager's checks fail.

It logs in with your `sentry auth login` account, or starts a login when you
have none, on the Sentry instance the rest of the CLI uses: `SENTRY_URL`, or
the stored login's. To use a self-hosted instance, log in to it first with
`sentry auth login --url`.

Set `SENTRY_SPOTLIGHT=1` to set up Spotlight for local development instead,
with no Sentry account or login. Telemetry follows the CLI's settings
(`SENTRY_CLI_NO_TELEMETRY`, `DO_NOT_TRACK`, `sentry cli defaults`), and the
global `--verbose` flag shows the wizard's debug output.

`sentry wizard` changes your project's files. To have a coding agent set up
Sentry instead, run `sentry init`, which prints the agent's setup guide and
changes nothing.

## Coming from `@sentry/wizard`

`sentry wizard` takes the same integration ids as `npx @sentry/wizard -i`,
but not its flags or `SENTRY_WIZARD_*` environment variables:

| `@sentry/wizard`                       | `sentry wizard`                                  |
| -------------------------------------- | ------------------------------------------------ |
| `-i nextjs`                            | `nextjs`                                         |
| `--org my-org --project my-project`    | `my-org/my-project`, before the integration      |
| `--url`, `-u`, `--saas`                | `sentry auth login --url`, or `SENTRY_URL`       |
| `--spotlight`                          | `SENTRY_SPOTLIGHT=1`                             |
| `--force-install`, `--ignore-git-changes` | `-f`/`--force`                                |
| `--disable-telemetry`                  | `SENTRY_CLI_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`  |
| `--debug`                              | `--verbose` or `--log-level debug`               |
| `--signup`, `--promo-code`, `--coming-from` | Sign up at https://sentry.io/signup/ first  |

The Cordova and Electron wizards were retired. Follow their setup guides in
the Sentry docs instead.

Flows that uploaded source maps with `@sentry/cli`, such as Angular, now
install the `sentry` package instead. The `sentry:sourcemaps` script they add
to `package.json` runs `sentry sourcemap inject` and `sentry sourcemap upload`
on your build output. The wizard writes your org and project to the
`[defaults]` section of the project's `.sentryclirc`, next to the auth token,
and adds the file to `.gitignore`. In CI, set `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG` and `SENTRY_PROJECT` instead. On self-hosted Sentry, also set
`SENTRY_URL` wherever that script runs.
