import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/prompt.ts"],
  format: ["cjs", "esm"],
  target: "node18",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
});
