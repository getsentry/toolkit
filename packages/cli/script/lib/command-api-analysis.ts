/**
 * Start the `command-api` Source Analysis in a Worker
 *
 * Finding the API operations each command reaches parses all of `src/` with
 * the TypeScript compiler. It is the slowest work in `generate` and needs
 * none of the route tree, so `script/generate.ts` starts it in a worker
 * thread (`command-api-analysis-worker.ts`) before it loads the tree, and
 * the two overlap. `generate-command-api.ts` then awaits the result and maps
 * it onto the tree.
 *
 * This module imports the analyzer only as a type, so starting the worker
 * does not load the compiler into the main thread.
 */

import { Worker } from "node:worker_threads";
import type { analyzeSourceApiUsage } from "./source-api-usage.js";

export type CommandApiAnalysis = ReturnType<typeof analyzeSourceApiUsage>;

let analysis: Promise<CommandApiAnalysis> | undefined;

/**
 * The source analysis, started in a worker on the first call. Reads
 * `src/generated/api-schema.json`, so call it after the schema step.
 */
export function commandApiAnalysis(): Promise<CommandApiAnalysis> {
  if (!analysis) {
    analysis = new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./command-api-analysis-worker.ts", import.meta.url),
      );
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        reject(new Error(`command-api analysis worker exited with ${code}`));
      });
    });
    // Started early and awaited later: a failure before then must not
    // count as unhandled. Whoever awaits it still sees the rejection.
    analysis.catch(() => undefined);
  }
  return analysis;
}
