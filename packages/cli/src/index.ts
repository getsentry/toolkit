/**
 * Library entry point for programmatic Sentry CLI usage.
 *
 * Provides `createSentrySDK()` as the single public API — a typed SDK client
 * with named methods for every CLI command, plus a `run()` escape hatch for
 * arbitrary command strings.
 *
 * @example
 * ```typescript
 * import createSentrySDK from "sentry";
 *
 * const sdk = createSentrySDK({ token: "sntrys_..." });
 * const orgs = await sdk.org.list();
 * const issues = await sdk.issue.list({ orgProject: "acme/frontend" });
 *
 * // Escape hatch for arbitrary commands
 * const version = await sdk.run("--version");
 * ```
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "./lib/constants.js";
import { buildInvoker, buildRunner } from "./lib/sdk-invoke.js";
import { createSDKMethods } from "./sdk.generated.js";

export type { AsyncChannel } from "./lib/async-channel.js";
// Re-export public types and error class from the shared module.
// These re-exports exist to break a circular dependency between
// index.ts ↔ sdk-invoke.ts. SentryError and SentryOptions live
// in lib/sdk-types.ts and are re-exported here for the public API.
export { SentryError, type SentryOptions } from "./lib/sdk-types.js";
export type { SentrySDK } from "./sdk.generated.js";

/**
 * Create a typed SDK client with methods for every CLI command.
 *
 * Each method bypasses Stricli's string dispatch and invokes the command
 * handler directly with pre-built flags — no parsing overhead. A `run()`
 * escape hatch is available for arbitrary command strings.
 *
 * @example
 * ```typescript
 * const sdk = createSentrySDK({ token: "sntrys_..." });
 *
 * // Typed methods for every command
 * const orgs = await sdk.org.list();
 * const issues = await sdk.issue.list({ orgProject: "acme/frontend" });
 *
 * // Escape hatch for any CLI command
 * const version = await sdk.run("--version");
 * const text = await sdk.run("issue", "list", "-n", "5");
 * ```
 */
export function createSentrySDK(
  options?: import("./lib/sdk-types.js").SentryOptions,
) {
  const methods = createSDKMethods(buildInvoker(options));
  const run = buildRunner(options);
  return Object.assign(methods, { run });
}

/** The version of this `sentry` package (v3's static `SentryCli.getVersion()`). */
export function getVersion(): string {
  return CLI_VERSION;
}

/**
 * Absolute path to this package's `sentry` executable (v3's static
 * `SentryCli.getPath()`). It is a Node.js script: spawn it with
 * `process.execPath` on Windows, where it can't run on its own.
 */
export function getPath(): string {
  return fileURLToPath(new URL("./bin.cjs", import.meta.url));
}

// v3 exposed these as static methods on the class; keep that spelling working.
createSentrySDK.getVersion = getVersion;
createSentrySDK.getPath = getPath;

export default createSentrySDK;
