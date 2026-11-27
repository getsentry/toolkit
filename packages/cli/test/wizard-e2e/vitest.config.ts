/**
 * Vitest config of the `sentry wizard` e2e tests (`pnpm run test:wizard-e2e`).
 *
 * They install npm packages and build real framework apps, so they stay out
 * of `test:unit` and `test:e2e` and run in `wizard-e2e.yml`, one test file
 * per job. Files run one at a time: the apps' dev and prod servers use fixed
 * ports.
 */

import { join } from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "../../vitest.config.js";

// Keep the base config's resolver plugins, but none of its test settings:
// its preload stubs fetch and the config directory for in-process tests, and
// these tests only spawn processes.
const { test: _baseTest, ...sharedConfig } = baseConfig;

export default defineConfig({
  ...sharedConfig,
  root: join(import.meta.dirname, "../.."),
  test: {
    include: ["test/wizard-e2e/**/*.test.ts"],
    globalSetup: ["test/wizard-e2e/global-setup.ts"],
    // A `beforeAll` runs a whole scripted wizard run, whose step timeouts
    // (up to 5 minutes for a package install) add up, so leave room for all
    // of them within the 20-minute CI job.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
