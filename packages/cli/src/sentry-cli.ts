/**
 * The full `sentry` CLI: every command, plus shell completion.
 *
 * Run by `bin.ts` (standalone binaries) and by `index.ts`'s `_cli` (the npm
 * package's `dist/bin.cjs`). The `@sentry/mcp-server` bundle runs a smaller
 * application instead (`mcp-server.ts`), so nothing there imports this file.
 */

import type { CliEntry } from "./cli.js";
import { getEnv } from "./lib/env.js";

export const SENTRY_CLI: CliEntry = {
  loadApp: () => import("./app.js"),
  /**
   * Fast-path: shell completion.
   *
   * Dispatched before importing the full CLI to avoid loading @sentry/node,
   * @stricli/core, and other heavy dependencies. Only loads the lightweight
   * completion engine and SQLite cache modules.
   */
  async complete(completionArgs) {
    // Disable telemetry so db/index.ts skips the @sentry/node lazy-require (~100ms)
    getEnv().SENTRY_CLI_NO_TELEMETRY = "1";
    const { handleComplete } = await import("./lib/complete.js");
    await handleComplete(completionArgs);
  },
};
