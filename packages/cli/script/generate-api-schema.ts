#!/usr/bin/env tsx
/**
 * Generate the CLI discovery index from the installed SDK's operation catalog.
 *
 * Usage: tsx script/generate-api-schema.ts
 * Output: src/generated/api-schema.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operations } from "@sentry/api/operations";
import { projectApiOperations } from "./lib/api-schema.js";

const OUTPUT_PATH = "src/generated/api-schema.json";
const endpoints = projectApiOperations(operations);

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(endpoints, null, 2));

console.log(
  `Generated ${OUTPUT_PATH} (${endpoints.length} endpoints, ${Math.round(JSON.stringify(endpoints).length / 1024)}KB)`,
);
