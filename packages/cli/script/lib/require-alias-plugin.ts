import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

/**
 * Files that use `_require()` for lazy imports. The `require-alias` plugin
 * rewrites `_require(` → `require(` in these so esbuild resolves them at
 * bundle time. `db/sqlite` is included so the WASM SQLite fallback
 * (`node-sqlite3-wasm`) is actually inlined into the npm bundle — otherwise
 * it stays a runtime `require()` that fails in a real install (the driver is
 * a devDependency, not shipped). `node:sqlite` in the same file stays a
 * builtin and is left external by esbuild regardless.
 * `formatters/json` loads its generated parser only when --fields is parsed.
 */
const REQUIRE_ALIAS_FILTER =
  /(?:db[\\/](?:index|schema|sqlite)|formatters[\\/]json|list-command|telemetry)\.ts$/;
const REQUIRE_ALIAS_RE = /\b_require\(/g;

/** Transform _require() → require() so esbuild resolves lazy relative requires. */
export const requireAliasPlugin: Plugin = {
  name: "require-alias",
  setup(b) {
    b.onLoad({ filter: REQUIRE_ALIAS_FILTER }, async (args) => {
      const source = await readFile(args.path, "utf-8");
      return {
        contents: source.replace(REQUIRE_ALIAS_RE, "require("),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};
