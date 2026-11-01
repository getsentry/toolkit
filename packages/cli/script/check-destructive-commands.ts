#!/usr/bin/env tsx
/**
 * Verify commands that can issue DELETE retain destructive-command safeguards.
 * Uses the same source analysis as schema discovery, including private/dynamic
 * raw requests that cannot be linked to a public API operation.
 */

import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";
import { getAllEndpoints } from "../src/lib/api-schema.js";
import { analyzeSourceApiUsage } from "./lib/source-api-usage.js";

const files = await glob("src/**/*.{ts,tsx}", {
  ignore: ["src/generated/**", "**/*.test.ts"],
});
const sources = new Map(
  await Promise.all(
    files.map(async (file) => [file, await readFile(file, "utf-8")] as const),
  ),
);
const operations = getAllEndpoints().flatMap((endpoint) =>
  endpoint.fn
    ? [
        {
          functionName: endpoint.fn,
          method: endpoint.method,
          path: endpoint.path,
        },
      ]
    : [],
);
if (!operations.some(({ method }) => method === "DELETE")) {
  throw new Error(
    "API operation catalog contains no DELETE operations; regenerate the API schema before checking command safety.",
  );
}
const analysis = analyzeSourceApiUsage(sources, operations);
const deleting = analysis.commands.filter(
  ({ file, name }) =>
    file.startsWith("src/commands/") &&
    analysis.exports.get(file)?.get(name)?.deletes,
);
const problems = deleting.filter(({ destructive }) => !destructive);

if (problems.length === 0) {
  console.log(
    `✓ All ${deleting.length} command export(s) that send a DELETE are marked destructive`,
  );
} else {
  console.error(
    `✗ ${problems.length} command(s) send a DELETE but are not marked destructive:\n`,
  );
  for (const { file, name } of problems) console.error(`  ${file}#${name}`);
  console.error(
    "\n  Build them with buildDeleteCommand, or pass `destructive: true` to buildCommand.",
  );
  process.exitCode = 1;
}
