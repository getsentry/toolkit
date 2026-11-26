/**
 * Resolve hook for running the workspace's TypeScript sources with Node's
 * type stripping (`node --experimental-strip-types`).
 *
 * The sources use bundler-style specifiers that Node does not resolve on its
 * own: `./foo.js` for `./foo.ts`, and in some packages `./foo` for
 * `./foo.ts` and `./dir` for `./dir/index.ts`. When Node cannot find a
 * relative specifier, this hook tries those TypeScript files instead.
 *
 * `registerHooks()` is synchronous and covers both `import` and `require()`.
 * It needs Node.js 22.15+.
 *
 * Usage: `node --experimental-strip-types --import <repo>/scripts/strip-types-resolve.mjs file.ts`.
 * The CLI loads it through `packages/cli/script/require-shim.mjs`.
 */

import { registerHooks } from "node:module";

const RELATIVE_RE = /^(?:\.{1,2}\/|\/|file:)/;
const HAS_EXTENSION_RE = /\.(?:[cm]?[jt]sx?|json|node|wasm)$/;
/** `import` throws the first two codes, `require()` the last. */
const NOT_FOUND_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "MODULE_NOT_FOUND",
]);

/** TypeScript files to try, in order, for a relative specifier Node missed. */
function typeScriptCandidates(specifier) {
  if (specifier.endsWith(".js")) {
    return [`${specifier.slice(0, -3)}.ts`];
  }
  if (HAS_EXTENSION_RE.test(specifier)) {
    return [];
  }
  return [`${specifier}.ts`, `${specifier}/index.ts`];
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!NOT_FOUND_CODES.has(error?.code) || !RELATIVE_RE.test(specifier)) {
        throw error;
      }
      for (const candidate of typeScriptCandidates(specifier)) {
        try {
          return nextResolve(candidate, context);
        } catch (candidateError) {
          if (!NOT_FOUND_CODES.has(candidateError?.code)) {
            throw candidateError;
          }
        }
      }
      throw error;
    }
  },
});
