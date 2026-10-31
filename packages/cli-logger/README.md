# @sentry/cli-logger

A small terminal logger for Node.js command-line tools: log levels, tag scoping,
consola-style stderr output, and log records that
`Sentry.createConsolaReporter()` can forward to Sentry structured logs. The
logger itself depends only on `node:util` and `node:path`. The Sentry CLI uses it in
place of `consola`, whose size slowed every shell completion.

```sh
npm install @sentry/cli-logger
```

## Usage

```ts
import { createLogger } from "@sentry/cli-logger";

const logger = createLogger();

logger.info("Checking for updates...");
logger.success("Upgrade complete!");
logger.warn("Token expires soon");

const log = logger.withTag("upgrade");
log.debug("Resolved 0.12.0 → 0.13.0"); // hidden at the default level
```

All output goes to stderr, so stdout stays free for a command's data. In an
interactive terminal, lines get icons, colors, `WARN`/`ERROR` badges, and a
right-aligned `tag HH:MM:SS`. When `CI` or `TEST` is set, or `NODE_ENV` is
`test`, lines are plain: `[info] [upgrade] message`. `NO_COLOR` turns colors
off and `FORCE_COLOR` turns them on without a TTY.

Errors passed to a log method render as their message, stack frames, and
causes. Their other properties, which can hold request or response details,
are left out.

## Levels

| Level | Value | Shows                                  |
| ----- | ----- | -------------------------------------- |
| error | 0     | error                                  |
| warn  | 1     | + warn                                 |
| log   | 2     | + log                                  |
| info  | 3     | + info, success, start, fail (default) |
| debug | 4     | + debug                                |
| trace | 5     | + trace                                |

A root logger and every logger its `withTag()` calls return share one level
and one reporter list. Setting `logger.level` later also changes the scoped
loggers that modules created at import time.

```ts
import { createLogger, parseLogLevel } from "@sentry/cli-logger";

const logger = createLogger();
logger.level = parseLogLevel(process.env.MY_TOOL_LOG_LEVEL ?? "info");
```

`parseLogLevel` is case-insensitive and returns `info` (3) for an unknown name.
`LOG_LEVEL_NAMES` lists the names, and the index of each name is its level.

## Options

```ts
createLogger({
  level: 3,
  env: () => process.env,
  formatTime: (date) => date.toISOString(),
  prompt: clackPrompt,
});
```

- `level`: the initial level. Defaults to `3` (info).
- `env`: returns the environment the stderr output reads (`CI`, `NO_COLOR`,
  `FORCE_COLOR`, `TERM`, ...). It is called on each log call. Defaults to
  `process.env`. Pass a function when your tool runs with an environment of
  its own, such as a library mode that must not read the host's
  `process.env`.
- `formatTime`: renders the time next to the tag. Defaults to
  `formatLocalTime`, a 24-hour `HH:MM:SS` in local time that does not depend
  on ICU, so it stays correct in Node single-executable builds.
- `prompt`: answers `logger.prompt()`. Without one, `logger.prompt()` rejects.

## Forwarding logs to Sentry

Log records keep consola's `{ date, args, type, level, tag }` shape, so the
reporter from `@sentry/node` works unchanged:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "...", enableLogs: true });
logger.addReporter(Sentry.createConsolaReporter());
```

Add the reporter after `Sentry.init()`. `addReporter()` takes any object with a
`log(logObj)` method, so other sinks work the same way.

## Prompts

`@sentry/cli-logger/prompt` exports `clackPrompt`, which asks with
[`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts). Install
`@clack/prompts` yourself; it is an optional peer dependency and loads only when
a prompt runs.

```ts
import { createLogger } from "@sentry/cli-logger";
import { clackPrompt } from "@sentry/cli-logger/prompt";

const logger = createLogger({ prompt: clackPrompt });

const ok = await logger.prompt("Continue?", { type: "confirm", initial: true });
if (ok !== true) {
  process.exit(1);
}

const name = await logger.prompt("Project name:", {
  type: "text",
  placeholder: "my-project",
});
if (typeof name !== "string") {
  process.exit(1);
}
```

A prompt resolves to the answer, or to clack's cancel symbol when the user
presses Ctrl+C. Check for `=== true` or `typeof answer === "string"` rather
than truthiness.

Any function with the `Prompt` type works as `prompt`, which also makes
prompts easy to stub in tests.

## Development

The package lives in [getsentry/toolkit](https://github.com/getsentry/toolkit)
under `packages/cli-logger`. Workspace packages import its TypeScript source
directly; `pnpm --filter @sentry/cli-logger run build` writes the `dist/`
files that the published package's `exports` point to. Releases go through the
repository's Release workflow with the `cli-logger` product.
