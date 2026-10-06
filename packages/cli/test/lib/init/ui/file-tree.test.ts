/**
 * Tests for the shared file-tree builder used by both the OpenTUI
 * sidebar (read-files panel + changed-files summary) and the
 * post-dispose stderr report.
 *
 * Two builders share `flattenTree`:
 *   - `buildFileTree(changed)` — sorts directories first, then alpha
 *   - `buildReadTree(reads)`   — preserves insertion order so the
 *     OpenTUI scrollbox's sticky-bottom tracking feels right
 *
 * The tests below exercise the second builder explicitly since it's
 * new in this PR; the changed-files builder already has implicit
 * coverage via the existing `formatters.test.ts` snapshot tests.
 */

import { describe, expect, test } from "vitest";
import {
  buildFileTree,
  buildReadTree,
  flattenTree,
} from "../../../../src/lib/init/ui/file-tree.js";

describe("buildReadTree", () => {
  test("returns empty tree for empty input", () => {
    const tree = buildReadTree([]);
    expect(tree.children).toHaveLength(0);
  });

  test("nests files under their parent directories", () => {
    const tree = buildReadTree([
      { path: "src/index.ts", status: "analyzed" },
      { path: "src/lib/foo.ts", status: "reading" },
      { path: "package.json", status: "analyzed" },
    ]);

    const rows = flattenTree(tree);
    const labels = rows.map((row) => `${row.kind}:${row.label}`);
    // Directory rows have trailing slash, files don't.
    expect(labels).toContain("directory:src/");
    expect(labels).toContain("directory:lib/");
    expect(labels).toContain("file:index.ts");
    expect(labels).toContain("file:foo.ts");
    expect(labels).toContain("file:package.json");
  });

  test("propagates status onto leaf rows", () => {
    const tree = buildReadTree([
      { path: "a.ts", status: "reading" },
      { path: "b.ts", status: "analyzed" },
    ]);
    const fileRows = flattenTree(tree).filter((row) => row.kind === "file");
    expect(fileRows.find((row) => row.label === "a.ts")?.status).toBe(
      "reading"
    );
    expect(fileRows.find((row) => row.label === "b.ts")?.status).toBe(
      "analyzed"
    );
  });

  test("preserves insertion order (no sort)", () => {
    // Sorting would put `aa.ts` before `bb.ts`. We deliberately
    // insert in reverse-alphabetical order to verify that the
    // builder doesn't reorder — sticky-bottom scrollbox tracking
    // depends on newly-added files always landing at the end.
    const tree = buildReadTree([
      { path: "src/zz.ts", status: "analyzed" },
      { path: "src/aa.ts", status: "analyzed" },
      { path: "src/mm.ts", status: "analyzed" },
    ]);
    const fileLabels = flattenTree(tree)
      .filter((row) => row.kind === "file")
      .map((row) => row.label);
    expect(fileLabels).toEqual(["zz.ts", "aa.ts", "mm.ts"]);
  });

  test("does not collide with the sorted changed-files tree", () => {
    // Sanity-check: feeding the same paths through `buildFileTree`
    // sorts alphabetically. The two builders must stay independent.
    const sorted = buildFileTree([
      { action: "modify", path: "src/zz.ts" },
      { action: "modify", path: "src/aa.ts" },
    ]);
    const sortedLabels = flattenTree(sorted)
      .filter((row) => row.kind === "file")
      .map((row) => row.label);
    expect(sortedLabels).toEqual(["aa.ts", "zz.ts"]);
  });

  test("does not duplicate intermediate directories", () => {
    const tree = buildReadTree([
      { path: "src/a/foo.ts", status: "analyzed" },
      { path: "src/a/bar.ts", status: "analyzed" },
      { path: "src/b/baz.ts", status: "analyzed" },
    ]);
    const dirLabels = flattenTree(tree)
      .filter((row) => row.kind === "directory")
      .map((row) => row.label);
    // `src/` should appear once, not three times.
    expect(dirLabels.filter((label) => label === "src/")).toHaveLength(1);
    expect(dirLabels.filter((label) => label === "a/")).toHaveLength(1);
    expect(dirLabels.filter((label) => label === "b/")).toHaveLength(1);
  });
});
