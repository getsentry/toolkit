/**
 * Unit tests for `src/lib/scan/ignore.ts` (IgnoreStack).
 *
 * Pins the semantics we care about most:
 *
 *   1. A single root `.gitignore` behaves like a plain `ignore` instance.
 *   2. `alwaysSkipDirs` basenames are skipped even when no `.gitignore`
 *      mentions them (basename-anywhere semantics).
 *   3. Nested `.gitignore` files apply ON TOP OF parent patterns —
 *      cumulative, root→leaf, with child negations overriding parents.
 *   4. `.git/info/exclude` is treated as an additional root `.gitignore`
 *      when requested.
 *   5. Malformed inputs (absolute paths, empty relPath) are handled
 *      gracefully.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { IgnoreStack } from "../../../src/lib/scan/ignore.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-ignore-test-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Build a per-test sandbox directory with a fresh set of gitignore files. */
function makeSandbox(layout: Record<string, string>): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(ROOT, "sandbox-"));
  for (const [relPath, content] of Object.entries(layout)) {
    const abs = join(cwd, relPath);
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("IgnoreStack — root .gitignore", () => {
  test("respects simple patterns", async () => {
    const { cwd, cleanup } = makeSandbox({ ".gitignore": "*.log\nbuild/\n" });
    try {
      const stack = await IgnoreStack.create({
        cwd,
        alwaysSkipDirs: [],
      });
      expect(stack.isIgnored("foo.log", false)).toBe(true);
      expect(stack.isIgnored("foo.txt", false)).toBe(false);
      expect(stack.isIgnored("build", true)).toBe(true);
      expect(stack.isIgnored("build", false)).toBe(false); // dir-only pattern
    } finally {
      cleanup();
    }
  });

  test("empty cwd .gitignore = no patterns", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      expect(stack.isIgnored("foo.log", false)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("alwaysSkipDirs matches basename anywhere", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      const stack = await IgnoreStack.create({
        cwd,
        alwaysSkipDirs: ["node_modules", ".git"],
      });
      expect(stack.isIgnored("node_modules", true)).toBe(true);
      expect(stack.isIgnored("packages/foo/node_modules", true)).toBe(true);
      expect(stack.isIgnored("src/code.ts", false)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("IgnoreStack — nested .gitignore", () => {
  test("parent *.log + child !important.log un-ignores the child", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "src/.gitignore": "!important.log\n",
      "src/foo.log": "",
      "src/important.log": "",
    });
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      await stack.loadFromDir(join(cwd, "src"));
      expect(stack.isIgnored("src/foo.log", false)).toBe(true);
      expect(stack.isIgnored("src/important.log", false)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("parent patterns still apply in deeper subdirs without their own .gitignore", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "src/deep/subdir/foo.log": "",
    });
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      // No .gitignore in src/ or src/deep/ or src/deep/subdir/ — but the
      // parent pattern should still match basename-anywhere.
      expect(stack.isIgnored("src/deep/subdir/foo.log", false)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("loadFromDir is a no-op when no .gitignore present", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "src/foo.log": "",
    });
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      await stack.loadFromDir(join(cwd, "src")); // no-op; src has no .gitignore
      expect(stack.isIgnored("src/foo.log", false)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("loadFromDir called on cwd itself is idempotent (root already loaded)", async () => {
    const { cwd, cleanup } = makeSandbox({ ".gitignore": "*.log\n" });
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      await stack.loadFromDir(cwd); // no-op per implementation
      expect(stack.isIgnored("foo.log", false)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("IgnoreStack — .git/info/exclude", () => {
  test("is read when includeGitInfoExclude: true", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".git/info/exclude": "secrets.txt\n",
      "secrets.txt": "",
    });
    try {
      const stack = await IgnoreStack.create({
        cwd,
        alwaysSkipDirs: [],
        includeGitInfoExclude: true,
      });
      expect(stack.isIgnored("secrets.txt", false)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("is ignored when includeGitInfoExclude: false", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".git/info/exclude": "secrets.txt\n",
      "secrets.txt": "",
    });
    try {
      const stack = await IgnoreStack.create({
        cwd,
        alwaysSkipDirs: [],
        includeGitInfoExclude: false,
      });
      expect(stack.isIgnored("secrets.txt", false)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("IgnoreStack — input validation", () => {
  test("throws on absolute path (programming-error safeguard)", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      expect(() => stack.isIgnored("/etc/passwd", false)).toThrow(
        /relative path/
      );
    } finally {
      cleanup();
    }
  });

  test("empty or '.' relPath is never ignored", async () => {
    const { cwd, cleanup } = makeSandbox({ ".gitignore": "*\n" });
    try {
      const stack = await IgnoreStack.create({ cwd, alwaysSkipDirs: [] });
      expect(stack.isIgnored("", false)).toBe(false);
      expect(stack.isIgnored(".", false)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
