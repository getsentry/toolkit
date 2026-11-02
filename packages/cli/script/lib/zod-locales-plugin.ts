/**
 * esbuild plugin that bundles only Zod's English error messages.
 *
 * Zod 4's `core`, `classic`, and `mini` entry points all re-export
 * `locales/index.js`, which statically imports every locale (about 260 KB
 * minified). Zod only uses English unless code calls
 * `z.config(z.locales.xx())`, and nothing we bundle does. This plugin swaps
 * that index for one that exports only `en`, so `z.locales.en` still works
 * and error messages are unchanged. `classic/schemas.js` imports `en.js`
 * directly to set the default locale, so that path is not touched.
 *
 * Shared by the CLI bundles (`script/bundle.ts`, `script/build.ts`), which
 * inline `@sentry/mcp-core` for `sentry mcp`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "esbuild";

const ZOD_LOCALES_NS = "zod-en-locales";
const LOCALES_INDEX_FILTER = /[\\/]locales[\\/]index\.c?js$/;
const ANY_FILTER = /.*/;
/** Matches a file inside an installed `zod` package (npm or pnpm layout). */
const ZOD_PACKAGE_RE = /[\\/]node_modules[\\/]zod[\\/]/;

export const zodEnglishLocalesPlugin: Plugin = {
  name: "zod-english-locales",
  setup(build) {
    build.onResolve({ filter: LOCALES_INDEX_FILTER }, (args) => {
      if (!ZOD_PACKAGE_RE.test(`${args.resolveDir}/`)) {
        return;
      }
      // `zod/locales/index.js` re-exports `../v4/locales/index.js`, so both
      // resolve here. Keep the importer's module format: `.cjs` for require.
      const indexPath = join(args.resolveDir, args.path);
      const enPath = join(
        dirname(indexPath),
        indexPath.endsWith(".cjs") ? "en.cjs" : "en.js",
      );
      if (!existsSync(enPath)) {
        // Fail loudly if Zod changes its layout, rather than shipping a
        // locales namespace without English.
        return {
          errors: [{ text: `Zod English locale not found at ${enPath}` }],
        };
      }
      return { path: enPath, namespace: ZOD_LOCALES_NS };
    });

    build.onLoad({ filter: ANY_FILTER, namespace: ZOD_LOCALES_NS }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(args.path)};`,
      resolveDir: dirname(args.path),
      loader: "js",
    }));
  },
};
