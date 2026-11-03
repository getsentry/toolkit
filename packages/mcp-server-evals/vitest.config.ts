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
    setupFiles: ["./src/setup-env.ts"],
  },
});
