import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const packageVersion =
  process.env.npm_package_version ??
  JSON.parse(readFileSync("./package.json", "utf-8")).version;

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["cjs", "esm"], // Build for commonJS and ESmodules
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  external: [
    // Sentry 11 exposes MCP instrumentation only from this server subpath.
    "@sentry/core/server",
    // Keep workspace dependencies external (don't bundle them)
    "@sentry/mcp-server-mocks",
  ],
  env: {
    DEFAULT_SENTRY_DSN:
      "https://d0805acebb937435abcb5958da99cdab@o1.ingest.us.sentry.io/4509062593708032",
    SENTRY_ENVIRONMENT: "stdio",
    SENTRY_RELEASE: packageVersion,
    npm_package_version: packageVersion,
  },
});
