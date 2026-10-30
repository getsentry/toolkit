/**
 * The route registry: library modules read the command tree from whichever
 * entry point built the application, never from `app.ts` itself.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, test, vi } from "vitest";
import { buildCommand } from "../../src/lib/command.js";
import { extractCommandTree } from "../../src/lib/completions.js";
import { introspectAllCommands } from "../../src/lib/help.js";
import { interceptSubcommand } from "../../src/lib/list-command.js";
import { buildRouteMap } from "../../src/lib/route-map.js";
import { setRoutes } from "../../src/lib/route-registry.js";

const SRC = join(import.meta.dirname, "../../src");
const APP = join(SRC, "app.ts");
/** Library-mode runner: executes the full application, reached only from `src/index.ts`. */
const SDK_RUNNER = join(SRC, "lib/sdk-invoke.ts");

const ANY_IMPORT = /.*/;
const RELATIVE_IMPORT = /^\.\.?\//;
const JS_EXTENSION = /\.js$/;
const TS_SOURCE = /\.tsx?$/;
const LAZY_REQUIRE = /\b_require\(/g;

function command(brief: string) {
  return buildCommand({
    docs: { brief },
    auth: false,
    async *func() {
      yield;
    },
  });
}

/** A smaller CLI, like the one the MCP server build registers. */
function mcpServerRoutes() {
  return buildRouteMap({
    routes: {
      mcp: command("Run the MCP server"),
      auth: buildRouteMap({
        routes: { login: command("Log in"), whoami: command("Who am I") },
        docs: { brief: "Authenticate" },
      }),
      help: command("Help"),
    },
    defaultCommand: "mcp",
    docs: { brief: "Sentry MCP server" },
  });
}

describe("route registry", () => {
  test("reading routes before an entry point registers them fails clearly", async () => {
    vi.resetModules();
    const { getRoutes } = await import("../../src/lib/route-registry.js");
    expect(() => getRoutes()).toThrow("CLI routes are not registered");
  });

  test("help, completions, and subcommand hints read the registered map", () => {
    setRoutes(mcpServerRoutes());

    expect(extractCommandTree()).toEqual({
      groups: [
        {
          name: "auth",
          brief: "Authenticate",
          subcommands: [
            { name: "login", brief: "Log in" },
            { name: "whoami", brief: "Who am I" },
          ],
        },
      ],
      standalone: [
        { name: "mcp", brief: "Run the MCP server" },
        { name: "help", brief: "Help" },
      ],
    });
    expect(introspectAllCommands().routes.map((route) => route.name)).toEqual([
      "mcp",
      "auth",
      "help",
    ]);

    let hint = "";
    const stderr = { write: (s: string) => (hint += s) };
    expect(interceptSubcommand("login", stderr, "auth")).toBeUndefined();
    expect(hint).toContain("sentry auth login");
  });

  test("library modules never import app.ts", async () => {
    const files = await readdir(join(SRC, "lib"), { recursive: true });
    const entryPoints = files
      .filter((file) => TS_SOURCE.test(file))
      .map((file) => join(SRC, "lib", file))
      .filter((file) => file !== SDK_RUNNER);

    await expect(
      build({
        entryPoints,
        bundle: true,
        write: false,
        outdir: "out",
        splitting: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        plugins: [
          {
            name: "check-app-imports",
            setup(builder) {
              builder.onResolve({ filter: ANY_IMPORT }, (args) => {
                if (args.kind === "entry-point") {
                  return;
                }
                // Only our own modules matter; `with { type }` imports are assets.
                if (!RELATIVE_IMPORT.test(args.path) || args.with.type) {
                  return { path: args.path, external: true };
                }
                const target = resolve(args.resolveDir, args.path).replace(
                  JS_EXTENSION,
                  ".ts",
                );
                if (target === APP) {
                  return {
                    errors: [
                      {
                        text: `${relative(SRC, args.importer)} imports app.ts; read routes from lib/route-registry.ts instead`,
                      },
                    ],
                  };
                }
                return;
              });
              // Follow lazy `_require()` loads too, as the bundle scripts do.
              builder.onLoad({ filter: TS_SOURCE }, async (args) => ({
                contents: (await readFile(args.path, "utf-8")).replace(
                  LAZY_REQUIRE,
                  "require(",
                ),
                loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
              }));
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ errors: [] });
  });
});
