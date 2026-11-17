/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.eval.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    reporters: ["vitest-evals/reporter"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["**/*.ts"],
    },
    // Roach records model calls and replays them on later runs. See roach.json.
    // Its setup file loads before setup-env.ts starts MSW.
    globalSetup: ["@sentry/roach/vitest"],
    setupFiles: ["@sentry/roach/vitest/setup", "./src/setup-env.ts"],
  },
});
