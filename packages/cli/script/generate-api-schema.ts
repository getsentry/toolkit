/**
 * Generate the CLI discovery index from the installed SDK's operation catalog.
 *
 * Usage: tsx script/generate.ts schema
 * Outputs: src/generated/api-schema.json and src/generated/idempotent-operations.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operations } from "@sentry/api/operations";
import { selectIdempotentWrites } from "@sentry/api/client";
import { projectApiOperations } from "./lib/api-schema.js";
import { logger } from "../src/lib/logger.js";

const OUTPUT_PATH = "src/generated/api-schema.json";
const IDEMPOTENT_OUTPUT_PATH = "src/generated/idempotent-operations.json";

/** Write the endpoint index and the idempotent write operations. */
export async function emit(): Promise<void> {
  const endpoints = projectApiOperations(operations);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(endpoints, null, 2));

  logger.success(
    `Generated ${OUTPUT_PATH} (${endpoints.length} endpoints, ${Math.round(JSON.stringify(endpoints).length / 1024)}KB)`,
  );

  const idempotentOperations = selectIdempotentWrites(operations);

  await writeFile(
    IDEMPOTENT_OUTPUT_PATH,
    JSON.stringify(idempotentOperations, null, 2),
  );

  logger.success(
    `Generated ${IDEMPOTENT_OUTPUT_PATH} (${idempotentOperations.length} operations)`,
  );
}
