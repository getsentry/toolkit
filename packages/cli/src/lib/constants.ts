/**
 * Runtime constants for the CLI.
 */

import { getEnv } from "./env.js";

/** Build-time constant injected by esbuild/bun */
declare const SENTRY_CLI_VERSION: string | undefined;

/**
 * Build-time debug ID for sourcemap resolution, injected by esbuild.
 *
 * During the build, esbuild's `define` replaces this identifier with a
 * placeholder UUID string literal. After esbuild finishes, the build
 * script replaces the placeholder with the real debug ID (derived from
 * the minified JS + sourcemap content hash). The same-length swap keeps
 * sourcemap character positions valid.
 */
declare const __SENTRY_DEBUG_ID__: string | undefined;

/** Default Sentry SaaS hostname */
export const DEFAULT_SENTRY_HOST = "sentry.io";

/** Default Sentry SaaS URL (control silo for OAuth and region discovery) */
export const DEFAULT_SENTRY_URL = `https://${DEFAULT_SENTRY_HOST}`;

/**
 * Name of the JavaScript package directory — used as both a skip target
 * when walking project trees (DSN scanner, sourcemap discovery, init
 * wizard) and as a path segment when detecting how the CLI itself was
 * installed (upgrade detection).
 */
export const NODE_MODULES_DIRNAME = "node_modules";

/** Matches strings that already start with http:// or https:// */
const HAS_PROTOCOL_RE = /^https?:\/\//i;

/**
 * Normalize a URL string by ensuring it has a protocol prefix.
 *
 * Users commonly set `SENTRY_HOST=sentry.example.com` without a protocol.
 * Without normalization, the bare hostname is used as-is in URL construction
 * (e.g., `sentry.example.com/api/0/...`), producing an invalid URL that
 * causes `TypeError: Failed to construct 'Request': Invalid URL`.
 *
 * @param url - Raw URL string (may or may not have a protocol)
 * @returns URL with `https://` prepended if no protocol was present, or
 *   undefined if the input is empty/whitespace
 * @internal Exported for testing
 */
export function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) {
    return;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return;
  }
  // Already has a protocol — return as-is
  if (HAS_PROTOCOL_RE.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/**
 * Resolve the Sentry instance URL from environment variables.
 * Checks SENTRY_HOST first, then SENTRY_URL, then falls back to undefined.
 *
 * Bare hostnames (e.g., `sentry.example.com`) are automatically prefixed
 * with `https://` to prevent invalid URL construction downstream.
 */
export function getConfiguredSentryUrl(): string | undefined {
  const raw = getEnv().SENTRY_HOST || getEnv().SENTRY_URL || undefined;
  return normalizeUrl(raw);
}

/** CLI version string, available for help output and other uses */
export const CLI_VERSION =
  typeof SENTRY_CLI_VERSION !== "undefined" ? SENTRY_CLI_VERSION : "0.0.0-dev";

/**
 * Derive the telemetry environment from the build-injected version string.
 *
 * - `"0.0.0-dev"` (no build injection) → `"development"`
 * - `"X.Y.Z-dev.<timestamp>"` (nightly CI build) → `"nightly"`
 * - `"X.Y.Z"` (stable release) → `"production"`
 *
 * This replaces the previous `process.env.NODE_ENV` approach which broke
 * when the `getEnv()` indirection was introduced — esbuild's `define` can
 * only replace literal `process.env.NODE_ENV`, not dynamic property accesses
 * like `getEnv().NODE_ENV`.
 */
export function getCliEnvironment(version: string = CLI_VERSION): string {
  if (version === "0.0.0-dev") {
    return "development";
  }
  if (version.includes("-dev.")) {
    return "nightly";
  }
  return "production";
}

/**
 * Generate the User-Agent string for API requests.
 * Format: sentry-cli/<version> (<os>-<arch>) <runtime>/<version>
 *
 * @example "sentry-cli/0.5.0 (linux-x64) bun/1.3.13"
 * @example "sentry-cli/0.5.0 (darwin-arm64) node/22.12.0"
 */
export function getUserAgent(): string {
  const runtime =
    typeof process.versions.bun !== "undefined"
      ? `bun/${process.versions.bun}`
      : `node/${process.versions.node}`;
  return `sentry-cli/${CLI_VERSION} (${process.platform}-${process.arch}) ${runtime}`;
}

/**
 * DSN for CLI telemetry (error tracking and usage metrics).
 *
 * This is NOT for user projects - it's for tracking errors in the CLI itself.
 * Safe to hardcode as DSNs are designed to be public (they only allow sending
 * events, not reading data).
 */
export const SENTRY_CLI_DSN =
  "https://1188a86f3f8168f089450587b00bca66@o1.ingest.us.sentry.io/4510776311808000";

/**
 * Register the build-time debug ID with the Sentry SDK's native discovery.
 *
 * The SDK reads `globalThis._sentryDebugIds` (a map of Error.stack → debugId)
 * during event processing to populate `debug_meta.images`, which the server
 * uses to match uploaded sourcemaps.
 *
 * Previously this was done by a runtime IIFE snippet prepended to the bundle
 * output by `injectDebugId()`. That broke ESM because the snippet appeared
 * before `import` declarations. Placing the same logic here — inside the
 * module, after all imports — is valid ESM and feeds the SDK's existing
 * mechanism directly.
 */
if (typeof __SENTRY_DEBUG_ID__ !== "undefined") {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // biome-ignore lint/suspicious/useErrorMessage: stack trace capture only
    const stack = new Error().stack;
    if (stack) {
      // biome-ignore lint/suspicious/noExplicitAny: SDK reads this untyped global
      const g = globalThis as any;
      g._sentryDebugIds = g._sentryDebugIds || {};
      g._sentryDebugIds[stack] = __SENTRY_DEBUG_ID__;
    }
  } catch (_) {
    // Non-critical — sourcemap resolution degrades gracefully
  }
}
