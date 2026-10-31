/**
 * Keep cli-highlight (all of highlight.js and parse5) behind
 * `formatters/highlight.ts`: lazy in the CLI bundle, and removable with
 * `__SENTRY_CLI_SYNTAX_HIGHLIGHT__ = false` for bundles like the MCP server.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Metafile } from "esbuild";
import { expect, test } from "vitest";

const HIGHLIGHT_MODULE_RE = /formatters[\\/]highlight\.ts$/;
const HIGHLIGHT_STACK_RE =
  /node_modules[\\/].*(?:cli-highlight|highlight\.js|parse5)/;

/** Bundle the markdown renderer the way script/bundle.ts does. */
async function bundleMarkdown(define: Record<string, string> = {}) {
  const { metafile } = await build({
    entryPoints: [
      join(import.meta.dirname, "../../src/lib/formatters/markdown.ts"),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    metafile: true,
    logLevel: "silent",
    define,
    plugins: [
      {
        // Mirrors the require-alias plugin in script/bundle.ts.
        name: "require-alias",
        setup(builder) {
          builder.onLoad({ filter: HIGHLIGHT_MODULE_RE }, async (args) => ({
            contents: (await readFile(args.path, "utf-8")).replace(
              /\b_require\(/g,
              "require(",
            ),
            loader: "ts",
          }));
        },
      },
    ],
  });
  return metafile;
}

function importsOf(metafile: Metafile, specifier: string) {
  return Object.values(metafile.inputs).flatMap((input) =>
    input.imports.filter((imp) => imp.original === specifier),
  );
}

test("cli-highlight is only reached through a lazy require", async () => {
  const metafile = await bundleMarkdown();
  const imports = importsOf(metafile, "cli-highlight");
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((imp) => imp.kind === "require-call")).toBe(true);
});

test("the build-time define drops highlight.js and parse5", async () => {
  const metafile = await bundleMarkdown({
    __SENTRY_CLI_SYNTAX_HIGHLIGHT__: "false",
  });
  const bundled = Object.keys(metafile.inputs);
  expect(bundled.filter((path) => HIGHLIGHT_STACK_RE.test(path))).toEqual([]);
});
