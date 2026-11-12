import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const JS_EXT_RE = /\.js$/;

/**
 * Matches a lazy `require("./relative/path.js")` call, including a
 * `createRequire()` result such as `_require(...)`, possibly spanning lines
 * with a trailing comma. Group 2 is the path without its `.js` extension.
 */
const LAZY_RELATIVE_REQUIRE_RE =
  /(?<![\w$.])[\w$]*require\(\s*(["'])(\.\.?\/[^"'\n]+)\.js\1\s*,?\s*\)/g;

/**
 * Vite plugin to load lazy `require("./relative/path.js")` calls in `.ts`
 * source files through Vite's module graph.
 *
 * A `require()` goes straight to Node's native loader, which can't map the
 * required module's own `.js` imports to `.ts` files, and which would load a
 * second instance of the module that `vi.mock` and `vi.spyOn` never see.
 * Under test, each call becomes a namespace import of the `.ts` file (or the
 * `.js` file, for generated modules) added at the end of the file. Imports
 * are hoisted, so the module loads eagerly; the namespace binding is live,
 * so import cycles that the lazy require broke (`db/index.ts` and
 * `db/resilient.ts`) still resolve by the time the call runs. Line breaks
 * inside a replaced call are kept, so stack trace lines stay accurate.
 */
function lazyRequireToImportPlugin(): Plugin {
  return {
    name: "lazy-require-to-import",
    enforce: "pre",
    transform(code, id) {
      if (!(id.endsWith(".ts") && code.includes("require("))) {
        return;
      }
      const bindings = new Map<string, string>();
      const transformed = code.replace(
        LAZY_RELATIVE_REQUIRE_RE,
        (match, _quote: string, relPath: string) => {
          const target = [".ts", ".js"]
            .map((ext) => join(dirname(id), `${relPath}${ext}`))
            .find((path) => existsSync(path));
          if (!target) {
            return match;
          }
          let binding = bindings.get(target);
          if (!binding) {
            binding = `__vitestLazyRequire${bindings.size}`;
            bindings.set(target, binding);
          }
          // Parentheses keep the kept line breaks from ending the statement.
          return `(${binding}${"\n".repeat(match.split("\n").length - 1)})`;
        },
      );
      if (bindings.size === 0) {
        return;
      }
      const imports = [...bindings]
        .map(
          ([target, binding]) =>
            `import * as ${binding} from ${JSON.stringify(target)};`,
        )
        .join("\n");
      return { code: `${transformed}\n${imports}\n`, map: null };
    },
  };
}

/**
 * Vite plugin to resolve `.js` imports to `.ts` files.
 * The codebase uses ESM `.js` extensions in imports (TypeScript convention),
 * but the actual source files are `.ts`. Vite's SSR resolver sometimes
 * bypasses `resolve.extensions` — this plugin catches those cases.
 */
function jsToTsResolvePlugin(): Plugin {
  return {
    name: "js-to-ts-resolve",
    enforce: "pre",
    resolveId(source, importer) {
      if (!(importer && source.endsWith(".js"))) {
        return;
      }
      // Only handle relative imports from our source tree
      if (!source.startsWith(".")) {
        return;
      }
      const dir = dirname(importer);
      const tsPath = join(dir, source.replace(JS_EXT_RE, ".ts"));
      if (existsSync(tsPath)) {
        return tsPath;
      }
      return;
    },
  };
}

export default defineConfig({
  plugins: [lazyRequireToImportPlugin(), jsToTsResolvePlugin()],
  resolve: {
    // Allow .js imports to resolve to .ts files (ESM convention used throughout)
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    conditions: ["import", "module", "default"],
  },
  test: {
    setupFiles: ["./test/preload.ts"],
    testTimeout: 15_000,
    isolate: true,
    pool: "forks",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      reporter: ["lcov"],
    },
    server: {
      deps: {
        // Inline modules so vitest can intercept their exports with
        // vi.spyOn. Without inlining, ESM namespace objects are frozen
        // and spyOn throws "Cannot redefine property".
        inline: [
          "@sentry/node",
          "@sentry/core",
          "@clack/prompts",
          "node:child_process",
        ],
      },
    },
    // Use vi.mock() hoisting mode that intercepts all module bindings
    // (not just the test's namespace import) so vi.spyOn on a namespace
    // affects what the source module sees at call time.
    mockReset: false,
  },
});
