/**
 * Tests for directory-level debug-ID injection. Covers the discovery
 * walk (used to be hand-rolled, now delegates to `walkFiles`) —
 * specifically the skip policy for `node_modules` / dotfiles, the
 * `.gitignore` bypass for build-output dirs, and the extension
 * filter.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getDebugIdSnippet } from "../../../src/lib/sourcemap/debug-id.js";
import { injectDirectory } from "../../../src/lib/sourcemap/inject.js";
import { tryDecodeInlineSourcemap } from "../../../src/lib/sourcemap/inline-sourcemap.js";

describe("injectDirectory — discovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-inject-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a .js + .js.map pair at `rel` inside `dir`. */
  function writePair(rel: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `// ${rel}\n`);
    writeFileSync(`${full}.map`, "{}\n");
  }

  test("discovers .js pairs in nested dirs", async () => {
    writePair("app.js");
    writePair("a/nested.js");
    writePair("a/b/deep.js");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    expect(paths).toEqual(["a/b/deep.js", "a/nested.js", "app.js"]);
  });

  test("skips .js files without a companion .map", async () => {
    writePair("withmap.js");
    writeFileSync(join(dir, "orphan.js"), "// orphan\n");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1));
    expect(paths).toEqual(["withmap.js"]);
  });

  test("discovers .cjs and .mjs files by default", async () => {
    writePair("a.js");
    writePair("b.cjs");
    writePair("c.mjs");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    expect(paths).toEqual(["a.js", "b.cjs", "c.mjs"]);
  });

  test("respects custom extensions", async () => {
    writePair("a.js");
    writePair("b.ts");

    const results = await injectDirectory(dir, {
      dryRun: true,
      extensions: ["ts"],
    });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1));
    expect(paths).toEqual(["b.ts"]);
  });

  test("skips node_modules", async () => {
    writePair("app.js");
    writePair("node_modules/foo/lib.js");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1));
    expect(paths).toEqual(["app.js"]);
  });

  test("skips hidden (dot-prefixed) directories", async () => {
    writePair("app.js");
    writePair(".cache/cached.js");
    writePair(".git/hooks/script.js");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1));
    expect(paths).toEqual(["app.js"]);
  });

  test("ignores .gitignore — build-output dirs are always scanned", async () => {
    // Typical build setup: `dist/` is gitignored but contains the
    // files we want to inject into.
    writeFileSync(join(dir, ".gitignore"), "dist/\nbuild/\n");
    writePair("src/a.js");
    writePair("dist/bundle.js");
    writePair("build/out.js");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    expect(paths).toEqual(["build/out.js", "dist/bundle.js", "src/a.js"]);
  });

  test("scans a directory that's itself named like a gitignore target", async () => {
    // User passes `dist/` directly as the scan root. The default
    // skip list in `scan/` includes "dist" — we explicitly narrow
    // it to `["node_modules"]` for this use case.
    writePair("bundle.js");
    writePair("chunks/one.js");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    expect(paths).toEqual(["bundle.js", "chunks/one.js"]);
  });

  test("does not follow symlinks", async () => {
    // Default: symlinks are ignored (matches pre-refactor behavior).
    writePair("real.js");
    const realDir = join(dir, "src");
    const linkDir = join(dir, "link");
    mkdirSync(realDir, { recursive: true });
    writePair("src/x.js");
    try {
      symlinkSync(realDir, linkDir, "dir");
    } catch {
      // Some filesystems (e.g. Windows without dev mode) can't
      // create symlinks — skip this assertion in that case.
      return;
    }
    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    // `real.js` + `src/x.js` should be discovered; `link/x.js` must NOT.
    expect(paths).toEqual(["real.js", "src/x.js"]);
  });

  test("returns empty for missing directory", async () => {
    const results = await injectDirectory(join(dir, "does-not-exist"), {
      dryRun: true,
    });
    expect(results).toEqual([]);
  });

  test("accepts relative paths (not just absolute)", async () => {
    // Regression: `walkFiles` enforces absolute cwd and throws on
    // relative input. CLI callers (`sourcemap inject ./dist`) pass
    // the user-supplied arg straight through, so the adapter must
    // resolve it to absolute itself.
    writePair("app.js");
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      for (const relDir of ["./", ".", "./."]) {
        const results = await injectDirectory(relDir, { dryRun: true });
        expect(results).toHaveLength(1);
        // The jsPath must still be absolute — consumers expect
        // absolute paths for downstream file ops.
        expect(results[0]?.jsPath).toMatch(/^\//);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("discovers large JS bundles (> walker's default 256 KB)", async () => {
    // Regression: `walkFiles` defaults to `maxFileSize: 256 KB`,
    // which silently skipped any `.js` file larger than that —
    // i.e. every real-world webpack/rollup/Next.js bundle. The
    // adapter must opt out of the size cap.
    const bundlePath = join(dir, "bundle.js");
    // 512 KB of filler — exceeds the walker's default 256 KB cap.
    writeFileSync(bundlePath, "x".repeat(512 * 1024));
    writeFileSync(`${bundlePath}.map`, "{}\n");

    const results = await injectDirectory(dir, { dryRun: true });
    const paths = results.map((r) => r.jsPath.slice(dir.length + 1));
    expect(paths).toEqual(["bundle.js"]);
  });
});

