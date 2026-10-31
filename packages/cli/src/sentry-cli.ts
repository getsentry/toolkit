/**
 * The full `sentry` CLI: every command.
 *
 * Run by `bin.ts` (standalone binaries) and by `index.ts`'s `_cli` (the npm
 * package's `dist/bin.cjs`). Shell completion never gets here: both bins run
 * `lib/complete.ts` directly. The `@sentry/mcp-server` bundle runs a smaller
 * application instead (`mcp-server.ts`), so nothing there imports this file.
 */

import type { CliEntry } from "./cli.js";

export const SENTRY_CLI: CliEntry = {
  loadApp: () => import("./app.js"),
};
