/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@sentry\/mcp-server-mocks\/payloads$/,
        replacement: path.resolve(
          __dirname,
          "../mcp-server-mocks/src/payloads.ts",
        ),
      },
      {
        find: /^@sentry\/mcp-server-mocks\/utils$/,
        replacement: path.resolve(
          __dirname,
          "../mcp-server-mocks/src/utils.ts",
        ),
      },
      {
        find: /^@sentry\/mcp-server-mocks$/,
        replacement: path.resolve(
          __dirname,
          "../mcp-server-mocks/src/index.ts",
        ),
      },
    ],
  },
  test: {
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["**/*.ts"],
    },
    setupFiles: [
      "dotenv/config",
      "src/test-setup.ts",
      "src/test-utils/structured-output-guard.ts",
    ],
  },
});
