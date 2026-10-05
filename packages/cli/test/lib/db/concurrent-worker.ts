#!/usr/bin/env tsx
/**
 * Worker script for concurrent database access tests.
 * Spawned by concurrent.test.ts to simulate multiple CLI instances.
 *
 * Usage: tsx test/lib/db/concurrent-worker.ts <config-dir> <worker-id> <operation>
 *
 * Operations:
 *   write-dsn     - Write a unique DSN cache entry
 *   write-project - Write a unique project cache entry
 *   read-write    - Mixed read/write operations
 */

import { mkdirSync } from "node:fs";

// Set config dir from CLI arg before importing db modules
const configDir = process.argv[2];
const workerId = process.argv[3];
const operation = process.argv[4];

if (!(configDir && workerId && operation)) {
  console.error(
    "Usage: tsx concurrent-worker.ts <config-dir> <worker-id> <operation>"
  );
  process.exit(1);
}

// Ensure config dir exists
mkdirSync(configDir, { recursive: true });

// Set env var before importing db modules
process.env.SENTRY_CONFIG_DIR = configDir;

// Now import db modules (they'll use the env var)
const { setCachedDsn, getCachedDsn } = await import(
  "../../../src/lib/db/dsn-cache.js"
);
const { setCachedProject, getCachedProject } = await import(
  "../../../src/lib/db/project-cache.js"
);
const { closeDatabase } = await import("../../../src/lib/db/index.js");

type WorkerResult = {
  workerId: string;
  operation: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

async function writeDsn(): Promise<WorkerResult> {
  const directory = `/test/project-${workerId}`;
  const dsn = `https://key${workerId}@sentry.io/123${workerId}`;

  setCachedDsn(directory, {
    dsn,
    projectId: `123${workerId}`,
    orgId: "456",
    source: "env-file",
  });

  // Verify write
  const cached = getCachedDsn(directory);
  if (cached?.dsn !== dsn) {
    return {
      workerId,
      operation: "write-dsn",
      success: false,
      error: `Verification failed: expected ${dsn}, got ${cached?.dsn}`,
    };
  }

  return {
    workerId,
    operation: "write-dsn",
    success: true,
    data: { directory, dsn },
  };
}

async function writeProject(): Promise<WorkerResult> {
  const orgId = "org-456";
  const projectId = `proj-${workerId}`;

  setCachedProject(orgId, projectId, {
    orgSlug: "test-org",
    orgName: "Test Org",
    projectSlug: `project-${workerId}`,
    projectName: `Project ${workerId}`,
  });

  // Verify write
  const cached = getCachedProject(orgId, projectId);
  if (cached?.projectSlug !== `project-${workerId}`) {
    return {
      workerId,
      operation: "write-project",
      success: false,
      error: `Verification failed: expected project-${workerId}, got ${cached?.projectSlug}`,
    };
  }

  return {
    workerId,
    operation: "write-project",
    success: true,
    data: { orgId, projectId },
  };
}

async function readWrite(): Promise<WorkerResult> {
  // Mixed operations: write DSN, read it back, write project, read it back
  const iterations = 5;
  const results: string[] = [];

  for (let i = 0; i < iterations; i++) {
    const directory = `/test/worker-${workerId}-iter-${i}`;
    const dsn = `https://key${workerId}${i}@sentry.io/${workerId}${i}`;

    setCachedDsn(directory, {
      dsn,
      projectId: `${workerId}${i}`,
      source: "env-file",
    });

    const cached = getCachedDsn(directory);
    if (cached?.dsn !== dsn) {
      return {
        workerId,
        operation: "read-write",
        success: false,
        error: `Iteration ${i}: expected ${dsn}, got ${cached?.dsn}`,
      };
    }

    results.push(`iter-${i}-ok`);
  }

  return {
    workerId,
    operation: "read-write",
    success: true,
    data: { iterations, results },
  };
}

async function main(): Promise<void> {
  let result: WorkerResult;

  try {
    switch (operation) {
      case "write-dsn":
        result = await writeDsn();
        break;
      case "write-project":
        result = await writeProject();
        break;
      case "read-write":
        result = await readWrite();
        break;
      default:
        result = {
          workerId,
          operation,
          success: false,
          error: `Unknown operation: ${operation}`,
        };
    }
  } catch (error) {
    result = {
      workerId,
      operation,
      success: false,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  } finally {
    closeDatabase();
  }

  // Output result as JSON for parent process to parse
  console.log(JSON.stringify(result));
}

main();
