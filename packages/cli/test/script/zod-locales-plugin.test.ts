/**
 * Tests for the esbuild plugin that bundles only Zod's English locale.
 *
 * Builds a small entry against the real `zod` package (resolved from
 * `@sentry/mcp-core`, which depends on it) with and without the plugin, then
 * runs both bundles and compares their error messages.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { zodEnglishLocalesPlugin } from "../../script/lib/zod-locales-plugin.js";

const MCP_CORE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../mcp-core",
);

/** `import` resolves Zod's ESM build and `require` its CJS build. */
const IMPORTS = {
  esm: `import { z } from "zod";`,
  cjs: `const { z } = require("zod");`,
};

const BODY = `
const issues = [
  z.string().safeParse(1),
  z.object({ n: z.number().min(5) }).safeParse({ n: 1 }),
  z.enum(["a", "b"]).safeParse("c"),
].flatMap((r) => r.error.issues.map((i) => i.message));
module.exports = { issues, locales: Object.keys(z.locales) };
`;

type BundleResult = {
  bytes: number;
  issues: string[];
  locales: string[];
};

async function bundleZod(
  format: "cjs" | "esm",
  withPlugin: boolean,
): Promise<BundleResult> {
  const result = await build({
    stdin: {
      contents: IMPORTS[format] + BODY,
      resolveDir: MCP_CORE_DIR,
      loader: "js",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: withPlugin ? [zodEnglishLocalesPlugin] : [],
  });
  const code = result.outputFiles[0]?.text ?? "";
  const sandbox = {
    module: { exports: {} },
    require: createRequire(import.meta.url),
  };
  runInNewContext(code, sandbox);
  const { issues, locales } = sandbox.module.exports as Omit<
    BundleResult,
    "bytes"
  >;
  return { bytes: code.length, issues, locales };
}

describe("zodEnglishLocalesPlugin", () => {
  test.each(["esm", "cjs"] as const)(
    "keeps English messages and drops other locales (%s)",
    async (format) => {
      const full = await bundleZod(format, false);
      const english = await bundleZod(format, true);

      expect(english.issues).toEqual(full.issues);
      expect(english.issues[0]).toBe(
        "Invalid input: expected string, received number",
      );
      expect(full.locales).toContain("fr");
      expect(english.locales).toEqual(["en"]);
      // All other locales together are well over 100 KB unminified.
      expect(full.bytes - english.bytes).toBeGreaterThan(100_000);
    },
  );

  test("leaves non-Zod locales/index.js imports alone", async () => {
    const result = await build({
      stdin: {
        contents: `import { en } from "./locales/index.js"; module.exports = en;`,
        resolveDir: "/nonexistent",
        loader: "js",
      },
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [
        zodEnglishLocalesPlugin,
        {
          name: "fake-locales",
          setup(b) {
            b.onResolve({ filter: /locales/ }, () => ({
              path: "fake",
              namespace: "fake",
            }));
            b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
              contents: `export const en = "fake";`,
            }));
          },
        },
      ],
    });
    expect(result.outputFiles[0]?.text).toContain('"fake"');
  });
});
