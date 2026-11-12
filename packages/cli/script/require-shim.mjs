/**
 * ESM preload shim for running TypeScript from source.
 *
 * 1. Provides a global `require()` for ESM modules in `"type": "module"`
 *    packages. Anchored at the project root — works for `node:*` builtins
 *    and npm packages. Files that need relative `require()` must use a
 *    file-local `createRequire(import.meta.url)` instead.
 *
 * 2. Resolves `./foo.js` specifiers to `./foo.ts` when only the TypeScript
 *    file exists. The sources import TypeScript modules by their emitted
 *    `.js` names (`moduleResolution: "bundler"`), which Node's type
 *    stripping (`pnpm run cli`, `pnpm run dev`) does not rewrite. Under
 *    `pnpm tsx`, tsx resolves them itself and the fallback never fires.
 *
 * Usage: `node --experimental-strip-types --import ./script/require-shim.mjs`,
 * or the `pnpm tsx` alias in package.json scripts.
 */

import { createRequire, registerHooks } from "node:module";

if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(
    new URL("../package.json", import.meta.url),
  );
}

const RELATIVE_JS_RE = /^(?:\.{1,2}\/|\/|file:).*\.js$/;
/** `import` throws the first code, `require()` the second. */
const NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

// registerHooks() is synchronous and covers both import and require(), so
// lazy `createRequire(import.meta.url)("./x.js")` calls resolve the same way.
// It is available from Node 22.15+ (our minimum).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !NOT_FOUND_CODES.has(error?.code) ||
        !RELATIVE_JS_RE.test(specifier)
      ) {
        throw error;
      }
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
