#!/usr/bin/env tsx
/**
 * Generate `command-catalog.json` (`src/lib/command-catalog.ts`) for the MCP
 * servers, which read it instead of building schemas at runtime. It is
 * written to mcp-core, where mcp-cloudflare can import it, and committed, so
 * `--check` fails when it is stale.
 *
 * Usage:
 *   tsx script/generate-command-catalog.ts           # Write the catalog
 *   tsx script/generate-command-catalog.ts --check   # Exit 1 if it is stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { routes } from "../src/app.js";
import { extractCommandCatalog } from "../src/lib/command-catalog.js";
import type { RouteMap } from "../src/lib/introspect.js";

const COMMAND_CATALOG_PATH = "../mcp-core/src/command-catalog.json";

const catalog = extractCommandCatalog(routes as unknown as RouteMap);
const content = `${JSON.stringify(catalog, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(COMMAND_CATALOG_PATH, "utf8").catch(() => "");
  if (current !== content) {
    console.error(
      `✗ ${COMMAND_CATALOG_PATH} is stale. Run \`pnpm run generate:command-catalog\` in packages/cli and commit the result.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `✓ ${COMMAND_CATALOG_PATH} is up to date (${catalog.commands.length} commands)`,
    );
  }
} else {
  await writeFile(COMMAND_CATALOG_PATH, content);
  console.log(
    `Generated ${COMMAND_CATALOG_PATH} (${catalog.commands.length} commands)`,
  );
}
