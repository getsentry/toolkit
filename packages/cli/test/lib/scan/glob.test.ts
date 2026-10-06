/**
 * Unit tests for `src/lib/scan/glob.ts` (`globFiles`, `collectGlob`).
 *
 * Pin down the picomatch-backed semantics the init wizard's
 * fs-fallback (and rg) expose:
 *
 *   - `*.ts` (no `/`) matches basename anywhere in tree.
 *   - `src/*.ts` (with `/`) matches against the relative path.
 *   - `**\/*.ts` matches `.ts` anywhere.
 *   - Multiple patterns OR.
 *   - `exclude` suppresses.
 *   - `maxResults` caps + sets `truncated: true`.
 *   - `path` narrows the walk root and yields cwd-relative paths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { collectGlob } from "../../../src/lib/scan/glob.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-glob-test-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeSandbox(layout: Record<string, string>): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(ROOT, "box-"));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(cwd, rel);
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("collectGlob — pattern semantics", () => {
  test("bare `*.ext` matches basename anywhere in tree", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "deep/sub/c.ts": "z",
      "d.md": "w",
    });
    try {
      const { files } = await collectGlob({ cwd, patterns: "*.ts" });
      expect(files).toEqual(["a.ts", "deep/sub/c.ts", "src/b.ts"]);
    } finally {
      cleanup();
    }
  });

  test("`src/*.ts` with `/` matches only directly under src/", async () => {
    const { cwd, cleanup } = makeSandbox({
      "src/a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
      "other/d.ts": "w",
    });
    try {
      const { files } = await collectGlob({ cwd, patterns: "src/*.ts" });
      expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      cleanup();
    }
  });

  test("`**/*.ts` matches anywhere in tree", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
    });
    try {
      const { files } = await collectGlob({ cwd, patterns: "**/*.ts" });
      expect(files).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
    } finally {
      cleanup();
    }
  });

  test("no matches returns empty array", async () => {
    const { cwd, cleanup } = makeSandbox({ "a.txt": "x" });
    try {
      const { files, truncated } = await collectGlob({
        cwd,
        patterns: "*.nonexistent",
      });
      expect(files).toEqual([]);
      expect(truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("brace expansion works (picomatch grammar)", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.js": "y",
      "c.md": "z",
    });
    try {
      const { files } = await collectGlob({ cwd, patterns: "*.{ts,js}" });
      expect(files).toEqual(["a.ts", "b.js"]);
    } finally {
      cleanup();
    }
  });
});

describe("collectGlob — multiple patterns", () => {
  test("array of patterns ORs them", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.js": "y",
      "c.md": "z",
    });
    try {
      const { files } = await collectGlob({
        cwd,
        patterns: ["*.ts", "*.md"],
      });
      expect(files).toEqual(["a.ts", "c.md"]);
    } finally {
      cleanup();
    }
  });

  test("empty patterns array yields nothing", async () => {
    const { cwd, cleanup } = makeSandbox({ "a.ts": "x" });
    try {
      const { files } = await collectGlob({ cwd, patterns: [] });
      expect(files).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("collectGlob — exclude", () => {
  test("exclude suppresses matching files", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.test.ts": "y",
      "c.ts": "z",
    });
    try {
      const { files } = await collectGlob({
        cwd,
        patterns: "*.ts",
        exclude: "*.test.ts",
      });
      expect(files).toEqual(["a.ts", "c.ts"]);
    } finally {
      cleanup();
    }
  });

  test("exclude array also ORs", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.test.ts": "y",
      "c.spec.ts": "z",
      "d.ts": "w",
    });
    try {
      const { files } = await collectGlob({
        cwd,
        patterns: "*.ts",
        exclude: ["*.test.ts", "*.spec.ts"],
      });
      expect(files).toEqual(["a.ts", "d.ts"]);
    } finally {
      cleanup();
    }
  });
});

describe("collectGlob — truncation", () => {
  test("maxResults caps emission and sets truncated", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.ts": "y",
      "c.ts": "z",
      "d.ts": "w",
      "e.ts": "v",
    });
    try {
      const { files, truncated } = await collectGlob({
        cwd,
        patterns: "*.ts",
        maxResults: 3,
      });
      expect(files.length).toBe(3);
      expect(truncated).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("collectGlob — path narrowing", () => {
  test("path scopes walk and yields cwd-relative paths", async () => {
    const { cwd, cleanup } = makeSandbox({
      "src/a.ts": "x",
      "src/sub/b.ts": "y",
      "other/c.ts": "z",
    });
    try {
      const { files } = await collectGlob({
        cwd,
        patterns: "**/*.ts",
        path: "src",
      });
      // Files are reported relative to cwd, not `path`.
      expect(files).toEqual(["src/a.ts", "src/sub/b.ts"]);
    } finally {
      cleanup();
    }
  });
});

describe("collectGlob — .gitignore + hidden handling", () => {
  test("respects root .gitignore by default", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "a.ts": "x",
      "b.log": "y",
    });
    try {
      const { files } = await collectGlob({ cwd, patterns: "*" });
      // .gitignore is a dotfile; with default hidden: true it matches
      // `*` under picomatch dot:true semantics. b.log is gitignored.
      expect(files.includes("a.ts")).toBe(true);
      expect(files.includes("b.log")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("hidden: false skips dotfiles", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      ".env": "y",
    });
    try {
      const { files } = await collectGlob({
        cwd,
        patterns: "*",
        hidden: false,
      });
      expect(files.includes("a.ts")).toBe(true);
      expect(files.includes(".env")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
