/**
 * Generate the CLI discovery index from the installed SDK's operation catalog.
 *
 * Usage: pnpm ts script/generate.ts schema
 * Outputs: src/generated/api-schema.json, src/generated/idempotent-operations.json
 * and src/generated/project-scope-operations.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operations } from "@sentry/api/operations";
import { selectIdempotentWrites } from "@sentry/api/client";
import {
  projectApiOperations,
  selectProjectScopeOperations,
} from "./lib/api-schema.js";
import { logger } from "../src/lib/logger.js";

const OUTPUT_PATH = "src/generated/api-schema.json";
const IDEMPOTENT_OUTPUT_PATH = "src/generated/idempotent-operations.json";
const PROJECT_SCOPE_OUTPUT_PATH = "src/generated/project-scope-operations.json";

/**
 * Write the endpoint index, the idempotent write operations and the
 * operations' project scopes.
 */
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

  const projectScopeOperations = selectProjectScopeOperations(operations);

  await writeFile(
    PROJECT_SCOPE_OUTPUT_PATH,
    JSON.stringify(projectScopeOperations, null, 2),
  );

  if (projectScopeOperations.length === 0) {
    // Scoped sessions still work, but refuse every endpoint the catalog
    // would have covered.
    logger.warn(
      `${PROJECT_SCOPE_OUTPUT_PATH} is empty: this @sentry/api has no projectScope`,
    );
  } else {
    logger.success(
      `Generated ${PROJECT_SCOPE_OUTPUT_PATH} (${projectScopeOperations.length} operations)`,
    );
  }
}
