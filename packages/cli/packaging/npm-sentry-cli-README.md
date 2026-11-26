# @sentry/cli

Version 4 of the Sentry CLI is published as [`sentry`](https://www.npmjs.com/package/sentry).
`@sentry/cli` 4.x ships the same code under the old package name, so that
upgrades find it. Install `sentry` instead:

```bash
npm install -g sentry
```

The command is now `sentry`, not `sentry-cli`, and the `SentryCli` class is
replaced by `createSentrySDK()`. Version 3 stays available as `@sentry/cli@3`.

See [Migrating from v3](https://cli.sentry.dev/migrating-from-v3/) and the
[documentation](https://cli.sentry.dev).
