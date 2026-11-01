import { defineConfig } from "vitest/config";

// This experiment has its own Worker entrypoint and uses real Dynamic Workers.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/code-mode/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
