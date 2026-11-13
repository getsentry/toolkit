/**
 * esbuild plugin for the `with { type: "text" }` import attribute (esbuild
 * only supports `json`): intercepts the import, reads the file, and
 * default-exports its contents as a string (e.g. the grep worker source).
 *
 * Used by `script/build.ts` (single-file executable) and
 * `script/bundle.ts` (CJS library bundle).
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Plugin } from "esbuild";

const TEXT_IMPORT_NS = "text-import";
const ANY_FILTER = /.*/;

const GREP_WORKER_SOURCE_RE = /grep-worker-source\.(js|ts)$/;

export const textImportPlugin: Plugin = {
  name: "text-import",
  setup(build) {
    // Intercept grep-worker-source.ts — replace with inlined grep-worker.js
    // content so the compiled binary doesn't need the file on disk.
    build.onResolve({ filter: GREP_WORKER_SOURCE_RE }, (args) => ({
      path: resolvePath(args.resolveDir, "grep-worker.js"),
      namespace: TEXT_IMPORT_NS,
    }));

    build.onResolve({ filter: ANY_FILTER }, (args) => {
      if (args.with.type === "text") {
        return {
          path: resolvePath(args.resolveDir, args.path),
          namespace: TEXT_IMPORT_NS,
        };
      }
      return null;
    });
    build.onLoad({ filter: ANY_FILTER, namespace: TEXT_IMPORT_NS }, (args) => {
      const content = readFileSync(args.path, "utf-8");
      return {
        contents: `export default ${JSON.stringify(content)};`,
        loader: "js",
      };
    });
  },
};
