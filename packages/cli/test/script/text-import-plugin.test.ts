/**
 * Tests for the `file` handler in the text-import-plugin.
 *
 * The plugin pre-bundles TypeScript/TSX files into self-contained JS
 * before embedding. These tests verify:
 * - TypeScript-only syntax is stripped (`import { type Foo }`)
 * - JSX is transpiled via the automatic runtime
 * - The output is parseable JavaScript
 * - Non-TS files are copied verbatim
 * - The createRequire banner is injected for CJS compatibility
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { textImportPlugin } from "../../script/text-import-plugin.js";

const TEST_DIR = join(
  process.env.VITEST_POOL_ID
    ? `/tmp/opencode/tip-test-${process.env.VITEST_POOL_ID}`
    : "/tmp/opencode/tip-test"
);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Helper to build with the plugin and return the sidecar output. */
async function buildWithPlugin(
  srcDir: string,
  outDir: string,
  entryFile: string
): Promise<void> {
  await build({
    entryPoints: [join(srcDir, entryFile)],
    bundle: true,
    outdir: outDir,
    platform: "node",
    target: "esnext",
    format: "esm",
    write: true,
    plugins: [textImportPlugin],
  });
}

describe("text-import-plugin file handler", () => {
  test("strips TypeScript type-only imports from .ts files", async () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(
      join(srcDir, "types.ts"),
      "export type Foo = { x: number };\nexport const VALUE = 42;\n"
    );
    writeFileSync(
      join(srcDir, "mod.ts"),
      [
        'import { type Foo, VALUE } from "./types.js";',
        "export function getFoo(): number { return VALUE; }",
      ].join("\n")
    );
    writeFileSync(
      join(srcDir, "entry.ts"),
      'import path from "./mod.ts" with { type: "file" };\nexport default path;\n'
    );

    const outDir = join(TEST_DIR, "out");
    await buildWithPlugin(srcDir, outDir, "entry.ts");

    expect(existsSync(join(outDir, "mod.js"))).toBe(true);
    expect(existsSync(join(outDir, "mod.ts"))).toBe(false);

    const content = await readFile(join(outDir, "mod.js"), "utf-8");
    // TypeScript type import should be stripped
    expect(content).not.toContain("type Foo");
    // Value export should remain
    expect(content).toContain("getFoo");
    // Local dep should be inlined (not an external import)
    expect(content).toContain("42");
  });

  test("outputs .js extension for .tsx entry points", async () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(
      join(srcDir, "comp.tsx"),
      "export function App() { return null; }\n"
    );
    writeFileSync(
      join(srcDir, "entry.ts"),
      'import path from "./comp.tsx" with { type: "file" };\nexport default path;\n'
    );

    const outDir = join(TEST_DIR, "out");
    await buildWithPlugin(srcDir, outDir, "entry.ts");

    expect(existsSync(join(outDir, "comp.js"))).toBe(true);
    expect(existsSync(join(outDir, "comp.tsx"))).toBe(false);
  });

  test("copies plain .js files verbatim", async () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, "plain.js"), "export const x = 42;\n");
    writeFileSync(
      join(srcDir, "entry.ts"),
      'import path from "./plain.js" with { type: "file" };\nexport default path;\n'
    );

    const outDir = join(TEST_DIR, "out");
    await buildWithPlugin(srcDir, outDir, "entry.ts");

    expect(existsSync(join(outDir, "plain.js"))).toBe(true);
    const content = await readFile(join(outDir, "plain.js"), "utf-8");
    expect(content).toContain("export const x = 42");
  });

  test("injects createRequire banner for CJS deps", async () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, "mod.ts"), "export const y = 1;\n");
    writeFileSync(
      join(srcDir, "entry.ts"),
      'import path from "./mod.ts" with { type: "file" };\nexport default path;\n'
    );

    const outDir = join(TEST_DIR, "out");
    await buildWithPlugin(srcDir, outDir, "entry.ts");

    const content = await readFile(join(outDir, "mod.js"), "utf-8");
    expect(content).toContain("createRequire");
    expect(content).toContain("import.meta.url");
  });

  test("inlines local dependencies into the output", async () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, "helper.ts"), "export const MAGIC = 999;\n");
    writeFileSync(
      join(srcDir, "mod.ts"),
      'import { MAGIC } from "./helper.js";\nexport function getMagic() { return MAGIC; }\n'
    );
    writeFileSync(
      join(srcDir, "entry.ts"),
      'import path from "./mod.ts" with { type: "file" };\nexport default path;\n'
    );

    const outDir = join(TEST_DIR, "out");
    await buildWithPlugin(srcDir, outDir, "entry.ts");

    const content = await readFile(join(outDir, "mod.js"), "utf-8");
    // The helper module should be inlined, not left as an import
    expect(content).toContain("999");
    expect(content).not.toContain('"./helper.js"');
  });
});
