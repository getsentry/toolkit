/**
 * Unit tests for `walkFiles` in `src/lib/scan/walker.ts`.
 *
 * Each test builds a small sandbox under `tmpdir()`, runs the walker
 * with specific options, and asserts the yielded relative paths (order
 * doesn't matter — we compare via Set).
 *
 * Time-budget tests inject a mock clock so we can verify the min-depth
 * guarantee without flaky wall-clock dependencies.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { WalkEntry } from "../../../src/lib/scan/types.js";
import { walkFiles } from "../../../src/lib/scan/walker.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-walker-test-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Build a sandbox directory with the given relative-path → content map. */
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

/** Collect every relativePath a walk yields into a sorted array. */
async function collect(
  opts: Parameters<typeof walkFiles>[0]
): Promise<string[]> {
  const out: WalkEntry[] = [];
  for await (const entry of walkFiles(opts)) {
    out.push(entry);
  }
  return out.map((e) => e.relativePath).sort();
}

describe("walkFiles — basic traversal", () => {
  test("yields every file at every depth under cwd", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
    });
    try {
      const files = await collect({ cwd });
      expect(files).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
    } finally {
      cleanup();
    }
  });

  test("returns nothing when cwd doesn't exist", async () => {
    const files = await collect({ cwd: join(ROOT, "does-not-exist") });
    expect(files).toEqual([]);
  });

  test("empty directory yields nothing", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      const files = await collect({ cwd });
      expect(files).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("throws on relative cwd (programming-error safeguard)", async () => {
    await expect(
      (async () => {
        for await (const _ of walkFiles({ cwd: "./relative" })) {
          break;
        }
      })()
    ).rejects.toThrow(/absolute/);
  });
});

