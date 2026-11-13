/**
 * ESM preload shim for running TypeScript from source.
 *
 * 1. Provides a global `require()` for ESM modules in `"type": "module"`
 *    packages. Anchored at the project root — works for `node:*` builtins
 *    and npm packages. Files that need relative `require()` must use a
 *    file-local `createRequire(import.meta.url)` instead.
 *
 * 2. Installs the workspace resolve hook (`scripts/strip-types-resolve.mjs`
 *    at the repository root), which maps the sources' `./foo.js` specifiers
 *    to `./foo.ts`. Node's type stripping does not rewrite them.
 *
 * Usage: `node --experimental-strip-types --import ./script/require-shim.mjs`,
 * or the `pnpm ts` alias in package.json scripts.
 */

import { createRequire } from "node:module";
import "../../../scripts/strip-types-resolve.mjs";

if (typeof globalThis.require === "undefined") {
  globalThis.require = createRequire(
    new URL("../package.json", import.meta.url),
  );
}
