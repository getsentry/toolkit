/**
 * Shared test constants.
 *
 * This file must have NO imports from src/ so that preload.ts can
 * safely import it before the test environment is fully initialized.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Namespaced subdirectory under the OS temp dir for all test artifacts.
 *
 * Vitest recycles pool IDs, including across separate runner invocations.
 * Include the process ID so preload cleanup cannot delete another fork's
 * database or fixtures. Serial scripts without a worker ID retain the
 * `sentry-cli-test` directory.
 *
 * Tests that create fixed-name subdirs under `TEST_TMP_DIR` (e.g.
 * `upgrade-lock-test`) still get a unique path per worker because the
 * parent is already worker-scoped.
 */
const WORKER_ID = process.env.VITEST_POOL_ID;
export const TEST_TMP_DIR = WORKER_ID
  ? join(tmpdir(), `sentry-cli-test-w${WORKER_ID}-p${process.pid}`)
  : join(tmpdir(), "sentry-cli-test");
