---
title: Library Usage
description: Use the Sentry CLI programmatically in Node.js
---

The Sentry CLI can be used as a JavaScript/TypeScript library, running commands
in-process without spawning a subprocess. This is useful for AI coding agents,
build tools, CI scripts, and other tools that want structured Sentry data.

## Installation

```bash
npm install sentry
```

## Quick Start

```typescript
import createSentrySDK from "sentry";

const sdk = createSentrySDK({ token: "sntrys_..." });

// Typed methods for every CLI command
const orgs = await sdk.org.list();
const issues = await sdk.issue.list({ orgProject: "acme/frontend", limit: 5 });
```

## Typed SDK

`createSentrySDK()` returns an object with typed methods for **every** CLI command,
organized by the CLI route hierarchy:

```typescript
import createSentrySDK from "sentry";

const sdk = createSentrySDK({ token: "sntrys_..." });
```

### Organizations

```typescript
const orgs = await sdk.org.list();
const org = await sdk.org.view({ org: "acme" });
```

### Projects

```typescript
const projects = await sdk.project.list({ orgProject: "acme/" });
const project = await sdk.project.view({ orgProject: "acme/frontend" });
```

### Issues

```typescript
const issues = await sdk.issue.list({
  orgProject: "acme/frontend",
  limit: 10,
  query: "is:unresolved",
  sort: "date",
});

const issue = await sdk.issue.view({}, "ACME-123");
```

### Events, Traces, Spans

```typescript
const event = await sdk.event.view({}, "abc123...");

const traces = await sdk.trace.list({ orgProject: "acme/frontend" });
const trace = await sdk.trace.view({}, "abc123...");

const spans = await sdk.span.list({}, "acme/frontend");
```

### Dashboards

```typescript
const dashboards = await sdk.dashboard.list({}, "acme/");
const dashboard = await sdk.dashboard.view({}, "acme/", "my-dashboard");

// Nested widget commands
await sdk.dashboard.widget.add(
  { display: "line", query: ["count"] },
  "acme/", "my-dashboard", "Errors over time"
);
```

### Teams

```typescript
const teams = await sdk.team.list({ orgProject: "acme/" });
```

### Authentication

```typescript
await sdk.auth.login();
await sdk.auth.status();
const whoami = await sdk.auth.whoami();
```

The typed SDK invokes command handlers directly — bypassing CLI string parsing
for zero overhead beyond the command's own logic.

## Escape Hatch: `run()`

For commands not easily expressed through the typed API, or when you want to
pass raw CLI flags, use `sdk.run()`:

```typescript
// Run any CLI command — returns parsed JSON by default
const version = await sdk.run("--version");
const issues = await sdk.run("issue", "list", "-l", "5");
const help = await sdk.run("help", "issue");
```

## Authentication

The `token` option provides an auth token for the current invocation. When
omitted, it falls back to stored credentials and environment variables:

1. `token` option (highest priority)
2. Stored OAuth token from `sentry auth login` (if not expired)
3. `SENTRY_AUTH_TOKEN` environment variable
4. `SENTRY_TOKEN` environment variable

Set `SENTRY_FORCE_ENV_TOKEN=1` to make environment variable tokens take priority over stored OAuth.

```typescript
// Explicit token
const sdk = createSentrySDK({ token: "sntrys_..." });

// Or set the env var — it's picked up automatically
process.env.SENTRY_AUTH_TOKEN = "sntrys_...";
const sdk = createSentrySDK();
```

## Options

All options are optional. Pass them when creating the SDK:

