import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { createMockOutboundService } from "./src/test-utils/configure-fetch-mock";

/**
 * Unified vitest config using the Cloudflare Vitest plugin.
 *
 * All tests run in the Cloudflare Workers runtime (workerd) which enables:
 * - Testing with cloudflare:test bindings (KV, AI, etc.)
 * - Using centrally registered outbound HTTP fixtures
 *
 * Bindings (KV, vars, compatibility flags) are defined in wrangler.test.jsonc
 * to keep test config aligned with production wrangler.jsonc.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/server/index.ts",
      miniflare: {
        outboundService: createMockOutboundService(),
      },
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
  },
  /**
   * Workaround for ajv CJS compatibility in workerd runtime.
   *
   * The legacy MCP SDK imports ajv at module level even though hosted requests use
   * the v2 SDK's workerd-compatible default validator. ajv uses CJS require() for
   * JSON files which fails in workerd.
   * See: https://github.com/cloudflare/workers-sdk/issues/9822
   *
   * This is TEST-ONLY: hosted MCP requests do not invoke ajv, but importing the
   * legacy SDK still triggers the CJS issue.
   */
  resolve: {
    alias: {
      ajv: path.resolve(__dirname, "src/test-utils/ajv-stub.ts"),
      "ajv-formats": path.resolve(__dirname, "src/test-utils/ajv-stub.ts"),
    },
  },
  // Force bundling to apply the ajv alias during module resolution
  ssr: {
    noExternal: ["@modelcontextprotocol/sdk", "agents"],
  },
});
