import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

const packageVersion =
  process.env.npm_package_version ??
  JSON.parse(readFileSync("./package.json", "utf-8")).version;

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // `bin` and `test-client` run `dist/index.js`.
  fixedExtension: false,
  // A CLI entry point; no declarations, even though the shared tsconfig
  // enables `declaration`.
  dts: false,
  platform: "node",
  minify: false,
  shims: true,
  env: {
    DEFAULT_SENTRY_DSN:
      "https://d0805acebb937435abcb5958da99cdab@o1.ingest.us.sentry.io/4509062593708032",
    SENTRY_ENVIRONMENT: "mcp-test-client",
    SENTRY_RELEASE: packageVersion,
    npm_package_version: packageVersion,
  },
});
