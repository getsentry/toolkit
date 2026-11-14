import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Rolldown's JSON loader stops at 128 levels of nesting, and the trace
// fixture's span tree is deeper. Load that fixture as a module that parses it
// at runtime instead.
const DEEP_JSON_FIXTURES = /[\\/]fixtures[\\/]trace\.json$/;

export default defineConfig({
  entry: ["src/**/*.ts"],
  // ESM only: the package is private and every export points at .js.
  format: ["esm"],
  // Package exports name `.js` and `.d.ts` files.
  fixedExtension: false,
  // `isolatedDeclarations` in tsconfig.json selects the Oxc declaration
  // emitter, which needs no TypeScript compiler API.
  dts: true,
  // The declarations type the exported fixtures with `typeof` imports of
  // their JSON files, so ship the JSON next to them.
  copy: { from: "src/fixtures/*.json", to: "dist/fixtures" },
  sourcemap: true,
  clean: true,
  plugins: [
    {
      // Keep JSON imports in the declarations as imports of the copied
      // files; the declaration emitter cannot parse JSON modules.
      name: "external-json-in-declarations",
      resolveId: {
        order: "pre",
        filter: { id: /\.json$/ },
        handler(source, importer) {
          if (importer?.endsWith(".d.ts")) {
            return { id: source, external: true };
          }
          return null;
        },
      },
    },
    {
      name: "deep-json-fixtures",
      load: {
        filter: { id: DEEP_JSON_FIXTURES },
        handler(id) {
          const text = readFileSync(id, "utf-8");
          return {
            code: `export default JSON.parse(${JSON.stringify(text)});`,
            moduleType: "js",
          };
        },
      },
    },
  ],
});
