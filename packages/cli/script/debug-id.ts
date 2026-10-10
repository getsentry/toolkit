/**
 * Debug ID injection — re-exports from src/lib/sourcemap/debug-id.ts.
 *
 * Build scripts import from here for convenience. The actual
 * implementation lives in src/lib/sourcemap/ alongside the ZIP builder
 * and injection utilities.
 */
export {
  contentToDebugId,
  getDebugIdSnippet,
  injectDebugId,
} from "../src/lib/sourcemap/debug-id.js";

/**
 * Placeholder UUID used by esbuild's `define` for `__SENTRY_DEBUG_ID__`.
 *
 * After esbuild finishes and the real debug ID is computed from the
 * minified JS + sourcemap content hash, this placeholder is replaced in the
 * JS output via `String.replaceAll`. The placeholder is exactly 36 characters
 * (standard UUID length) so character positions in the sourcemap stay valid.
 */
export const PLACEHOLDER_DEBUG_ID = "deb00000-de60-4d00-a000-000000000000";
