/**
 * Shared types for the SDK layer.
 *
 * Lives in `lib/` so both `index.ts` (public API) and `sdk-invoke.ts`
 * (internal) can import without circular dependencies.
 *
 * @module
 */

import { redactCredentialText } from "./credential-redaction.js";

/** Options for programmatic CLI invocation. */
export type SentryOptions = {
  /**
   * Auth token override. When omitted, falls back to `SENTRY_AUTH_TOKEN`
   * or `SENTRY_TOKEN` environment variables, then stored credentials.
   */
  token?: string;

  /**
   * Sentry instance URL for self-hosted installations.
   * Defaults to `sentry.io`. Accepts with or without protocol
   * (e.g., `"sentry.example.com"` or `"https://sentry.example.com"`).
   */
  url?: string;

  /**
   * Default organization slug. When set, commands that need an org
   * will use this instead of requiring it on every call.
   */
  org?: string;

  /**
   * Default project slug. When set, commands that need a project
   * will use this instead of requiring it on every call.
   */
  project?: string;

  /**
   * Return human-readable text instead of parsed JSON.
   * When `true`, the `run()` function returns a `string` instead of a parsed object.
   */
  text?: boolean;

  /**
   * Working directory for this invocation.
   * Affects DSN auto-detection and project root resolution.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;

  /**
   * Extra HTTP headers to send with every request to a self-hosted Sentry
   * instance, for reverse proxies that require them (e.g., Google IAP,
   * Cloudflare Access). Same rules as `SENTRY_CUSTOM_HEADERS`, which this
   * option replaces when set (even when empty); ignored when targeting sentry.io.
   */
  headers?: Record<string, string>;

  /**
   * Abort signal for cancelling streaming commands.
   * When aborted, streaming iterables stop on the next poll cycle.
   * Consumer `break` in `for await...of` also triggers abort automatically.
   * Has no effect on non-streaming (Promise-based) commands.
   */
  signal?: AbortSignal;
};

/**
 * Error thrown when a CLI command exits with a non-zero code.
 *
 * Wraps the stderr output and exit code for programmatic error handling.
 */
export class SentryError extends Error {
  /** CLI exit code (non-zero). */
  readonly exitCode: number;

  /** Captured stderr output with recognizable credentials redacted. */
  readonly stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(redactCredentialText(message));
    this.name = "SentryError";
    this.exitCode = exitCode;
    this.stderr = redactCredentialText(stderr);
  }
}
