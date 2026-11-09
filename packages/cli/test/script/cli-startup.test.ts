/** Keep Sentry SDK dependencies out of the CLI's startup paths. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

const ANY_IMPORT = /.*/;

/** A route module path in `src/command-manifest.ts`. */
const ROUTE_MODULE_RE = /import\("\.\/([^"]+)"\)/g;
const TS_EXTENSION_RE = /\.js$/;

/**
 * Hostname and origin predicates and the logger are pure and have no startup
 * side effects.
 */
const PURE_SENTRY_IMPORTS = [
  "@sentry/logger",
  "@sentry/toolkit-core/sentry-host",
  "@sentry/toolkit-core/sentry-origin",
];

/**
 * Every package `sentry __complete` may load. It runs on each TAB press, so a
 * new one must be cheap to load: never `@sentry/node`, the API client, or
 * anything that boots the command tree.
 */
const COMPLETION_PACKAGES = new Set([
  ...PURE_SENTRY_IMPORTS,
  // `errors.ts` (exit codes)
  "@stricli/core",
  // `db/accounts.ts` account IDs
  "uuidv7",
]);

/**
 * Source modules `sentry __complete` loads before it prints anything. Raise it
 * only for a completer that needs the modules.
 */
const COMPLETION_MODULE_BUDGET = 50;

/**
 * Bundle what loading `entry` executes, failing on a package import
 * `isAllowed` rejects. Deferred imports do not execute when an entry point
 * loads, so they are left out.
 */
function bundleStartup(
  entry: string,
  isAllowed: (specifier: string) => boolean,
) {
  return build({
    entryPoints: [join(import.meta.dirname, "../../src", entry)],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "check-startup-imports",
        setup(builder) {
          builder.onResolve({ filter: ANY_IMPORT }, (args) => {
            if (args.kind === "dynamic-import") {
              return { path: args.path, external: true };
            }
            const isPackage = !(
              args.kind === "entry-point" ||
              args.path.startsWith(".") ||
              args.path.startsWith("node:")
            );
            if (isPackage && !isAllowed(args.path)) {
              return {
                errors: [
                  { text: `Eager import ${args.path} from ${args.importer}` },
                ],
              };
            }
            return;
          });
        },
      },
    ],
  });
}

test.each(["bin.ts", "cli.ts", "index.ts", "mcp-server.ts"])(
  "%s does not eagerly import the Sentry SDK",
  async (entry) => {
    // Traverse the pure predicates' source to catch future SDK imports.
    await expect(
      bundleStartup(
        entry,
        (specifier) =>
          !specifier.startsWith("@sentry/") ||
          PURE_SENTRY_IMPORTS.includes(specifier),
      ),
    ).resolves.toMatchObject({ errors: [] });
  },
);

test("the __complete fast path loads only light modules", async () => {
  const { metafile } = await bundleStartup("complete-bin.ts", (specifier) =>
    COMPLETION_PACKAGES.has(specifier),
  );
  const sourceModules = Object.keys(metafile.inputs).filter(
    (input) => !input.includes("node_modules"),
  );
  expect(sourceModules.length).toBeLessThanOrEqual(COMPLETION_MODULE_BUDGET);
});

test("the CLI's main script loads only builtins", async () => {
  // `dist/bin.cjs` and the standalone binary's main script run it before
  // every command, ahead of the CLI or completion chunk
  const { metafile } = await bundleStartup("chunk-main.ts", () => false);
  expect(Object.keys(metafile.inputs).sort()).toEqual([
    "src/chunk-main.ts",
    "src/lib/chunk-loader.ts",
    "src/lib/config-dir.ts",
  ]);
});

/** The modules of the top-level routes in `src/command-manifest.ts`. */
async function routeModules(): Promise<string[]> {
  const loaders = await readFile(
    join(import.meta.dirname, "../../src/command-manifest.ts"),
    "utf8",
  );
  return [...loaders.matchAll(ROUTE_MODULE_RE)].map(
    ([, module]) => `src/${module?.replace(TS_EXTENSION_RE, ".ts")}`,
  );
}

test.each([
  // `app-for-args.ts` loads only the route being run, so no route module of
  // `app.ts` (each one a `COMMAND_MANIFEST` loader) may load before it picks
  // one
  "app-for-args.ts",
  // The same for each SDK call
  "sdk-app.ts",
  // Importing the library loads no command at all, and no CLI runner
  "index.ts",
])("%s loads none of the commands", async (entry) => {
  const routes = await routeModules();
  const { metafile } = await bundleStartup(entry, () => true);
  const inputs = Object.keys(metafile.inputs);

  expect(routes.length).toBeGreaterThan(0);
  expect(inputs).not.toContain("src/app.ts");
  expect(inputs).not.toContain("src/cli.ts");
  expect(inputs.filter((input) => routes.includes(input))).toEqual([]);
});
