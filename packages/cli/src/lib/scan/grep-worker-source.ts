/**
 * Exports the grep-worker.js source code as a string.
 *
 * At dev/test time, reads the file from disk via `readFileSync`.
 * At build time, esbuild's `text-import-plugin` replaces this module
 * with a virtual module that inlines the file content as a string constant,
 * so the compiled binary doesn't need the file on disk.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GREP_WORKER_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "grep-worker.js"),
  "utf-8"
);

export default GREP_WORKER_SOURCE;
