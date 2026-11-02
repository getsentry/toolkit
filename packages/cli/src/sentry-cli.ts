/**
 * The full `sentry` CLI: every command. Each run loads only the command it
 * runs where it can (see `app-for-args.ts`).
 *
 * Run by `bin.ts` (standalone binaries) and by `index.ts`'s `_cli` (the npm
 * package's `dist/bin.cjs`). Shell completion never gets here: both bins run
 * `lib/complete.ts` directly. The `@sentry/mcp-server` bundle runs a smaller
 * application instead (`mcp-server.ts`), so nothing there imports this file.
 */

import type { CliEntry } from "./cli.js";

export const SENTRY_CLI: CliEntry = {
  loadApp: async (args) => {
    const { loadAppForArgs } = await import("./app-for-args.js");
    return await loadAppForArgs(args);
  },
};
