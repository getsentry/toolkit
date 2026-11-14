import { defineConfig } from "tsdown";

export default defineConfig({
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
