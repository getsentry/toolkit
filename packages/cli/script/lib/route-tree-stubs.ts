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
 */

import { mkdir, writeFile } from "node:fs/promises";

const STUBS = [
  ["src/generated/command-api.json", "{}\n"],
  ["src/generated/top-level-routes.json", "{}\n"],
  [
    "src/generated/skill-content.ts",
    "export const SKILL_FILES: ReadonlyMap<string, string> = new Map();\n",
  ],
] as const;

/** Write a stub for each route-tree input that does not exist yet. */
export async function writeRouteTreeStubs(): Promise<void> {
  await mkdir("src/generated", { recursive: true });
  await Promise.all(
    STUBS.map(async ([path, stub]) => {
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
