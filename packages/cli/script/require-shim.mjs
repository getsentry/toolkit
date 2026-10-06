/**
 * ESM preload shim for tsx dev mode.
 *
 * 1. Provides a global `require()` for ESM modules in `"type": "module"`
 *    packages. Anchored at the project root — works for `node:*` builtins
 *    and npm packages. Files that need relative `require()` must use a
 *    file-local `createRequire(import.meta.url)` instead.
 *
 * 2. Handles `with { type: "file" }` import attributes that Node.js doesn't
 *    support natively. Registers a loader hook that returns the file path
 *    as a string — matching Bun's native behaviour.
 *
 * Usage: NODE_OPTIONS="--import ./script/require-shim.mjs" tsx script/...
 * Or in package.json scripts via the `pnpm tsx` alias.
 */

import { createRequire, registerHooks } from "node:module";

if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(
    new URL("../package.json", import.meta.url)
  );
}

// Handle `with { type: "file" }` import attributes in Node.js dev mode.
// Bun supports this natively; esbuild's text-import-plugin handles it at
// build time. In tsx dev mode neither applies, so we register a synchronous
// hook that returns the file path as a string — matching Bun's behaviour.
// registerHooks() is available from Node 22.15+ (our minimum).
registerHooks({
  load(url, context, nextLoad) {
    if (context.importAttributes?.type === "file") {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(new URL(url).pathname)};`,
      };
    }
    return nextLoad(url, context);
  },
});
