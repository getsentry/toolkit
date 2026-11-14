/**
 * Verify commands that can issue DELETE retain destructive-command safeguards.
 * Uses the same source analysis as schema discovery, including private/dynamic
 * raw requests that cannot be linked to a public API operation.
 */

import { analyzeCliSources } from "./lib/source-api-usage.js";
import { logger } from "../src/lib/logger.js";

const { operations, analysis } = await analyzeCliSources();
if (!operations.some(({ method }) => method === "DELETE")) {
  throw new Error(
    "API operation catalog contains no DELETE operations; regenerate the API schema before checking command safety.",
  );
}
const deleting = analysis.commands.filter(
  ({ file, name }) =>
    file.startsWith("src/commands/") &&
    analysis.exports.get(file)?.get(name)?.deletes,
);
const problems = deleting.filter(({ destructive }) => !destructive);

if (problems.length === 0) {
  logger.success(
    `All ${deleting.length} command export(s) that send a DELETE are marked destructive`,
  );
} else {
  logger.error(
    [
      `${problems.length} command(s) send a DELETE but are not marked destructive:\n`,
      ...problems.map(({ file, name }) => `  ${file}#${name}`),
      "\n  Build them with buildDeleteCommand, or pass `destructive: true` to buildCommand.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
