# @sentry/wizard

> **Deprecated. Use `npx sentry wizard`.** The Sentry wizard is now the
> `sentry wizard` command of the [Sentry CLI](https://cli.sentry.dev). It
> takes the org and project first, then the integration:
>
> ```shell
> npx sentry wizard my-org/my-project nextjs
> ```
>
> See the [`sentry wizard` docs](https://cli.sentry.dev/commands/wizard/).

From version 10, this package only forwards to `sentry wizard`, so existing
`npx @sentry/wizard` commands keep working:

```shell
# Runs `sentry wizard my-org/my-project nextjs`
npx @sentry/wizard -i nextjs --org my-org --project my-project
```

It prints a deprecation notice on stderr, then runs `sentry wizard` from the
[`sentry`](https://www.npmjs.com/package/sentry) package it depends on, with
the old flags translated:

- `-i`/`--integration <id>` becomes the integration argument.
- `--org <org> --project <project>` becomes `<org>/<project>`, and `--org`
  alone becomes `<org>/`.
- `--force-install`, `--ignore-git-changes`, `-f` and `--force` become `-f`.
- `-u`/`--url <url>` sets `SENTRY_URL` for the run.
- `--spotlight` sets `SENTRY_SPOTLIGHT=1` for the run.
- Positional arguments and `--help` pass through.

Every other old flag is ignored with a notice, including `--project` without
`--org`, `--saas` and the sign-up flags (sign up at <https://sentry.io/signup/> first). The exit code
and signals pass through. Version 9 stays on npm for anyone who pins it.

## Development

`bin/sentry-wizard.js` is the whole package, shipped as written.
`pnpm run test` runs it against a stand-in `sentry` package. It is released on
its own, from the `packages/wizard` Craft workspace, not with the CLI.
