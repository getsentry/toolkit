/**
 * Concurrent Database Access Tests
 *
 * Tests that multiple CLI processes can safely access the SQLite database
 * simultaneously without SQLITE_BUSY errors or data corruption.
 *
 * These tests spawn tsx subprocesses to simulate real concurrent
 * CLI usage (e.g., multiple terminals, CI jobs, editor integrations).
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

import { getCachedDsn } from "../../../src/lib/db/dsn-cache.js";
import {
  CONFIG_DIR_ENV_VAR,
  closeDatabase,
} from "../../../src/lib/db/index.js";
import { getCachedProject } from "../../../src/lib/db/project-cache.js";
import { useTestConfigDir } from "../../helpers.js";

const WORKER_SCRIPT = join(import.meta.dirname, "concurrent-worker.ts");

type WorkerResult = {
  workerId: string;
  operation: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

/**
 * Spawn a worker process and wait for its result.
 */
async function spawnWorker(
  configDir: string,
  workerId: string,
  operation: string
): Promise<WorkerResult> {
  const requireShim = join(
    import.meta.dirname,
    "../../../script/require-shim.mjs"
  );
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--import",
      requireShim,
      WORKER_SCRIPT,
      configDir,
      workerId,
      operation,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  proc.on("error", noop);

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d: Buffer) => {
    stdout += d;
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d;
  });

  const exitCode = await new Promise<number>((done) =>
    proc.on("close", (code) => done(code ?? 1))
  );

  if (exitCode !== 0) {
    return {
      workerId,
      operation,
      success: false,
      error: `Process exited with code ${exitCode}: ${stderr || stdout}`,
    };
  }

  try {
    return JSON.parse(stdout.trim());
  } catch {
    return {
      workerId,
      operation,
      success: false,
      error: `Failed to parse worker output: ${stdout}`,
    };
  }
}

/**
 * Spawn multiple workers concurrently and collect results.
 */
async function spawnWorkersConcurrently(
  configDir: string,
  workerCount: number,
  operation: string
): Promise<WorkerResult[]> {
  const promises: Promise<WorkerResult>[] = [];

  for (let i = 0; i < workerCount; i++) {
    promises.push(spawnWorker(configDir, String(i), operation));
  }

  return Promise.all(promises);
}

describe("concurrent database access", () => {
  const getConfigDir = useTestConfigDir("concurrent-");

  beforeEach(async () => {
    // Pre-create the database before spawning workers.
    // This ensures schema initialization completes before concurrent access,
    // which avoids lock contention during initial table creation.
    const { getDatabase } = await import("../../../src/lib/db/index.js");
    getDatabase();
    closeDatabase();
  });

  test("multiple processes can write DSN cache entries simultaneously", async () => {
    const workerCount = 5;
    const results = await spawnWorkersConcurrently(
      getConfigDir(),
      workerCount,
      "write-dsn"
    );

    // All workers should succeed
    expect(results.filter((r) => !r.success)).toHaveLength(0);

    // Verify all entries are present in the database
    closeDatabase(); // Close to re-open with fresh connection
    process.env[CONFIG_DIR_ENV_VAR] = getConfigDir();

    for (let i = 0; i < workerCount; i++) {
      const directory = `/test/project-${i}`;
      const cached = getCachedDsn(directory);
      expect(cached).toBeDefined();
      expect(cached?.dsn).toBe(`https://key${i}@sentry.io/123${i}`);
    }
  });

  test("multiple processes can write project cache entries simultaneously", async () => {
    const workerCount = 5;
    const results = await spawnWorkersConcurrently(
      getConfigDir(),
      workerCount,
      "write-project"
    );

    // All workers should succeed
    expect(results.filter((r) => !r.success)).toHaveLength(0);

    // Verify all entries are present
    closeDatabase();
    process.env[CONFIG_DIR_ENV_VAR] = getConfigDir();

    for (let i = 0; i < workerCount; i++) {
      const cached = getCachedProject("org-456", `proj-${i}`);
      expect(cached).toBeDefined();
      expect(cached?.projectSlug).toBe(`project-${i}`);
    }
  });

  test("mixed read/write operations from multiple processes succeed", async () => {
    const workerCount = 5;
    const results = await spawnWorkersConcurrently(
      getConfigDir(),
      workerCount,
      "read-write"
    );

    // All workers should succeed
    expect(results.filter((r) => !r.success)).toHaveLength(0);

    // Each worker did 5 iterations, verify some entries
    closeDatabase();
    process.env[CONFIG_DIR_ENV_VAR] = getConfigDir();

    for (let w = 0; w < workerCount; w++) {
      for (let i = 0; i < 5; i++) {
        const directory = `/test/worker-${w}-iter-${i}`;
        const cached = getCachedDsn(directory);
        expect(cached).toBeDefined();
        expect(cached?.dsn).toBe(`https://key${w}${i}@sentry.io/${w}${i}`);
      }
    }
  });

  test("handles contention without SQLITE_BUSY errors", async () => {
    // Run a larger batch to increase contention likelihood
    const workerCount = 10;
    const results = await spawnWorkersConcurrently(
      getConfigDir(),
      workerCount,
      "write-dsn"
    );

    // Check for SQLITE_BUSY errors specifically
    const busyErrors = results.filter(
      (r) => !r.success && r.error?.includes("SQLITE_BUSY")
    );
    expect(busyErrors).toHaveLength(0);

    // All should succeed thanks to WAL mode and busy_timeout
    const failures = results.filter((r) => !r.success);
    expect(failures).toHaveLength(0);
  });
});
