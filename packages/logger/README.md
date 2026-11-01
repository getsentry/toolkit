# @sentry/logger

A small structured logger for Node.js and Bun with no dependencies. Each log
call becomes a record: level, tag, message arguments, and attributes. The
logger hands each record to its reporters, which decide where it goes:

- `fancyReporter`: consola-style terminal output for people.
- `jsonReporter`: one JSON object per line, for log collectors.
- `logfmtReporter`: one `key=value` line per call, for log collectors.
- `sentryReporter`: [Sentry structured logs](https://docs.sentry.io/product/explore/logs/),
  without a dependency on any Sentry package.

```sh
npm install @sentry/logger
```

## Why another logger?

The [Sentry CLI](https://github.com/getsentry/toolkit/tree/main/packages/cli)
used `consola`, which was the largest third-party package in the bundle that
shell completion loads on every TAB press. Replacing it cut that bundle from
about 322 KB to 249 KB and halved its load time. The CLI needed levels, tags,
consola's terminal layout, and Sentry log forwarding. No logger we measured
did that for less. Bundled and minified, `@logtape/logtape` is about 68 KB,
`tslog` 68 KB, `pino` 61 KB, and `signale` 49 KB; `loglevel` is about 3 KB
but has no tags and no reporter hook. `@sentry/logger` is about 5 KB (2.5 KB
gzipped) with all of its reporters.

Sentry forwarding takes the SDK's `logger` as an argument instead of importing
it, so the logger stays dependency-free and never loads the SDK on its own.

## Usage

```ts
import { createLogger } from "@sentry/logger";

const logger = createLogger();

logger.info("Checking for updates...");
logger.success("Upgrade complete!");
logger.warn("Token expires soon");

const log = logger.withTag("upgrade");
log.debug("Resolved %s → %s", "0.12.0", "0.13.0"); // hidden at the default level
```

Log methods take `console.log`-style arguments, `%s` placeholders included:
`error`, `warn`, `log`, `info`, `success`, `fail`, `start`, `debug`, and
`trace`. They stay bound, so `const { info } = logger` works.

Without `reporters`, a logger writes with one `fancyReporter()` on stderr.

### Tags and attributes

`withTag()` and `withAttributes()` return scoped loggers. Nested tags join with
`:`, and attributes from each scope are merged:

```ts
const log = logger.withTag("auth").withAttributes({ user: "jane" });
log.withTag("token").info("Refreshed"); // tag "auth:token", user "jane"
```

Attribute values are strings, numbers, or booleans. The JSON and logfmt
reporters write them as fields, and the Sentry reporter sends them as log
attributes.

### Levels

| Level | Value | Shows                                      |
| ----- | ----- | ------------------------------------------ |
| error | 0     | error                                      |
| warn  | 1     | + warn                                     |
| log   | 2     | + log                                      |
| info  | 3     | + info, success, start, fail (the default) |
| debug | 4     | + debug                                    |
| trace | 5     | + trace                                    |

A root logger and every logger scoped from it share one level and one reporter
list. Setting `logger.level` later also changes the scoped loggers that
modules created at import time.

```ts
import { createLogger, parseLogLevel } from "@sentry/logger";

const logger = createLogger();
logger.level = parseLogLevel(process.env.MY_TOOL_LOG_LEVEL ?? "info");
```

`parseLogLevel` is case-insensitive and returns `info` (3) for an unknown name.
`LOG_LEVEL_NAMES` lists the names; the index of each name is its level.

## Reporters

Pass reporters to `createLogger()`, or add one later with `addReporter()`:

```ts
import { createLogger, jsonReporter } from "@sentry/logger";

const logger = createLogger({
  level: 3,
  reporters: [jsonReporter({ stream: process.stdout })],
});
```

Every reporter that writes text writes to `process.stderr` unless you pass a
`stream`: any object with a `write(chunk: string)` method.

### Fancy

`fancyReporter()` renders consola's "fancy" layout: icons, colors,
`WARN`/`ERROR` badges, and a right-aligned `tag HH:MM:SS`. When `CI` or `TEST`
is set, or `NODE_ENV` is `test`, lines are plain: `[info] [upgrade] message`.
`NO_COLOR` turns colors off and `FORCE_COLOR` turns them on without a TTY.

```ts
fancyReporter({
  stream: process.stderr,
  env: () => process.env,
  formatTime: (date) => date.toISOString(),
});
```

- `env`: returns the environment that picks the layout and colors. It is
  called on each log call. Pass a function when your tool runs with an
  environment of its own, such as a library mode that must not read the host's
  `process.env`.
- `formatTime`: renders the time next to the tag. Defaults to
  `formatLocalTime`, a 24-hour `HH:MM:SS` in local time that does not depend on
  ICU, so it stays correct in Node single-executable builds.

Errors render as their message, stack frames, and causes. Their other
properties, which can hold request or response details, are left out.

### JSON and logfmt

```ts
createLogger({ reporters: [jsonReporter()] })
  .withTag("auth")
  .info("Logged in");
// {"time":"2026-01-15T14:28:59.000Z","level":"info","tag":"auth","msg":"Logged in"}

createLogger({ reporters: [logfmtReporter()] })
  .withTag("auth")
  .info("Logged in");
// time=2026-01-15T14:28:59.000Z level=info tag=auth msg="Logged in"
```

Each line has `time` (ISO 8601), `level`, `type` when it differs from the level
(such as `success`), `tag` when set, `msg`, and then the attributes. An
attribute named like one of those fields is dropped.

### Sentry

`sentryReporter()` takes the SDK's `logger`, so it works with `@sentry/node`,
`@sentry/bun`, `@sentry/browser`, and the rest without depending on any of
them:

```ts
import * as Sentry from "@sentry/node";
import { sentryReporter } from "@sentry/logger";

Sentry.init({ dsn: "...", enableLogs: true });
logger.addReporter(sentryReporter(Sentry.logger));
```

Each call is sent at the matching Sentry severity (`fail` as `error`; `log`,
`success`, and `start` as `info`) with the record's attributes plus
`logger.tag` (when set), `logger.type`, and
`sentry.origin: "auto.log.sentry_logger"`. Errors contribute their message and
causes, not their stacks.

### Your own

A reporter is any object with a `log(record)` method. Records keep consola's
`{ date, args, type, level, tag }` shape and add `attributes`:

```ts
import { createLogger, type LogRecord } from "@sentry/logger";

const records: LogRecord[] = [];
const logger = createLogger({ reporters: [{ log: (r) => records.push(r) }] });
```

## Development

The package lives in [getsentry/toolkit](https://github.com/getsentry/toolkit)
under `packages/logger`. Workspace packages import its TypeScript source
directly; `pnpm --filter @sentry/logger run build` writes the `dist/` files
that the published package's `exports` point to.
`pnpm --filter @sentry/logger run test:package` packs the package and runs the
consumer project in `test/package/consumer` against the tarball, as ES modules
and as CommonJS. Releases go through the repository's Release workflow with the
`logger` product.
