# sentry-cli

The command-line interface for [Sentry](https://sentry.io), built for
developers and AI agents.

Each wheel contains the standalone `sentry` binary for one platform: macOS
(arm64, x64), Linux with glibc 2.28 or later (arm64, x64), and Windows (x64).
There is no source distribution, so pip cannot install it on other platforms,
such as Alpine Linux. Use `npm install -g sentry` there.

```bash
pip install sentry-cli
sentry --help
```

Version 4 installs a `sentry` command, not `sentry-cli`. To keep version 3,
pin `sentry-cli<4`. The `sentry` package (self-hosted Sentry) also installs a
`sentry` command, so do not install both into the same environment.

See [Migrating from v3](https://cli.sentry.dev/migrating-from-v3/) and the
[documentation](https://cli.sentry.dev).
