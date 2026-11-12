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
    maxWorkers: 1,
  },
});
