/**
 * Entry point of `sentry __complete`, which shell completion runs on every
 * TAB press.
 *
 * `bin.ts` imports it for `__complete`. The npm package and the standalone
 * binary ship it as a separate bundle that `chunk-main.ts` runs, so a TAB
 * press never loads the rest of the CLI. Keep its imports to `lib/complete.ts` and what that loads
 * (see `test/script/cli-startup.test.ts`).
 */

// Must stay the first import: later imports can load node:sqlite.
import "./lib/suppress-sqlite-warning.js";
import { runCompletion } from "./lib/complete.js";
import { installStreamErrorHandlers } from "./lib/stream-errors.js";

installStreamErrorHandlers();

runCompletion(process.argv.slice(3)).catch(() => {
  // Completions should never crash — silently return no results
  process.exitCode = 0;
});
