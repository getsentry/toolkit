/**
 * Tests for stripping prefixes from sourcemap `sources`, matching sentry-cli
 * v2's `--strip-prefix` / `--strip-common-prefix` (rust-sourcemap's
 * `strip_prefixes` and `find_common_prefix`).
 */

import { describe, expect, test } from "vitest";
import {
  type SourcesStrip,
  stripSourcemapSources,
} from "../../../src/lib/sourcemap/strip-sources.js";

/** Strip `map` and return the parsed result, or `undefined` if unchanged. */
function strip(
  map: object,
  how: SourcesStrip,
): { sources?: unknown } | undefined {
  const out = stripSourcemapSources(JSON.stringify(map), how);
  return out === undefined ? undefined : JSON.parse(out);
}

describe("stripSourcemapSources with a prefix", () => {
  test("strips a Wrangler-style ../ prefix", () => {
    const map = {
      version: 3,
      sources: ["../src/index.ts", "../node_modules/hono/dist/index.js"],
      mappings: "AAAA",
    };
    expect(strip(map, { prefix: ".." })?.sources).toEqual([
      "src/index.ts",
      "node_modules/hono/dist/index.js",
    ]);
  });

  test("strips only at a directory boundary", () => {
    const map = { version: 3, sources: ["build/a.js", "builder/b.js"] };
    expect(strip(map, { prefix: "build" })?.sources).toEqual([
      "a.js",
      "builder/b.js",
    ]);
  });

  test("leaves sources that do not start with the prefix", () => {
    const map = { version: 3, sources: ["src/a.ts", null] };
    expect(strip(map, { prefix: "dist/../" })).toBeUndefined();
  });

  test("folds sourceRoot into sources before stripping", () => {
    const map = {
      version: 3,
      sourceRoot: "/app/",
      sources: ["src/a.ts", "/abs/b.ts", "https://example.com/c.js"],
    };
    const out = strip(map, { prefix: "/app" });
    expect(out?.sources).toEqual([
      "src/a.ts",
      "/abs/b.ts",
      "https://example.com/c.js",
    ]);
    expect(out).not.toHaveProperty("sourceRoot");
  });

  test("strips sources in every index map section", () => {
    const map = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { sources: ["../src/a.ts"] } },
        { offset: { line: 9, column: 0 }, map: { sources: ["../src/b.ts"] } },
      ],
    };
    const out = strip(map, { prefix: "../" }) as {
      sections: { map: { sources: string[] } }[];
    };
    expect(out.sections.map((s) => s.map.sources)).toEqual([
      ["src/a.ts"],
      ["src/b.ts"],
    ]);
  });

  test("returns undefined for text that is not JSON", () => {
    expect(stripSourcemapSources("not json", { prefix: "a" })).toBeUndefined();
  });
});

describe("stripSourcemapSources with common: true", () => {
  test("strips the common directory of absolute sources", () => {
    const map = {
      version: 3,
      sources: ["/home/ci/app/src/a.ts", "/home/ci/app/src/b/c.ts", "rel.ts"],
    };
    expect(strip(map, { common: true })?.sources).toEqual([
      "a.ts",
      "b/c.ts",
      "rel.ts",
    ]);
  });

  test("stops at a directory boundary", () => {
    const map = { version: 3, sources: ["/app/bc.ts", "/app/bd.ts"] };
    expect(strip(map, { common: true })?.sources).toEqual(["bc.ts", "bd.ts"]);
  });

  test("handles Windows drive paths", () => {
    const map = { version: 3, sources: ["C:/work/app/a.ts", "C:/work/b.ts"] };
    expect(strip(map, { common: true })?.sources).toEqual(["app/a.ts", "b.ts"]);
  });

  test("ignores relative sources and a bare / prefix", () => {
    expect(
      strip(
        { version: 3, sources: ["../src/a.ts", "../src/b.ts"] },
        {
          common: true,
        },
      ),
    ).toBeUndefined();
    expect(
      strip({ version: 3, sources: ["/a.ts", "/b.ts"] }, { common: true }),
    ).toBeUndefined();
  });

  test("computes a regular map's prefix before applying sourceRoot", () => {
    const map = { version: 3, sourceRoot: "/app", sources: ["a.ts", "b.ts"] };
    const out = strip(map, { common: true });
    expect(out?.sources).toEqual(["/app/a.ts", "/app/b.ts"]);
    expect(out).not.toHaveProperty("sourceRoot");
  });

  test("computes one prefix across all index map sections", () => {
    const map = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { sources: ["/app/src/a.ts"] } },
        {
          offset: { line: 9, column: 0 },
          map: { sourceRoot: "/app/lib", sources: ["b.ts"] },
        },
      ],
    };
    const out = strip(map, { common: true }) as {
      sections: { map: { sources: string[] } }[];
    };
    expect(out.sections.map((s) => s.map.sources)).toEqual([
      ["src/a.ts"],
      ["lib/b.ts"],
    ]);
  });
});
