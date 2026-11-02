import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/code-mode/**/*.test.ts"], environment: "node" },
});
