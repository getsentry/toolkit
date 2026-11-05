/**
 * The Stub Contents of the Generated Files the Route Tree Imports
 *
 * `route-tree-stubs.ts` writes these before a script loads the tree. They
 * live in plain JavaScript so `ensure-generated.mjs`, which runs without
 * tsx, can tell a stub left behind by a tree-loading script, such as
 * `check-fragments`, from generated output, and regenerate it.
 */

/** @type {ReadonlyArray<readonly [path: string, stub: string]>} */
export const ROUTE_TREE_STUBS = [
  ["src/generated/command-api.json", "{}\n"],
  ["src/generated/top-level-routes.json", "{}\n"],
  [
    "src/generated/skill-content.ts",
    "export const SKILL_FILES: ReadonlyMap<string, string> = new Map();\n",
  ],
];
