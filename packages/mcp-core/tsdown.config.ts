import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

function readPackageVersion(): string {
  const packageJson: unknown = JSON.parse(
    readFileSync("./package.json", "utf-8"),
  );
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error("package.json has no version");
  }
  return packageJson.version;
}

const packageVersion =
  process.env["npm_package_version"] ?? readPackageVersion();

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  // ESM only: the package is private and every export points at .js.
  format: ["esm"],
  // Package exports name `.js` and `.d.ts` files.
  fixedExtension: false,
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      // Sentry 11 exposes MCP instrumentation only from this server subpath.
      "@sentry/core/server",
      // Keep workspace dependencies external (don't bundle them)
      "@sentry/mcp-server-mocks",
    ],
  },
  env: {
    SENTRY_ENVIRONMENT: "stdio",
    SENTRY_RELEASE: packageVersion,
    npm_package_version: packageVersion,
  },
});
