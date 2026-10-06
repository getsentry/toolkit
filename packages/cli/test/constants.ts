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
 * Under `bun test --parallel`, each worker process gets its own subdir
 * keyed by `VITEST_POOL_ID` so workers don't wipe each other's
 * temp state during preload. Serial runs (no worker ID) use a plain
 * `sentry-cli-test` dir — same as before.
 *
 * Tests that create fixed-name subdirs under `TEST_TMP_DIR` (e.g.
 * `upgrade-lock-test`) still get a unique path per worker because the
 * parent is already worker-scoped.
 */
const WORKER_ID = process.env.VITEST_POOL_ID;
export const TEST_TMP_DIR = WORKER_ID
  ? join(tmpdir(), `sentry-cli-test-w${WORKER_ID}`)
  : join(tmpdir(), "sentry-cli-test");