describe("walkFiles — filtering", () => {
  test("extensions filter narrows yield to allowed suffixes", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b.js": "y",
      "c.md": "z",
    });
    try {
      const files = await collect({
        cwd,
        extensions: new Set([".ts", ".js"]),
      });
      expect(files).toEqual(["a.ts", "b.js"]);
      expect(files.includes("c.md")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("alwaysSkipDirs skips matching directory subtrees", async () => {
    const { cwd, cleanup } = makeSandbox({
      "src/a.ts": "x",
      "node_modules/dep/index.js": "y",
      "packages/p/node_modules/other/x.js": "z",
      "packages/p/src/ok.ts": "w",
    });
    try {
      const files = await collect({
        cwd,
        alwaysSkipDirs: ["node_modules"],
        respectGitignore: false,
      });
      expect(files).toEqual(["packages/p/src/ok.ts", "src/a.ts"]);
    } finally {
      cleanup();
    }
  });

  test("hidden: false skips dotfiles and dotdirs", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      ".env": "y",
      ".hidden/z.ts": "z",
    });
    try {
      const files = await collect({ cwd, hidden: false });
      expect(files).toEqual(["a.ts"]);
    } finally {
      cleanup();
    }
  });

  test("hidden: true (default) yields dotfiles", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      ".env": "y",
    });
    try {
      const files = await collect({ cwd });
      expect(files.includes(".env")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — size + depth limits", () => {
  test("maxFileSize skips oversized files", async () => {
    const { cwd, cleanup } = makeSandbox({
      "small.ts": "x",
      "big.ts": "x".repeat(2000),
    });
    try {
      const files = await collect({ cwd, maxFileSize: 1000 });
      expect(files).toEqual(["small.ts"]);
    } finally {
      cleanup();
    }
  });

  test("maxDepth caps directory descent; files inside still yield", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
      "src/deep/deeper/d.ts": "w",
    });
    try {
      // Dirs entered: cwd (0), src (1), deep (2). `deeper` (would be
      // 3) is NOT entered. Files inside any entered dir yield:
      //   a.ts (inside cwd), src/b.ts (inside src), src/deep/c.ts
      //   (inside deep). `deeper/d.ts` skipped because `deeper` is
      //   never entered.
      const files = await collect({ cwd, maxDepth: 2 });
      expect(files).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — .gitignore integration", () => {
  test("respectGitignore: true honors root patterns", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "a.ts": "x",
      "b.log": "y",
    });
    try {
      const files = await collect({ cwd });
      expect(files.sort()).toEqual([".gitignore", "a.ts"]);
    } finally {
      cleanup();
    }
  });

  test("respectGitignore: false skips even the root .gitignore", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "a.ts": "x",
      "b.log": "y",
    });
    try {
      const files = await collect({ cwd, respectGitignore: false });
      expect(files).toEqual([".gitignore", "a.ts", "b.log"]);
    } finally {
      cleanup();
    }
  });

  test("nested .gitignore layers on top of parent (cumulative)", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "*.log\n",
      "src/.gitignore": "!important.log\n",
      "src/foo.log": "x",
      "src/important.log": "y",
    });
    try {
      const files = await collect({ cwd });
      // Parent ignored *.log, child un-ignored important.log.
      expect(files.includes("src/foo.log")).toBe(false);
      expect(files.includes("src/important.log")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — binary detection", () => {
  test("known text extensions classify as text without opening", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "hello",
      "b.json": "{}",
    });
    try {
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd })) {
        entries.push(e);
      }
      for (const e of entries) {
        expect(e.isBinary).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test("binary files with unknown extensions classify as binary", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      // Write a NUL-containing blob with an unknown extension.
      const bin = new Uint8Array(256);
      bin[10] = 0;
      writeFileSync(join(cwd, "blob.bin"), bin);
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd })) {
        entries.push(e);
      }
      const blob = entries.find((e) => e.relativePath === "blob.bin");
      expect(blob?.isBinary).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("classifyBinary: false yields files without sniffing (isBinary=false)", async () => {
    const { cwd, cleanup } = makeSandbox({});
    try {
      // A NUL-containing blob that the default sniff classifies as binary.
      const bin = new Uint8Array(256);
      bin[10] = 0;
      writeFileSync(join(cwd, "blob.bin"), bin);

      const findBlob = async (
        opts: Parameters<typeof walkFiles>[0]
      ): Promise<WalkEntry | undefined> => {
        for await (const e of walkFiles(opts)) {
          if (e.relativePath === "blob.bin") {
            return e;
          }
        }
        return;
      };

      // By default the blob sniffs as binary; with classification disabled the
      // same file is still yielded but reported non-binary (the 8 KB head-read
      // is skipped entirely).
      expect((await findBlob({ cwd }))?.isBinary).toBe(true);
      expect((await findBlob({ cwd, classifyBinary: false }))?.isBinary).toBe(
        false
      );
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — mtime recording", () => {
  test("recordMtimes: false (default) leaves mtime = 0", async () => {
    const { cwd, cleanup } = makeSandbox({ "a.ts": "x" });
    try {
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd })) {
        entries.push(e);
      }
      expect(entries[0]?.mtime).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("recordMtimes: true populates non-zero mtime", async () => {
    const { cwd, cleanup } = makeSandbox({ "a.ts": "x" });
    try {
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd, recordMtimes: true })) {
        entries.push(e);
      }
      expect(entries[0]?.mtime).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — time budget", () => {
  test("minDepth guarantee: files at depth <= minDepth yield even with budget=0", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
    });
    try {
      let now = 0;
      const files = await collect({
        cwd,
        minDepth: 2,
        timeBudgetMs: 0,
        clock: () => {
          const current = now;
          now += 1;
          return current;
        },
      });
      // `a.ts` is depth 1, `src/b.ts` is depth 2 — both within minDepth
      // so they yield regardless of budget. `src/deep/c.ts` at depth 3
      // is beyond minDepth and the 0ms budget kills the descent.
      expect(files.includes("a.ts")).toBe(true);
      expect(files.includes("src/b.ts")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("budget truncates beyond minDepth", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
      "src/deep/deeper/d.ts": "w",
    });
    try {
      let now = 0;
      const files = await collect({
        cwd,
        minDepth: 1,
        timeBudgetMs: 0,
        // Advance the clock a lot after the first read so budget is
        // definitely blown before going beyond depth 1.
        clock: () => {
          now += 100;
          return now;
        },
      });
      // Once minDepth==1 completes, the walker bails before descending
      // into src/deep/ and src/deep/deeper/. `src/b.ts` is at depth 2
      // but comes from opening src/ (depth 1). `src/deep` itself is a
      // directory at depth 2 — we won't descend past it.
      expect(files.includes("a.ts")).toBe(true);
      expect(files.includes("src/b.ts")).toBe(true);
      expect(files.includes("src/deep/c.ts")).toBe(false);
      expect(files.includes("src/deep/deeper/d.ts")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — AbortSignal", () => {
  test("aborting mid-walk throws AbortError on next advance", async () => {
    // Use a deep tree so the iteration has somewhere to run.
    const layout: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      layout[`dir${i}/file.ts`] = "x";
    }
    const { cwd, cleanup } = makeSandbox(layout);
    try {
      const controller = new AbortController();
      const iter = walkFiles({ cwd, signal: controller.signal });
      let yields = 0;
      let threw: unknown = null;
      try {
        for await (const _ of iter) {
          yields += 1;
          if (yields === 2) {
            controller.abort();
          }
        }
      } catch (error) {
        threw = error;
      }
      expect(yields).toBeGreaterThanOrEqual(2);
      expect(threw).toBeInstanceOf(DOMException);
      expect((threw as DOMException).name).toBe("AbortError");
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — descentHook", () => {
  test("default: linear depth counting", async () => {
    const { cwd, cleanup } = makeSandbox({
      "packages/foo/src/deep/a.ts": "x",
    });
    try {
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd })) {
        entries.push(e);
      }
      const deep = entries.find(
        (e) => e.relativePath === "packages/foo/src/deep/a.ts"
      );
      // 5 path segments → file depth 5.
      expect(deep?.depth).toBe(5);
    } finally {
      cleanup();
    }
  });

  test("custom descentHook resets depth at monorepo package dirs", async () => {
    const { cwd, cleanup } = makeSandbox({
      "packages/foo/src/deep/a.ts": "x",
      "packages/bar/src/deep/b.ts": "y",
      "root.ts": "z",
    });
    try {
      // Reset to 0 on "packages/<pkg>" boundaries; otherwise linear.
      const descentHook = (relPath: string, currentDepth: number) => {
        const segs = relPath.split("/");
        if (segs.length === 2 && segs[0] === "packages") {
          return 0;
        }
        return currentDepth + 1;
      };
      const entries: WalkEntry[] = [];
      for await (const e of walkFiles({ cwd, descentHook })) {
        entries.push(e);
      }
      // packages/foo resets to depth 0; src/ → depth 1 under it,
      // deep/ → depth 2, a.ts (file) → depth 3. Without the reset
      // a.ts would be depth 5 from the repo root.
      const deep = entries.find(
        (e) => e.relativePath === "packages/foo/src/deep/a.ts"
      );
      expect(deep?.depth).toBe(3);
      const root = entries.find((e) => e.relativePath === "root.ts");
      expect(root?.depth).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("maxDepth applies to post-reset depth (descent cap)", async () => {
    const { cwd, cleanup } = makeSandbox({
      "packages/foo/a.ts": "x",
      "packages/foo/deep/b.ts": "y",
      "packages/foo/deep/deeper/c.ts": "z",
      "packages/foo/deep/deeper/more/d.ts": "w",
    });
    try {
      // After reset at packages/foo (depth 0), dirs entered at:
      //   packages/foo/ = 0
      //   packages/foo/deep = 1
      //   packages/foo/deep/deeper = 2 (entered)
      //   packages/foo/deep/deeper/more = 3 (NOT entered, > maxDepth=2)
      // Files yielded: a.ts (inside foo), b.ts (inside deep), c.ts
      // (inside deeper). d.ts skipped because `more` never entered.
      const descentHook = (relPath: string, currentDepth: number) => {
        const segs = relPath.split("/");
        if (segs.length === 2 && segs[0] === "packages") {
          return 0;
        }
        return currentDepth + 1;
      };
      const files = await collect({ cwd, descentHook, maxDepth: 2 });
      expect(files.includes("packages/foo/a.ts")).toBe(true);
      expect(files.includes("packages/foo/deep/b.ts")).toBe(true);
      expect(files.includes("packages/foo/deep/deeper/c.ts")).toBe(true);
      expect(files.includes("packages/foo/deep/deeper/more/d.ts")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — onDirectoryVisit hook", () => {
  test("fires once per visited directory with a floored mtime", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "src/b.ts": "y",
      "src/deep/c.ts": "z",
    });
    try {
      const visits: Array<{ absDir: string; mtimeMs: number }> = [];
      for await (const _ of walkFiles({
        cwd,
        onDirectoryVisit: (absDir, mtimeMs) => {
          visits.push({ absDir, mtimeMs });
        },
      })) {
        // drain
      }
      // cwd + src + src/deep = 3 directory visits (node_modules / .git
      // aren't created by the sandbox helper, so no spurious hits).
      const dirs = visits.map((v) => v.absDir).sort();
      expect(dirs).toEqual([cwd, join(cwd, "src"), join(cwd, "src", "deep")]);
      for (const v of visits) {
        expect(Number.isInteger(v.mtimeMs)).toBe(true);
        expect(v.mtimeMs).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });

  test("not called when unset (zero cost for non-DSN callers)", async () => {
    const { cwd, cleanup } = makeSandbox({ "a.ts": "x" });
    try {
      let yields = 0;
      // With no hook set, the walker must complete normally and yield
      // the file. We can't directly observe "no extra stat" from JS
      // — the contract is "no code path inside the walker should call
      // the hook when opts.onDirectoryVisit is undefined." This test
      // verifies the walk still works; correctness of the zero-cost
      // path is covered by the above test (which DOES set the hook).
      for await (const _ of walkFiles({ cwd })) {
        yields += 1;
      }
      expect(yields).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — nested .gitignore loading", () => {
  test("nested patterns apply to their subtree; siblings without .gitignore unaffected", async () => {
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "",
      "a/file1.ts": "x",
      "a/.gitignore": "ignored.ts\n",
      "a/ignored.ts": "y", // skipped by a/.gitignore
      "b/file2.ts": "z", // b has no .gitignore — yields normally
      "c/file3.ts": "w",
      "c/.gitignore": "*.log\n",
      "c/foo.log": "v", // skipped by c/.gitignore
    });
    try {
      const files = await collect({ cwd });
      expect(files.includes("a/file1.ts")).toBe(true);
      expect(files.includes("a/ignored.ts")).toBe(false);
      expect(files.includes("b/file2.ts")).toBe(true);
      expect(files.includes("c/file3.ts")).toBe(true);
      expect(files.includes("c/foo.log")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("nested gitignore in a dir without one higher up still applies", async () => {
    const { cwd, cleanup } = makeSandbox({
      "deep/sub/.gitignore": "secret.ts\n",
      "deep/sub/secret.ts": "x",
      "deep/sub/ok.ts": "y",
    });
    try {
      const files = await collect({ cwd });
      expect(files.includes("deep/sub/ok.ts")).toBe(true);
      expect(files.includes("deep/sub/secret.ts")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("disabling nestedGitignore skips nested files", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a/.gitignore": "ignored.ts\n",
      "a/ignored.ts": "x",
      "a/ok.ts": "y",
    });
    try {
      const files = await collect({ cwd, nestedGitignore: false });
      // With nested disabled, the `a/.gitignore` is never read, so
      // `a/ignored.ts` yields.
      expect(files.includes("a/ignored.ts")).toBe(true);
      expect(files.includes("a/ok.ts")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — followSymlinks", () => {
  test("skips symlinks by default (followSymlinks: false)", async () => {
    const { cwd, cleanup } = makeSandbox({
      "real-dir/inside.ts": "x",
      "real-file.ts": "y",
    });
    try {
      symlinkSync(join(cwd, "real-dir"), join(cwd, "link-dir"));
      symlinkSync(join(cwd, "real-file.ts"), join(cwd, "link-file.ts"));
      const files = await collect({ cwd });
      expect(files.sort()).toEqual(["real-dir/inside.ts", "real-file.ts"]);
    } finally {
      cleanup();
    }
  });

  test("followSymlinks: true follows symlinked files and dirs", async () => {
    const { cwd, cleanup } = makeSandbox({
      "aaa-real/inside.ts": "x",
      "real-file.ts": "y",
    });
    try {
      // Alphabetical order means `aaa-real` is visited first, so the
      // real path claims the inode and subsequent symlinks to the
      // same inode are skipped by cycle detection.
      symlinkSync(join(cwd, "aaa-real"), join(cwd, "zzz-link"));
      symlinkSync(join(cwd, "real-file.ts"), join(cwd, "link-file.ts"));
      const files = await collect({ cwd, followSymlinks: true });
      // Real dir's files yield; symlinked file also yields (different
      // inode as a file is a different dentry).
      expect(files.includes("aaa-real/inside.ts")).toBe(true);
      expect(files.includes("real-file.ts")).toBe(true);
      expect(files.includes("link-file.ts")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("followSymlinks: true breaks circular symlinks via inode detection", async () => {
    const { cwd, cleanup } = makeSandbox({
      "inner/x.ts": "hello",
    });
    try {
      // Create a cycle: inner/back -> cwd
      symlinkSync(cwd, join(cwd, "inner", "back"));
      const files = await collect({ cwd, followSymlinks: true });
      // If the cycle weren't broken, we'd loop infinitely. Bounded
      // result proves the inodeKey guard fires.
      expect(files.length).toBeLessThan(20);
      expect(files.includes("inner/x.ts")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("broken symlink is silently skipped", async () => {
    const { cwd, cleanup } = makeSandbox({ "real.ts": "hi" });
    try {
      symlinkSync(join(cwd, "nonexistent"), join(cwd, "broken.ts"));
      const files = await collect({ cwd, followSymlinks: true });
      expect(files).toEqual(["real.ts"]);
    } finally {
      cleanup();
    }
  });

  test("followSymlinks: true does not re-list the tree via a symlink to the scan root", async () => {
    const { cwd, cleanup } = makeSandbox({
      "top.ts": "a",
      "sub/nested.ts": "b",
    });
    try {
      // A symlink pointing back at the scan root. The root frame is pushed
      // directly (not via maybeDescend), so unless its inode is seeded into
      // the visited set the walker would re-list the whole tree under
      // `sub/root-link/...`. Asserting the exact set guards that seeding.
      symlinkSync(cwd, join(cwd, "sub", "root-link"));
      const files = await collect({ cwd, followSymlinks: true });
      expect(files.sort()).toEqual(["sub/nested.ts", "top.ts"]);
    } finally {
      cleanup();
    }
  });
});

describe("walkFiles — parallel walker (concurrency > 1)", () => {
  test("yields the same set of files as the serial walker", async () => {
    // Build a non-trivial tree so parallelism actually exercises
    // the worker pool.
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "apps/web/index.ts": "x",
      "apps/web/src/a.ts": "x",
      "apps/web/src/deep/b.ts": "x",
      "libs/core/index.ts": "x",
      "libs/core/src/c.ts": "x",
      "libs/ui/button.ts": "x",
      "services/api/server.ts": "x",
      "services/api/routes/users.ts": "x",
    });
    try {
      const serial = await collect({ cwd, concurrency: 1 });
      const parallel = await collect({ cwd, concurrency: 4 });
      expect(parallel).toEqual(serial);
    } finally {
      cleanup();
    }
  });

  test("honors gitignore rules across concurrent descents", async () => {
    // Root `.gitignore` excludes `ignored/` and `*.log` globally.
    // Nested `libs/.gitignore` adds `extra-noise.txt` — a rule not
    // reachable from the root — to prove nested gitignore loads
    // under concurrent traversal.
    const { cwd, cleanup } = makeSandbox({
      ".gitignore": "ignored/\n*.log\n",
      "src/a.ts": "x",
      "src/b.log": "noise",
      "src/nested/c.ts": "x",
      "ignored/d.ts": "skip",
      "libs/e.ts": "x",
      "libs/.gitignore": "extra-noise.txt\n",
      "libs/extra-noise.txt": "skip",
      "libs/f.ts": "x",
    });
    try {
      const parallel = await collect({ cwd, concurrency: 4, hidden: true });
      expect(parallel.filter((p) => !p.endsWith(".gitignore"))).toEqual([
        "libs/e.ts",
        "libs/f.ts",
        "src/a.ts",
        "src/nested/c.ts",
      ]);
    } finally {
      cleanup();
    }
  });

  test("honors descentHook under concurrent traversal", async () => {
    // maxDepth: 1 + hook that resets depth at packages/*. Without
    // the reset, packages/p would be depth 1 so its src/ would be
    // skipped. With the reset, packages/p starts at depth 0, and
    // its src reaches depth 1 (max) — inner.ts yields.
    const { cwd, cleanup } = makeSandbox({
      "packages/p/src/inner.ts": "x",
      "shallow.ts": "x",
      "deep/deeper/too-deep.ts": "x",
    });
    try {
      const files = await collect({
        cwd,
        concurrency: 4,
        maxDepth: 1,
        descentHook: (rel, depth) =>
          /^packages\/[^/]+$/u.test(rel) ? 0 : depth + 1,
      });
      // `shallow.ts` (depth 1) yields; `deep/deeper/too-deep.ts` is
      // at depth 3 so it's excluded; `packages/p/src/inner.ts`
      // yields because the hook resets packages/p to depth 0.
      expect(files.sort()).toEqual(["packages/p/src/inner.ts", "shallow.ts"]);
    } finally {
      cleanup();
    }
  });

  test("aborts mid-walk when signal fires", async () => {
    const { cwd, cleanup } = makeSandbox({
      "a/1.ts": "x",
      "b/1.ts": "x",
      "c/1.ts": "x",
      "d/1.ts": "x",
      "e/1.ts": "x",
    });
    const ctrl = new AbortController();
    try {
      const drain = async (): Promise<number> => {
        const iter = walkFiles({ cwd, concurrency: 4, signal: ctrl.signal });
        let n = 0;
        for await (const _ of iter) {
          n += 1;
          if (n === 1) {
            ctrl.abort();
          }
        }
        return n;
      };
      await expect(drain()).rejects.toThrow(/abort/i);
    } finally {
      cleanup();
    }
  });

  test("propagates a pre-fired abort through the parallel walker", async () => {
    // Regression: a pre-fired signal must throw immediately instead
    // of hanging. The bug was that `checkAborted` threw outside the
    // worker's try/catch, so `producerError` was never set and the
    // consumer parked on `consumerAwake` forever.
    const { cwd, cleanup } = makeSandbox({
      "f.ts": "x",
      "a/g.ts": "x",
      "a/b/h.ts": "x",
    });
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      const drain = async () => {
        for await (const _ of walkFiles({
          cwd,
          concurrency: 4,
          signal: ctrl.signal,
        })) {
          /* drain */
        }
      };
      // 2s ceiling — the bug manifested as an indefinite hang. With
      // the fix, the throw propagates in ~10ms.
      const watchdog = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("timed out")), 2000)
      );
      await expect(Promise.race([drain(), watchdog])).rejects.toThrow(/abort/i);
    } finally {
      cleanup();
    }
  });

  test("clamps pathological concurrency values instead of hanging", async () => {
    // Regression: `concurrency: NaN` previously passed through
    // `Math.max(1, NaN) = NaN`, so the dispatch routed to the
    // parallel walker, which spawned zero workers (`i < NaN` is
    // always false) but left the consumer parked on
    // `consumerAwake` forever. `normalizeConcurrency` now clamps
    // every non-finite / sub-1 value to the default.
    const { cwd, cleanup } = makeSandbox({
      "a.ts": "x",
      "b/c.ts": "y",
    });
    try {
      // All of these should route cleanly — either serial or the
      // default parallel — and yield the same set of files.
      for (const conc of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5]) {
        const files = await collect({ cwd, concurrency: conc });
        expect(files).toEqual(["a.ts", "b/c.ts"]);
      }
    } finally {
      cleanup();
    }
  });
});
