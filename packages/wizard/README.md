# @sentry/wizard

> **Deprecated. Use `npx sentry wizard`.** The Sentry wizard is now the
> `sentry wizard` command of the [Sentry CLI](https://cli.sentry.dev). It
> takes the same integrations and flags:
>
> ```shell
> npx sentry wizard -i nextjs
> ```
>
> See the [`sentry wizard` docs](https://cli.sentry.dev/commands/wizard/).

From version 10, this package only forwards to `sentry wizard`, so existing
`npx @sentry/wizard` commands keep working:

```shell
npx @sentry/wizard -i nextjs --saas --org my-org --project my-project
```

It prints a deprecation notice on stderr, then runs `sentry wizard` from the
[`sentry`](https://www.npmjs.com/package/sentry) package it depends on, with
the same arguments. The exit code and signals pass through. The sign-up flags
`--signup`, `--promo-code` and `--coming-from` are gone: sign up at
<https://sentry.io/signup/> first. Version 9 stays on npm for anyone who pins
it.

## Development

`bin/sentry-wizard.js` is the whole package, shipped as written.
`pnpm run test` runs it against a stand-in `sentry` package. It is released on
its own, from the `packages/wizard` Craft workspace, not with the CLI.
