#!/usr/bin/env tsx
/**
 * Generate the CLI discovery index from the installed SDK's operation catalog.
 *
 * Usage: tsx script/generate-api-schema.ts
 * Outputs: src/generated/api-schema.json and src/generated/idempotent-operations.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operations } from "@sentry/api/operations";
import { isIdempotentRequest } from "@sentry/toolkit-core/api-retry";
import type { IdempotentOperation } from "../src/lib/idempotent-operations.js";
import { projectApiOperations } from "./lib/api-schema.js";

const OUTPUT_PATH = "src/generated/api-schema.json";
const IDEMPOTENT_OUTPUT_PATH = "src/generated/idempotent-operations.json";
const endpoints = projectApiOperations(operations);

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(endpoints, null, 2));

console.log(
  `Generated ${OUTPUT_PATH} (${endpoints.length} endpoints, ${Math.round(JSON.stringify(endpoints).length / 1024)}KB)`,
);

// Safe methods already retry, so only writes need listing; that keeps the
// file the CLI loads on every request tiny.
const idempotentOperations: IdempotentOperation[] = operations
  .filter((op) => op.idempotent && !isIdempotentRequest(op.method))
  .map((op) => ({ method: op.method, path: op.path }))
  .sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

await writeFile(
  IDEMPOTENT_OUTPUT_PATH,
  JSON.stringify(idempotentOperations, null, 2),
);

console.log(
  `Generated ${IDEMPOTENT_OUTPUT_PATH} (${idempotentOperations.length} operations)`,
);