describe("injectDirectory — inline sourcemaps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-inject-inline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a `data:` URL for a sourcemap object. */
  function toDataUrl(map: unknown): string {
    const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
    return `data:application/json;base64,${b64}`;
  }

  /** Write a JS file with an inline sourcemap and no companion .map. */
  function writeInline(rel: string, map: unknown, body = "console.log(1)\n") {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `${body}//# sourceMappingURL=${toDataUrl(map)}\n`);
    return full;
  }

  const SAMPLE_MAP = {
    version: 3,
    sources: ["a.ts"],
    mappings: "AAAA",
    names: [],
  };

  test("discovers an inline-map JS file (no companion .map)", async () => {
    writeInline("inline.js", SAMPLE_MAP);
    const results = await injectDirectory(dir, { dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.map.kind).toBe("inline");
    expect(results[0]?.mapPath).toBeUndefined();
  });

  test("injects a debug ID and rewrites the inline directive in place", async () => {
    const jsPath = writeInline("inline.js", SAMPLE_MAP);
    const results = await injectDirectory(dir);
    expect(results).toHaveLength(1);
    const { debugId, injected, injectedMapContent } = results[0] ?? {};
    expect(injected).toBe(true);
    expect(debugId).toMatch(/^[0-9a-f-]{36}$/);

    const js = readFileSync(jsPath, "utf-8");
    // IIFE snippet + debugId comment present.
    expect(js).toContain(`sentry-dbid-${debugId}`);
    expect(js).toContain(`//# debugId=${debugId}`);

    // The rewritten inline directive carries the injected map.
    const m = js.match(
      /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/
    );
    expect(m).not.toBeNull();
    const rewritten = JSON.parse(
      Buffer.from(m?.[1] ?? "", "base64").toString("utf-8")
    );
    expect(rewritten.debug_id).toBe(debugId);
    expect(rewritten.debugId).toBe(debugId);
    expect(rewritten.mappings).toBe(`;${SAMPLE_MAP.mappings}`);

    // injectedMapContent matches the rewritten inline map.
    expect(
      JSON.parse((injectedMapContent ?? Buffer.alloc(0)).toString())
    ).toEqual(rewritten);
  });

  test("is idempotent across repeated injection", async () => {
    const jsPath = writeInline("inline.js", SAMPLE_MAP);
    await injectDirectory(dir);
    const first = readFileSync(jsPath, "utf-8");
    const second = await injectDirectory(dir);
    expect(second[0]?.injected).toBe(false);
    expect(readFileSync(jsPath, "utf-8")).toBe(first);
  });

  test("discovers inline maps larger than the 2MB last-line window", async () => {
    // Pad the sourcemap so its base64 data URL exceeds 2 MB, forcing the
    // backward last-line reader to slide its window.
    const bigMap = {
      version: 3,
      sources: ["a.ts"],
      mappings: "AAAA",
      sourcesContent: ["x".repeat(3 * 1024 * 1024)],
    };
    writeInline("big-inline.js", bigMap);
    const results = await injectDirectory(dir, { dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.map.kind).toBe("inline");
  });

  test("discovers an inline directive followed by a trailing license banner", async () => {
    const jsPath = join(dir, "banner.js");
    writeFileSync(
      jsPath,
      `console.log(1)\n//# sourceMappingURL=${toDataUrl(SAMPLE_MAP)}\n/*! some-lib v1.2.3 | MIT */\n`
    );
    const results = await injectDirectory(dir, { dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.map.kind).toBe("inline");
  });

  test("preserves a hashbang when injecting into an inline-map file", async () => {
    const jsPath = writeInline(
      "cli.js",
      SAMPLE_MAP,
      "#!/usr/bin/env node\nconsole.log(1)\n"
    );
    await injectDirectory(dir);
    const js = readFileSync(jsPath, "utf-8");
    expect(js.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Snippet must follow the hashbang, not precede it.
    expect(js.indexOf("sentry-dbid-")).toBeGreaterThan(
      js.indexOf("#!/usr/bin/env node")
    );
  });

  test("only rewrites the real directive, not a mid-line false positive", async () => {
    // A string literal embeds a fake `//# sourceMappingURL=data:...` mid-line.
    // The whole-file regex could match it; line-anchored matching must not.
    const fake = `data:application/json;base64,${Buffer.from('{"version":1}').toString("base64")}`;
    const jsPath = writeInline(
      "twin.js",
      SAMPLE_MAP,
      `const s = "//# sourceMappingURL=${fake}";\nconsole.log(s)\n`
    );
    const results = await injectDirectory(dir);
    expect(results[0]?.injected).toBe(true);
    const js = readFileSync(jsPath, "utf-8");
    // The fake (version:1) directive in the string literal is untouched.
    expect(js).toContain(`const s = "//# sourceMappingURL=${fake}"`);
    // The real (last-line) inline map is the one that got the debug ID.
    const realLine = js
      .split("\n")
      .find((l) => l.startsWith("//# sourceMappingURL=data:"));
    const realB64 = realLine?.match(/base64,([A-Za-z0-9+/=]+)/)?.[1] ?? "";
    const realMap = JSON.parse(
      Buffer.from(realB64, "base64").toString("utf-8")
    );
    expect(realMap.debug_id).toBe(results[0]?.debugId);
    expect(realMap.version).toBe(3); // the real SAMPLE_MAP, not the fake
  });

  test("skips invalid inline base64 non-fatally and keeps other pairs", async () => {
    // Valid inline map.
    writeInline("good.js", SAMPLE_MAP);
    // Bogus inline directive (terser template-literal false positive).
    const bad = join(dir, "bad.js");
    writeFileSync(
      bad,
      "console.log(2)\n//# sourceMappingURL=data:application/json;base64,@@@nope@@@\n"
    );

    const results = await injectDirectory(dir, { dryRun: true });
    const names = results.map((r) => r.jsPath.slice(dir.length + 1)).sort();
    expect(names).toEqual(["good.js"]);
  });
});

describe("injectDirectory — debug ID uniqueness (regression #3350)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-inject-dbid-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The empty sourcemap esbuild emits for helper/re-export-only chunks. */
  const EMPTY_MAP = '{"version":3,"sources":[],"names":[],"mappings":""}';

  /** Build a `data:` URL for a sourcemap object. */
  function toDataUrl(map: unknown): string {
    const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
    return `data:application/json;base64,${b64}`;
  }

  /** Map results back to a `basename → debugId` object. */
  function debugIdsByName(
    results: Awaited<ReturnType<typeof injectDirectory>>
  ): Record<string, string> {
    return Object.fromEntries(
      results.map((r) => [r.jsPath.slice(dir.length + 1), r.debugId])
    );
  }

  test("external: distinct chunks with byte-identical empty maps get distinct debug IDs", async () => {
    // Exact scenario from getsentry/sentry-cli#3350: two different minified
    // chunks whose sourcemaps are the byte-identical empty map. Companion
    // `.map` files are auto-discovered by the `<name>.map` convention.
    writeFileSync(join(dir, "a.js"), "console.log(1)\n");
    writeFileSync(join(dir, "a.js.map"), EMPTY_MAP);
    writeFileSync(join(dir, "b.js"), "console.log(22)\n");
    writeFileSync(join(dir, "b.js.map"), EMPTY_MAP);

    const ids = debugIdsByName(await injectDirectory(dir));
    expect(ids["a.js"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids["b.js"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids["a.js"]).not.toBe(ids["b.js"]);
  });

  test("inline: distinct chunks with identical inline maps get distinct debug IDs", async () => {
    const emptyInline = JSON.parse(EMPTY_MAP);
    writeFileSync(
      join(dir, "a.js"),
      `console.log(1)\n//# sourceMappingURL=${toDataUrl(emptyInline)}\n`
    );
    writeFileSync(
      join(dir, "b.js"),
      `console.log(22)\n//# sourceMappingURL=${toDataUrl(emptyInline)}\n`
    );

    const ids = debugIdsByName(await injectDirectory(dir));
    expect(ids["a.js"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids["b.js"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids["a.js"]).not.toBe(ids["b.js"]);
  });

  test("byte-identical (JS, map) artifacts share a debug ID (determinism preserved)", async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["input.ts"],
      mappings: "AAAA",
    });
    writeFileSync(join(dir, "a.js"), "console.log(1)\n");
    writeFileSync(join(dir, "a.js.map"), map);
    writeFileSync(join(dir, "b.js"), "console.log(1)\n");
    writeFileSync(join(dir, "b.js.map"), map);

    const ids = debugIdsByName(await injectDirectory(dir));
    expect(ids["a.js"]).toBe(ids["b.js"]);
  });
});

/**
 * A debug ID already stamped on the sourcemap by a bundler plugin
 * (`sourcemaps.disable: 'disable-upload'`) must be adopted, not replaced.
 * Those builds deliberately leave the bundle without a `//# debugId=` comment
 * so post-emit rewriting can't invalidate subresource-integrity hashes.
 */
describe("injectDirectory — pre-existing sourcemap debug ID", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-inject-mapid-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A debug ID a bundler plugin would have minted at build time. */
  const PLUGIN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  const BASE_MAP = {
    version: 3,
    sources: ["a.ts"],
    names: [],
    mappings: "AAAA",
  };

  /** Build a `data:` URL for a sourcemap object. */
  function toDataUrl(map: unknown): string {
    const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
    return `data:application/json;base64,${b64}`;
  }

  /**
   * Write what the plugin emits: a bundle carrying its own `_sentryDebugIds`
   * writer but no `//# debugId=` comment, plus a map holding the ID.
   */
  function writePluginPair(
    name: string,
    mapExtra: Record<string, unknown>
  ): { jsPath: string; mapPath: string; js: string; map: string } {
    const jsPath = join(dir, name);
    const mapPath = `${jsPath}.map`;
    const js = `${getDebugIdSnippet(PLUGIN_ID)}\nconsole.log(1)\n//# sourceMappingURL=${name}.map\n`;
    const map = JSON.stringify({ ...BASE_MAP, ...mapExtra });
    writeFileSync(jsPath, js);
    writeFileSync(mapPath, map);
    return { jsPath, mapPath, js, map };
  }

  test("adopts a `debug_id` from an external map without touching either file", async () => {
    const pair = writePluginPair("bundle.js", { debug_id: PLUGIN_ID });

    const results = await injectDirectory(dir);

    expect(results).toHaveLength(1);
    expect(results[0]?.debugId).toBe(PLUGIN_ID);
    expect(results[0]?.injected).toBe(false);
    expect(readFileSync(pair.jsPath, "utf-8")).toBe(pair.js);
    expect(readFileSync(pair.mapPath, "utf-8")).toBe(pair.map);
  });

  test("adopts the camelCase `debugId` spelling", async () => {
    const pair = writePluginPair("bundle.js", { debugId: PLUGIN_ID });

    const results = await injectDirectory(dir);

    expect(results[0]?.debugId).toBe(PLUGIN_ID);
    expect(results[0]?.injected).toBe(false);
    expect(readFileSync(pair.jsPath, "utf-8")).toBe(pair.js);
    expect(readFileSync(pair.mapPath, "utf-8")).toBe(pair.map);
  });

  test("prefers `debug_id` when both spellings disagree", async () => {
    const other = "11111111-2222-3333-4444-555555555555";
    writePluginPair("bundle.js", { debug_id: PLUGIN_ID, debugId: other });

    const results = await injectDirectory(dir);

    expect(results[0]?.debugId).toBe(PLUGIN_ID);
  });

  test("adopts a debug ID carried by an inline map", async () => {
    const jsPath = join(dir, "inline.js");
    const js = `${getDebugIdSnippet(PLUGIN_ID)}\nconsole.log(1)\n//# sourceMappingURL=${toDataUrl({ ...BASE_MAP, debug_id: PLUGIN_ID })}\n`;
    writeFileSync(jsPath, js);

    const results = await injectDirectory(dir);

    expect(results[0]?.debugId).toBe(PLUGIN_ID);
    expect(results[0]?.injected).toBe(false);
    expect(readFileSync(jsPath, "utf-8")).toBe(js);
    // The map is uploaded exactly as decoded — no snippet, so no line offset.
    const uploaded = JSON.parse(
      (results[0]?.injectedMapContent ?? Buffer.alloc(0)).toString()
    );
    expect(uploaded.debug_id).toBe(PLUGIN_ID);
    expect(uploaded.mappings).toBe(BASE_MAP.mappings);
  });

  test("a `//# debugId=` comment in the JS wins over a conflicting map field", async () => {
    const jsPath = join(dir, "bundle.js");
    const jsId = "99999999-8888-7777-6666-555555555555";
    writeFileSync(
      jsPath,
      `console.log(1)\n//# sourceMappingURL=bundle.js.map\n//# debugId=${jsId}\n`
    );
    writeFileSync(
      `${jsPath}.map`,
      JSON.stringify({ ...BASE_MAP, debug_id: PLUGIN_ID })
    );

    const results = await injectDirectory(dir);

    expect(results[0]?.debugId).toBe(jsId);
    expect(results[0]?.injected).toBe(true);
    expect(readFileSync(jsPath, "utf-8")).toContain(getDebugIdSnippet(jsId));
    const map = JSON.parse(readFileSync(`${jsPath}.map`, "utf-8"));
    expect(map.debug_id).toBe(jsId);
    expect(map.debugId).toBe(jsId);
    expect(map.mappings).toBe(`;${BASE_MAP.mappings}`);
  });

  test("falls through to minting when the map's debug ID is malformed", async () => {
    const pair = writePluginPair("bundle.js", { debug_id: "not-a-uuid" });

    const results = await injectDirectory(dir);

    expect(results[0]?.injected).toBe(true);
    expect(results[0]?.debugId).toMatch(/^[0-9a-f-]{36}$/);
    expect(results[0]?.debugId).not.toBe("not-a-uuid");
    const js = readFileSync(pair.jsPath, "utf-8");
    expect(js).toContain(`//# debugId=${results[0]?.debugId}`);
    expect(JSON.parse(readFileSync(pair.mapPath, "utf-8")).debug_id).toBe(
      results[0]?.debugId
    );
  });

  test("--dry-run reports the adopted ID rather than a pending injection", async () => {
    const pair = writePluginPair("bundle.js", { debug_id: PLUGIN_ID });

    const results = await injectDirectory(dir, { dryRun: true });

    expect(results[0]?.debugId).toBe(PLUGIN_ID);
    expect(results[0]?.injected).toBe(false);
    expect(readFileSync(pair.jsPath, "utf-8")).toBe(pair.js);
    expect(readFileSync(pair.mapPath, "utf-8")).toBe(pair.map);
  });

  test("repeated runs stay a no-op", async () => {
    const pair = writePluginPair("bundle.js", { debug_id: PLUGIN_ID });

    await injectDirectory(dir);
    const results = await injectDirectory(dir);

    expect(results[0]?.debugId).toBe(PLUGIN_ID);
    expect(readFileSync(pair.jsPath, "utf-8")).toBe(pair.js);
    expect(readFileSync(pair.mapPath, "utf-8")).toBe(pair.map);
  });

  test("preserves binary bundles whose map already carries a debug ID", async () => {
    const jsPath = join(dir, "main.bundle");
    // Hermes bytecode magic followed by the bytecode version, including NULs.
    const bundle = Buffer.from("c61fbc03c103191f60000000", "hex");
    const map = JSON.stringify({ ...BASE_MAP, debugId: PLUGIN_ID });
    writeFileSync(jsPath, bundle);
    writeFileSync(`${jsPath}.map`, map);

    for (const dryRun of [true, false]) {
      const results = await injectDirectory(dir, {
        extensions: [".bundle"],
        dryRun,
      });
      expect(results[0]).toMatchObject({
        debugId: PLUGIN_ID,
        injected: false,
      });
      expect(readFileSync(jsPath)).toEqual(bundle);
      expect(readFileSync(`${jsPath}.map`, "utf-8")).toBe(map);
    }
  });
});

describe.each([
  "external",
  "inline",
] as const)("injectDirectory — %s map runtime registration", (kind) => {
  let dir: string;
  const debugId = "11111111-2222-5333-9444-555555555555";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-inject-runtime-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    "legacy",
    "formatted",
  ])("preserves an existing %s registration without an identifier marker", async (format) => {
    const jsPath = join(dir, "main.js");
    // Legacy CLI snippets have no _sentryDebugIdIdentifier marker.
    const snippet =
      format === "legacy"
        ? `!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}")}catch(e){}}();`
        : `(() => {
  var root = globalThis;
  var stack = new root.Error().stack;
  root['_sentryDebugIds'] = root['_sentryDebugIds'] || {};
  root['_sentryDebugIds'][stack] = '${debugId}';
})();`;
    const mapContent = JSON.stringify({
      version: 3,
      sources: ["main.ts"],
      names: [],
      mappings: ";AAAA",
      debugId,
    });
    const mapUrl =
      kind === "inline"
        ? `data:application/json;base64,${Buffer.from(mapContent).toString("base64")}`
        : "main.js.map";
    const js = `${snippet}\n//# debugId=${debugId}\n//# sourceMappingURL=${mapUrl}\n`;
    writeFileSync(jsPath, js);
    if (kind === "external") {
      writeFileSync(`${jsPath}.map`, mapContent);
    }

    for (const options of [{ dryRun: true }, {}]) {
      expect((await injectDirectory(dir, options))[0]).toMatchObject({
        debugId,
        injected: false,
      });
      expect(readFileSync(jsPath, "utf-8")).toBe(js);
      if (kind === "external") {
        expect(readFileSync(`${jsPath}.map`, "utf-8")).toBe(mapContent);
      }
    }
    const sandbox: { _sentryDebugIds?: Record<string, string> } = {};
    runInNewContext(js, sandbox, { filename: "main.js" });
    expect(Object.values(sandbox._sentryDebugIds ?? {})).toEqual([debugId]);
  });

  test.each([
    "comment",
    "debugId",
    "debug_id",
    "comment and map",
  ])("registers an ID from %s exactly once", async (source) => {
    const jsPath = join(dir, "main.js");
    const hasComment = source.startsWith("comment");
    const mapContent = JSON.stringify({
      version: 3,
      sources: ["main.ts"],
      sourcesContent: ["globalThis.answer = 42;"],
      names: [],
      mappings: "AAAA",
      ...(source === "comment"
        ? {}
        : { [source === "debug_id" ? "debug_id" : "debugId"]: debugId }),
    });
    const mapUrl =
      kind === "inline"
        ? `data:application/json;base64,${Buffer.from(mapContent).toString("base64")}`
        : "main.js.map";
    // SDK readers mention the registry without registering a bundle ID.
    const js =
      "globalThis.answer = 42; globalThis.readIds = () => globalThis._sentryDebugIds;\n" +
      (hasComment ? `//# debugId=${debugId}\n` : "") +
      `//# sourceMappingURL=${mapUrl}\n`;
    writeFileSync(jsPath, js);
    if (kind === "external") {
      writeFileSync(`${jsPath}.map`, mapContent);
    }

    const preview = await injectDirectory(dir, { dryRun: true });
    expect(preview[0]).toMatchObject({ debugId, injected: true });
    expect(readFileSync(jsPath, "utf-8")).toBe(js);
    if (kind === "external") {
      expect(readFileSync(`${jsPath}.map`, "utf-8")).toBe(mapContent);
    }

    const results = await injectDirectory(dir);
    expect(results[0]).toMatchObject({ debugId, injected: true });
    const output = readFileSync(jsPath, "utf-8");
    const sandbox: {
      answer?: number;
      _sentryDebugIds?: Record<string, string>;
    } = {};
    runInNewContext(output, sandbox, { filename: "main.js" });
    expect(sandbox.answer).toBe(42);
    expect(Object.values(sandbox._sentryDebugIds ?? {})).toEqual([debugId]);
    expect(output.match(/\/\/# debugId=/g)).toHaveLength(1);

    const outputMap =
      kind === "external"
        ? readFileSync(`${jsPath}.map`, "utf-8")
        : results[0]?.injectedMapContent?.toString("utf-8");
    expect(JSON.parse(outputMap ?? "{}")).toMatchObject({
      debugId,
      debug_id: debugId,
      mappings: ";AAAA",
    });
    if (kind === "inline") {
      const url = output.match(/\/\/# sourceMappingURL=(\S+)/)?.[1];
      expect(tryDecodeInlineSourcemap(url ?? "")?.json).toBe(outputMap);
    }

    const second = await injectDirectory(dir);
    expect(second[0]).toMatchObject({ debugId, injected: false });
    expect(readFileSync(jsPath, "utf-8")).toBe(output);
    expect(
      kind === "external"
        ? readFileSync(`${jsPath}.map`, "utf-8")
        : second[0]?.injectedMapContent?.toString("utf-8")
    ).toBe(outputMap);
    expect((await injectDirectory(dir, { dryRun: true }))[0]).toMatchObject({
      debugId,
      injected: false,
    });
  });
});
