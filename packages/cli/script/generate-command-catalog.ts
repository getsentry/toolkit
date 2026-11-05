/**
 * Generate `command-catalog.json` (`src/lib/command-catalog.ts`) for the MCP
 * servers, which read it instead of building schemas at runtime. It is
 * written to mcp-core, where mcp-cloudflare can import it, and committed, so
 * `--check` fails when it is stale.
 *
 * It runs after `command-api` in `script/generate.ts`, so it reads that
 * step's output from disk: the route tree's own imports of those files were
 * stubs or the previous run's when the tree loaded.
 */

import { readFile, writeFile } from "node:fs/promises";
import { routes } from "../src/app.js";
import type { ApiReference } from "../src/lib/api-schema.js";
import type { ApiAccess } from "../src/lib/command-access.js";
import { extractCommandCatalog } from "../src/lib/command-catalog.js";
import type { RouteMap } from "../src/lib/introspect.js";

const COMMAND_CATALOG_PATH = "../mcp-core/src/command-catalog.json";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Write the catalog, or with `check`, exit 1 when the committed one is stale. */
export async function emit({ check }: { check: boolean }): Promise<void> {
  const catalog = extractCommandCatalog(
    routes as unknown as RouteMap,
    await readJson<Record<string, ApiReference[]>>(
      "src/generated/command-api.json",
    ),
    await readJson<Record<string, ApiAccess>>(
      "src/generated/command-api-access.json",
    ),
  );
  const content = `${JSON.stringify(catalog, null, 2)}\n`;

  if (check) {
    const current = await readFile(COMMAND_CATALOG_PATH, "utf8").catch(
      () => "",
    );
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
    return;
  }
  await writeFile(COMMAND_CATALOG_PATH, content);
  console.log(
    `Generated ${COMMAND_CATALOG_PATH} (${catalog.commands.length} commands)`,
  );
}
