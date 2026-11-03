# Logging Reference

How logging works in the Sentry MCP server using LogTape and Sentry. For tracing, spans, or metrics see [Monitoring](monitoring.md).

## Overview

We use [LogTape](https://logtape.org/) for structured logging with two sinks:

- **Console sink**: JSON Lines format for log aggregation
- **Sentry sink**: Sends logs to Sentry's Logs product using `Sentry.logger.*` API

Log levels are controlled by:

1. `LOG_LEVEL` environment variable (e.g., `"debug"`, `"info"`, `"warning"`, `"error"`)
2. Falls back to `NODE_ENV`: `"debug"` in development, `"info"` in production

**Important**: We use a custom LogTape sink that calls `Sentry.logger.*` methods to send logs to Sentry's Logs product. The `@logtape/sentry` package uses `captureException/captureMessage` which creates Issues instead of Logs.

Implementation: `packages/mcp-core/src/telem/logging.ts`

## Stdio Transport Invariant: Logs MUST Go to Stderr

The MCP stdio transport reserves **stdout** for JSON-RPC frames. Any non-JSON-RPC line written to stdout makes the client fail framing and close the transport. **All log output — every level, every sink that writes to a console — must go to stderr.**

This is enforced in `packages/mcp-core/src/telem/logging.ts` via `STDERR_CONSOLE_LEVEL_MAP`, which routes every LogTape level through `console.error` (Node sends `console.error`/`console.warn` to stderr; `console.log`/`console.info`/`console.debug` go to stdout). Severity is preserved inside the JSON record (e.g. `"level":"INFO"`); the map only controls which `console.*` method is invoked.

Regression history: #922 — LogTape's default level map sent `info`/`debug` records through `console.info`/`console.debug`, landing structured JSON on stdout and breaking stdio clients.

**Rules for new code:**

- Do not call `console.log`, `console.info`, or `console.debug` anywhere reachable from the stdio entry point. Use `logInfo`/`logDebug` instead.
- Do not introduce new LogTape sinks that write to stdout.
- Do not change `STDERR_CONSOLE_LEVEL_MAP` to map any level to a non-stderr method. The regression test in `logging.test.ts` enforces this for `info`.

## Using the Log Helpers

### logInfo() - Routine telemetry

```typescript
import { logInfo } from "@sentry/mcp-core/telem/logging";

logInfo("MCP server started", {
  loggerScope: ["server", "lifecycle"],
  extra: { port: 3000 },
});
```

### logWarn() - Operational warnings

```typescript
import { logWarn } from "@sentry/mcp-core/telem/logging";

logWarn("Rate limit approaching", {
  loggerScope: ["api", "rate-limit"],
  extra: { remaining: 10, limit: 100 },
});
```

### logError() - Operational errors (no Sentry issue)

```typescript
import { logError } from "@sentry/mcp-core/telem/logging";

logError(error, {
  loggerScope: ["tools", "fetch-trace"],
  extra: { traceId: "abc123" },
});
```

### logIssue() - System errors (creates Sentry issue)

```typescript
import { logIssue } from "@sentry/mcp-core/telem/logging";

const eventId = logIssue(error, {
  loggerScope: ["oauth", "token-refresh"],
  contexts: {
    oauth: { client_id: "..." },
  },
});
```

## When to Use Each Helper

**Use `logIssue()` for:**

- System errors (5xx, network failures, unexpected exceptions)
- Critical failures that need investigation
- Creates a Sentry Issue + emits a log entry with Event ID

**Use `logError()` for:**

- Expected operational errors (trace fetch failed, encoding error)
- Errors that are handled gracefully
- Sends to Sentry Logs only (no Issue created)

**Use `logWarn()` for:**

- Rate limit approaching
- Deprecated API usage
- Configuration warnings

**Use `logInfo()` for:**

- Request lifecycle (connection established, tool invoked)
- Configuration output
- Routine telemetry

**Skip logging:**

- `UserInputError` - Expected validation failures
- 4xx API responses - Client errors (except 429 rate limits)
- See [Error Handling](../contributing/error-handling.md) for complete rules

## Log Options

All helpers accept:

```typescript
interface LogOptions {
  loggerScope?: string | readonly string[]; // e.g., ["cloudflare", "oauth"]
  extra?: Record<string, unknown>; // Additional context
  contexts?: Record<string, Record<string, unknown>>; // Sentry contexts
}
```

`logIssue()` also accepts `attachments` for files to attach to the Sentry event.

## Configuration

**Environment Variables:**

- `LOG_LEVEL` - Override log level (`"debug"`, `"info"`, `"warning"`, `"error"`)
- `NODE_ENV` - Determines default level (`"development"` = debug, else info)

**Sinks:**

- Console: JSON Lines format for log aggregation
- Sentry: Sends logs to Sentry for monitoring (uses `Sentry.init` config)

Cloudflare Workers should not enable Sentry's `consoleLoggingIntegration`
alongside this LogTape setup. The LogTape Sentry sink is the canonical Sentry
Logs path; capturing the console sink as well duplicates every structured
record as a high-cardinality JSON-message log.

## HTTP Request Logging

Cloudflare middleware logs all HTTP requests automatically:

```typescript
// Middleware in packages/mcp-cloudflare/src/server/logging.ts
app.use(createRequestLogger(["cloudflare", "http"]));

// Logs: {"level":"INFO","message":"GET /api/search","properties":{"status":200,"duration_ms":42}}
```

## References

- Implementation: `packages/mcp-core/src/telem/logging.ts`
- Error handling patterns: [Error Handling](../contributing/error-handling.md)
- Monitoring and tracing: [Monitoring](monitoring.md)
- LogTape docs: https://logtape.org/
