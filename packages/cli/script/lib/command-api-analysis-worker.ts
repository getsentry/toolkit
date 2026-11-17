/**
 * Worker Thread for the `command-api` Source Analysis
 *
 * Started by `command-api-analysis.ts`. Loads the analyzer and reads every
 * source file at once, then waits for the main thread's message that the
 * API schema is written, reads it, analyzes which operations each export
 * reaches, and posts the result (plain objects and Maps) back.
 */

import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import { glob } from "tinyglobby";
import type { ApiEndpoint } from "../../src/lib/api-schema.js";
import { analyzeSourceApiUsage } from "./source-api-usage.js";

const files = await glob(["src/**/*.{ts,tsx}"], {
  ignore: ["src/generated/**"],
});
const sources = new Map(
  await Promise.all(
    files
      .sort()
      .map(async (file) => [file, await readFile(file, "utf8")] as const),
  ),
);
await new Promise((resolve) => parentPort?.once("message", resolve));
const endpoints = JSON.parse(
  await readFile("src/generated/api-schema.json", "utf8"),
) as ApiEndpoint[];

parentPort?.postMessage(
  analyzeSourceApiUsage(
    sources,
    endpoints
      .filter((entry) => entry.fn)
      .map((entry) => ({
        functionName: entry.fn,
        method: entry.method,
        path: entry.path,
      })),
  ),
);
