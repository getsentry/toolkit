import { defineConfig, type UserConfig } from "tsdown";

// tsconfig.json checks this file with `isolatedDeclarations`, which needs an
// explicit type on the default export.
const config: UserConfig = defineConfig({
  // `codec` is its own entry: it imports `node:zlib`, and the main entry
  // stays portable to browsers and Workers without `nodejs_compat`.
  entry: ["src/index.ts", "src/codec.ts"],
  format: ["cjs", "esm"],
  target: "node22",
  platform: "node",
  // Keep the published `.js`/`.cjs` and `.d.ts`/`.d.cts` names.
  fixedExtension: false,
  // `isolatedDeclarations` in tsconfig.json selects the Oxc declaration
  // emitter, which needs no TypeScript compiler API.
  dts: true,
  sourcemap: true,
  clean: true,
});

export default config;
