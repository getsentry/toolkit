import { defineConfig, type UserConfig } from "tsdown";

// tsconfig.json checks this file with `isolatedDeclarations`, which needs an
// explicit type on the default export.
const config: UserConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  target: "node18",
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