```typescript
const sdk = createSentrySDK({ token: "...", text: true, cwd: "/my/project" });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | Auto-detected | Auth token for this invocation |
| `url` | `string` | `sentry.io` | Sentry instance URL for self-hosted |
| `org` | `string` | Auto-detected | Default organization slug |
| `project` | `string` | Auto-detected | Default project slug |
| `text` | `boolean` | `false` | Return human-readable text instead of parsed JSON (`run()` only) |
| `cwd` | `string` | `process.cwd()` | Working directory for DSN auto-detection |
| `headers` | `Record<string, string>` | — | Extra HTTP headers for self-hosted instances behind a reverse proxy (same as [`SENTRY_CUSTOM_HEADERS`](./configuration/#sentry_custom_headers)); ignored for sentry.io |
| `signal` | `AbortSignal` | — | Abort signal for cancelling streaming commands |

## Return Values

Typed SDK methods return **parsed JavaScript objects** with zero serialization
overhead (via zero-copy capture). The `run()` escape hatch returns parsed JSON
by default, or a trimmed string for commands without JSON support.

```typescript
// Typed methods → typed return
const issues = await sdk.issue.list({ orgProject: "acme/frontend" });
// IssueListResult type with known fields

// run() → parsed JSON or string
const version = await sdk.run("--version");
// "sentry 0.21.0"
```

## Error Handling

Commands that fail throw a `SentryError`:

```typescript
import createSentrySDK, { SentryError } from "sentry";

const sdk = createSentrySDK();

try {
  await sdk.issue.view({}, "NONEXISTENT-1");
} catch (err) {
  if (err instanceof SentryError) {
    console.error(err.message);   // Clean error message (no ANSI codes)
    console.error(err.exitCode);  // Non-zero exit code
    console.error(err.stderr);    // Raw stderr output
  }
}
```

## Environment Isolation

The library never mutates `process.env`. Each invocation creates an isolated
copy of the environment. This means:

- Your application's env vars are never touched
- Multiple sequential calls are safe
- Auth tokens passed via `token` don't leak to subsequent calls

:::note
Concurrent calls are not supported in the current version.
Calls should be sequential (awaited one at a time).
:::

## Comparison with Subprocess

| | Library (`createSentrySDK()`) | Subprocess (`child_process`) |
|---|---|---|
| **Startup** | ~0ms (in-process) | ~200ms (process spawn + init) |
| **Output** | Parsed object (zero-copy) | String (needs JSON.parse) |
| **Errors** | `SentryError` with typed fields | Exit code + stderr string |
| **Auth** | `token` option or env vars | Env vars only |
| **Node.js** | >=20 required | Any version |

## Requirements

- **Node.js >= 20**. On Node.js 22.15+ the built-in `node:sqlite` module is used; on Node.js 20–22.14 the CLI transparently falls back to a bundled WASM SQLite driver, so no native module or extra install step is required.

:::caution
The WASM SQLite fallback (Node.js 20–22.14) does not support [WAL mode](https://www.sqlite.org/wal.html), so concurrent access from multiple processes is slower and its local cache reads/writes are less efficient. For the best performance and reliability we **strongly recommend** the [standalone binary](/installation/) (which bundles a modern runtime) or running on **Node.js 22.15+** so the native `node:sqlite` driver is used.
:::

## Streaming Commands

Two commands support real-time streaming: `log list --follow` and `dashboard view --refresh`.
When using streaming flags, methods return an `AsyncIterable` instead of a `Promise`:

```typescript
const sdk = createSentrySDK({ token: "sntrys_..." });

// Stream logs as they arrive (polls every 5 seconds)
for await (const log of sdk.log.list({ follow: "5" }, "acme/backend")) {
  console.log(log);
}

// Auto-refresh dashboard (polls every 30 seconds)
for await (const snapshot of sdk.run("dashboard", "view", "123", "--refresh", "30")) {
  console.log(snapshot);
}

// Stop streaming by breaking out of the loop
for await (const log of sdk.log.list({ follow: "2" })) {
  if (someCondition) break; // Streaming stops immediately
}
```

### Cancellation

`break` in a `for await...of` loop immediately signals the streaming command to stop.
You can also pass an `AbortSignal` via `SentryOptions` for programmatic cancellation:

```typescript
const controller = new AbortController();
const sdk = createSentrySDK({ token: "...", signal: controller.signal });

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

for await (const log of sdk.log.list({ follow: "5" })) {
  console.log(log);
}
// Loop exits when signal fires
```

:::note
Concurrent streaming calls are not supported. Each streaming invocation
uses an isolated environment — only one can be active at a time.
:::
