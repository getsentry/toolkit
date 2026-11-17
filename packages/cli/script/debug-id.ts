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
