/**
 * Stubs for the Generated Files the Route Tree Imports
 *
 * `src/app.ts` imports these files, and the generators that read the route
 * tree are what write them, so a fresh checkout has none of them when the
 * tree first loads. No generator reads them back through the tree, so a stub
 * that resolves is enough; the generator that owns each file replaces it
 * later in the same `script/generate.ts` run.
 *
 * Scripts that load the route tree call {@link writeRouteTreeStubs} before
 * the first `import("../src/app.js")`. Static imports run before any code,
 * so the tree has to be loaded with a dynamic import after this.
 *
 * A script that only checks the tree, such as `check-fragments`, leaves its
 * stubs behind. `ensure-generated.mjs` treats a file that still holds its
 * stub (`route-tree-stub-files.mjs`) as missing, so the CLI never runs on
 * one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { ROUTE_TREE_STUBS } from "./route-tree-stub-files.mjs";

/** Write a stub for each route-tree input that does not exist yet. */
export async function writeRouteTreeStubs(): Promise<void> {
  await mkdir("src/generated", { recursive: true });
  await Promise.all(
    ROUTE_TREE_STUBS.map(async ([path, stub]) => {
      try {
        // `wx` fails with EEXIST rather than replace a generated file.
        await writeFile(path, stub, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }),
  );
}
