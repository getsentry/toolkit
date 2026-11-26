/**
 * Finds a custom Express server in a Remix app, so the wizard can import
 * the instrumentation file there.
 */

import { loadFile } from "magicast";
import { statSync } from "node:fs";

import { findFile } from "../../utils/ast-utils.js";

// Try to find the Express server implementation that contains `createRequestHandler` from `@remix-run/express`
export async function findCustomExpressServerImplementation() {
  const possiblePaths = [
    "server",
    "server/index",
    "app/server",
    "app/server/index",
  ];

  for (const filePath of possiblePaths) {
    const filename = findFile(filePath);

    if (!filename) {
      continue;
    }

    const fileStat = statSync(filename);

    if (!fileStat.isFile()) {
      continue;
    }

    const fileMod = await loadFile(filename);
    const createRequestHandlerImport = fileMod.imports.$items.find(
      (imp) =>
        imp.from === "@remix-run/express" &&
        imp.imported === "createRequestHandler",
    );

    if (createRequestHandlerImport) {
      return filename;
    }
  }

  return null;
}
