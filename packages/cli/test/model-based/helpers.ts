/**
 * Model-Based Testing Helpers
 *
 * Shared utilities for fast-check model-based tests.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_ENV_VAR, closeDatabase } from "../../src/lib/db/index.js";

/**
 * Create an isolated database context for model-based tests.
 * Each test run gets its own SQLite database to avoid interference.
 *
 * @returns Cleanup function to call after test completes
 */
export function createIsolatedDbContext(): () => void {
  const testBaseDir = process.env[CONFIG_DIR_ENV_VAR];
  if (!testBaseDir) {
    throw new Error(`${CONFIG_DIR_ENV_VAR} not set - run tests via bun test`);
  }

  // Close any existing database connection
  closeDatabase();

  // Create unique subdirectory for this test run
  const testDir = join(
    testBaseDir,
    `model-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(testDir, { recursive: true });
  process.env[CONFIG_DIR_ENV_VAR] = testDir;

  return () => {
    closeDatabase();
    // Restore original base dir for next test
    process.env[CONFIG_DIR_ENV_VAR] = testBaseDir;
  };
}

/**
 * Default number of runs for property-based and model-based tests.
 * Balance between thoroughness and CI speed.
 */
export const DEFAULT_NUM_RUNS = 50;
