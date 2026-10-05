import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const JS_EXT_RE = /\.js$/;

/**
 * Vite plugin to rewrite lazy `require("./relative/path.js")` calls in
 * `.ts` source files to the corresponding `.ts` path when the `.ts` file
 * exists on disk. Node.js `require()` bypasses Vite's resolve pipeline,
 * so `resolve.extensions` doesn't apply.
 */
function requireJsToTsPlugin(): Plugin {
  return {
    name: "require-js-to-ts",
    enforce: "pre",
    transform(code, id) {
      if (!(id.endsWith(".ts") && code.includes("require("))) {
        return;
      }
      let changed = false;
      const transformed = code.replace(
        /require\(["'](\.[\w/.]+)\.js["']\)/g,
        (match, relPath) => {
          const dir = dirname(id);
          const tsPath = join(dir, `${relPath}.ts`);
          if (existsSync(tsPath)) {
            changed = true;
            return `require(${JSON.stringify(tsPath)})`;
          }
          return match;
        }
      );
      if (changed) {
        return { code: transformed, map: null };
      }
      return;
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
  plugins: [requireJsToTsPlugin(), jsToTsResolvePlugin()],
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
    poolOptions: {
      forks: {
        execArgv: [],
        env: { UV_USE_IO_URING: "0" },
      },
    },
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
          "@sentry/node-core",
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
