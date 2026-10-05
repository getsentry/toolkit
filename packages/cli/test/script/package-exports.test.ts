import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import pkg from "../../package.json";

/**
 * Guards the dual-package (ESM + CJS) contract of the published `sentry`
 * library. The bundler-plugin SDK and other ESM consumers import the default
 * export; a regression to a CJS-only `exports` map silently breaks them
 * (`createSentrySDK is not a function`) even though unit tests still pass.
 */
describe("package.json exports (dual ESM/CJS)", () => {
  const root = new URL("../../", import.meta.url);
  const resolve = (rel: string) => fileURLToPath(new URL(rel, root));

  test("declares both import and require conditions with matching types", () => {
    const dot = pkg.exports["."] as {
      import?: { types?: string; default?: string };
      require?: { types?: string; default?: string };
    };

    expect(dot.import?.default).toBe("./dist/index.mjs");
    expect(dot.import?.types).toBe("./dist/index.d.mts");
    expect(dot.require?.default).toBe("./dist/index.cjs");
    expect(dot.require?.types).toBe("./dist/index.d.cts");
  });

  test("ships both bundles and their type declarations in files", () => {
    for (const f of [
      "dist/index.mjs",
      "dist/index.cjs",
      "dist/index.d.mts",
      "dist/index.d.cts",
    ]) {
      expect(pkg.files).toContain(f);
    }
  });

  // Only meaningful after a build; skipped in a clean checkout where dist/ is absent.
  const built = existsSync(resolve("dist/index.mjs"));
  test.runIf(built)("built ESM entry exposes createSentrySDK", () => {
    // Load the built bundle in Node, outside Vitest's source-map transformer.
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import assert from 'node:assert/strict'; const mod = await import(process.argv[1]); assert.equal(typeof mod.default, 'function'); assert.equal(typeof mod.createSentrySDK, 'function');",
        resolve("dist/index.mjs"),
      ],
      { timeout: 15_000 }
    );
  });

  test.runIf(built)("built CJS entry exposes createSentrySDK", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(resolve("dist/index.cjs"));
    expect(typeof mod.createSentrySDK).toBe("function");
    expect(typeof mod.default).toBe("function");
  });

  // The ESM entry must be link-safe on the oldest supported runtime: named
  // imports of version-gated builtin exports (zstd* landed in Node 22.15)
  // fail at LINK time on older Node — before any code runs — taking the whole
  // module down. The build shims node:zlib through a namespace import; this
  // guards against a regression (e.g. a new dep importing from bare "zlib",
  // which the shim must also cover).
  test.runIf(built)(
    "built ESM entry has no link-fatal named zlib imports",
    () => {
      const src = readFileSync(resolve("dist/index.mjs"), "utf-8");
      const namedZlibImport =
        /import\s*\{[^}]*zstd[^}]*\}\s*from\s*["'](?:node:)?zlib["']/;
      expect(src).not.toMatch(namedZlibImport);
    }
  );
});
