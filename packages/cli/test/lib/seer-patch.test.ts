/** Real Git/filesystem coverage for local Seer patch application. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applySeerPatches, type SeerPatch } from "../../src/lib/seer-patch.js";
import { useTestConfigDir } from "../helpers.js";

const getDir = useTestConfigDir("seer-patch-");
let repo: string;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function baseline(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repo, path), content);
  }
  git(["add", "."]);
  git([
    "-c",
    "user.name=Audit",
    "-c",
    "user.email=audit@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "test baseline",
  ]);
}

function modify(
  path = "file.txt",
  before = "before",
  after = "after",
): SeerPatch {
  return {
    repo_name: "example/project",
    patch: {
      path,
      type: "M",
      source_file: `a/${path}`,
      target_file: `b/${path}`,
    },
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`,
  };
}

function addition(path: string): SeerPatch {
  return {
    repo_name: "example/project",
    patch: {
      path,
      type: "A",
      source_file: "/dev/null",
      target_file: `b/${path}`,
    },
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+new\n`,
  };
}

beforeEach(async () => {
  repo = join(getDir(), "repo");
  await mkdir(repo);
  git(["init"]);
  git(["config", "core.autocrlf", "false"]);
  git(["remote", "add", "origin", "https://github.com/example/project.git"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applySeerPatches", () => {
  test.each([
    ["Foo.ts", "foo.ts"],
    ["Dir/a.ts", "dir/b.ts"],
    ["caf\u00e9.ts", "cafe\u0301.ts"],
  ])(
    "refuses portable filesystem aliases %s and %s before writing",
    async (first, second) => {
      await baseline({ "file.txt": "before\n" });
      await expect(
        applySeerPatches([addition(first), addition(second)], repo),
      ).rejects.toThrow(/alias/);
      await expect(readFile(join(repo, first))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(repo, second))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.each(["dirty", "untracked"])(
    "preserves an existing %s file that aliases the patch path",
    async (kind) => {
      await baseline(
        kind === "dirty"
          ? { "file.txt": "before\n", "foo.ts": "base\n" }
          : { "file.txt": "before\n" },
      );
      await writeFile(join(repo, "foo.ts"), "local work\n");
      await expect(
        applySeerPatches([modify(), addition("Foo.ts")], repo),
      ).rejects.toThrow(/alias/);
      expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
      expect(await readFile(join(repo, "foo.ts"), "utf8")).toBe("local work\n");
    },
  );

  test("does not write when its deadline expires during validation", async () => {
    await baseline({ "file.txt": "before\n" });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(100);
    await expect(
      applySeerPatches([modify()], repo, { deadline: 50 }),
    ).rejects.toThrow(/timed out/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("does not write when cancelled during filesystem validation", async () => {
    await baseline({ "file.txt": "before\n" });
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    await expect(
      applySeerPatches([modify()], repo, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("applies a whole add/modify/delete batch from a nested cwd and preserves unrelated edits", async () => {
    await baseline({
      "file with spaces.txt": "before\n",
      "remove.txt": "remove\n",
      "unrelated.txt": "base\n",
    });
    await writeFile(join(repo, "unrelated.txt"), "local work\n");
    await mkdir(join(repo, "nested"));
    const added: SeerPatch = {
      repo_name: "example/project",
      patch: {
        path: "new.txt",
        type: "A",
        source_file: "/dev/null",
        target_file: "b/new.txt",
      },
      diff: "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
    };
    const deleted: SeerPatch = {
      repo_name: "example/project",
      patch: {
        path: "remove.txt",
        type: "D",
        source_file: "a/remove.txt",
        target_file: "/dev/null",
      },
      diff: "diff --git a/remove.txt b/remove.txt\ndeleted file mode 100644\n--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove\n",
    };
    expect(
      await applySeerPatches(
        [modify("file with spaces.txt"), added, deleted],
        join(repo, "nested"),
      ),
    ).toEqual({ applied: ["file with spaces.txt", "new.txt", "remove.txt"] });
    expect(await readFile(join(repo, "file with spaces.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(await readFile(join(repo, "new.txt"), "utf8")).toBe("new\n");
    await expect(readFile(join(repo, "remove.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(repo, "unrelated.txt"), "utf8")).toBe(
      "local work\n",
    );
  });

  test("checks every patch before changing any files", async () => {
    await baseline({ "file.txt": "before\n", "other.txt": "before\n" });
    await expect(
      applySeerPatches([modify(), modify("other.txt", "wrong context")], repo),
    ).rejects.toThrow(/cleanly/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(repo, "other.txt"), "utf8")).toBe("before\n");
  });

  test.each(["unstaged", "staged", "untracked", "ignored"])(
    "preserves %s files impacted by a patch",
    async (kind) => {
      await baseline({ "file.txt": "before\n", "other.txt": "before\n" });
      const path =
        kind === "untracked" || kind === "ignored" ? "new.txt" : "other.txt";
      if (kind === "ignored") {
        await writeFile(join(repo, ".gitignore"), "new.txt\n");
      }
      await writeFile(join(repo, path), "local work\n");
      if (kind === "staged") {
        git(["add", path]);
      }
      const conflicting =
        path === "new.txt"
          ? {
              repo_name: "example/project",
              patch: { path, type: "A" as const },
              diff: "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
            }
          : modify(path, "local work");
      await expect(
        applySeerPatches([modify(), conflicting], repo),
      ).rejects.toThrow(/local changes|untracked/);
      expect(await readFile(join(repo, path), "utf8")).toBe("local work\n");
      expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
    },
  );

  test("protects dirty files marked assume-unchanged", async () => {
    await baseline({ "file.txt": "before\n" });
    git(["update-index", "--assume-unchanged", "file.txt"]);
    await writeFile(join(repo, "file.txt"), "local work\n");
    await expect(
      applySeerPatches([modify("file.txt", "local work")], repo),
    ).rejects.toThrow();
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("local work\n");
  });

  test("refuses mismatched repositories before applying a matching patch", async () => {
    await baseline({ "file.txt": "before\n", "other.txt": "before\n" });
    await expect(
      applySeerPatches(
        [modify(), { ...modify("other.txt"), repo_name: "other/project" }],
        repo,
      ),
    ).rejects.toThrow(/repository|repositories/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("accepts matching upstream when origin names a fork", async () => {
    await baseline({ "file.txt": "before\n" });
    git(["remote", "set-url", "origin", "git@github.com:fork/project.git"]);
    git(["remote", "add", "upstream", "git@github.com:example/project.git"]);
    expect(await applySeerPatches([modify()], repo)).toEqual({
      applied: ["file.txt"],
    });
  });

  test("refuses a multi-repository batch even when both repositories match remotes", async () => {
    await baseline({ "file.txt": "before\n", "other.txt": "before\n" });
    git(["remote", "add", "upstream", "git@github.com:upstream/project.git"]);
    await expect(
      applySeerPatches(
        [modify(), { ...modify("other.txt"), repo_name: "upstream/project" }],
        repo,
      ),
    ).rejects.toThrow(/one repository|multi-repository/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(repo, "other.txt"), "utf8")).toBe("before\n");
  });

  test.each([
    "../outside.txt",
    "/outside.txt",
    "C:/outside.txt",
    "C:outside.txt",
    "folder\\outside.txt",
    ".git/config",
    "folder/.GiT/config",
  ])("rejects unsafe metadata path %s before writing", async (path) => {
    await baseline({ "file.txt": "before\n" });
    await expect(
      applySeerPatches([modify(), modify(path)], repo),
    ).rejects.toThrow(/Unsafe/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("rejects diff headers that target a different file than metadata", async () => {
    await baseline({ "file.txt": "before\n", "hidden.txt": "before\n" });
    const misleading = { ...modify(), diff: modify("hidden.txt").diff };
    await expect(applySeerPatches([misleading], repo)).rejects.toThrow(/match/);
    expect(await readFile(join(repo, "hidden.txt"), "utf8")).toBe("before\n");
  });

  test("rejects a second file hidden after the first file's hunks", async () => {
    await baseline({ "file.txt": "before\n", "hidden.txt": "before\n" });
    const hidden = modify("hidden.txt").diff.replace(/^diff --git[^\n]+\n/, "");
    await expect(
      applySeerPatches([{ ...modify(), diff: modify().diff + hidden }], repo),
    ).rejects.toThrow();
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(repo, "hidden.txt"), "utf8")).toBe("before\n");
  });

  test("rejects unsafe diff paths even with benign metadata", async () => {
    await baseline({ "file.txt": "before\n" });
    await expect(
      applySeerPatches(
        [{ ...modify(), diff: modify(".git/config").diff }],
        repo,
      ),
    ).rejects.toThrow(/Unsafe/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("rejects symlink payloads", async () => {
    await baseline({ "file.txt": "before\n" });
    const symlinkPatch: SeerPatch = {
      repo_name: "example/project",
      patch: { path: "link", type: "A" },
      diff: "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/outside\n",
    };
    await expect(
      applySeerPatches([modify(), symlinkPatch], repo),
    ).rejects.toThrow(/symlinks/);
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("rejects paths through a symlink or Windows junction", async () => {
    await baseline({ "file.txt": "before\n" });
    const outside = join(getDir(), "outside");
    await mkdir(outside);
    await writeFile(join(outside, "file.txt"), "before\n");
    await symlink(outside, join(repo, "linked"), "junction");
    await expect(
      applySeerPatches([modify(), modify("linked/file.txt")], repo),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("before\n");
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("before\n");
  });

  test("applies a pure rename with spaces and protects both paths", async () => {
    await baseline({ "old name.txt": "before\n" });
    const renamed: SeerPatch = {
      repo_name: "example/project",
      patch: {
        path: "new name.txt",
        type: "M",
        source_file: "a/old name.txt",
        target_file: "b/new name.txt",
      },
      diff: "diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n",
    };
    expect(await applySeerPatches([renamed], repo)).toEqual({
      applied: ["old name.txt", "new name.txt"],
    });
    expect(await readFile(join(repo, "new name.txt"), "utf8")).toBe("before\n");
    await expect(readFile(join(repo, "old name.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves CRLF content while applying a matching patch", async () => {
    await baseline({ "file.txt": "before\r\n" });
    expect(
      await applySeerPatches([modify("file.txt", "before\r", "after\r")], repo),
    ).toEqual({ applied: ["file.txt"] });
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("after\r\n");
  });

  test("respects Git's Windows CRLF checkout conversion", async () => {
    git(["config", "core.autocrlf", "true"]);
    await baseline({ "file.txt": "before\r\n" });
    expect(await applySeerPatches([modify()], repo)).toEqual({
      applied: ["file.txt"],
    });
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("after\r\n");
    expect(git(["show", ":file.txt"])).toBe("before\n");
  });

  test.each(["source", "target"])(
    "protects a dirty rename %s",
    async (side) => {
      await baseline({ "old.txt": "before\n" });
      const path = side === "source" ? "old.txt" : "new.txt";
      await writeFile(join(repo, path), "local work\n");
      const renamed: SeerPatch = {
        repo_name: "example/project",
        patch: {
          path: "new.txt",
          type: "M",
          source_file: "a/old.txt",
          target_file: "b/new.txt",
        },
        diff: "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
      };
      await expect(applySeerPatches([renamed], repo)).rejects.toThrow(
        /local changes|untracked/,
      );
      expect(await readFile(join(repo, path), "utf8")).toBe("local work\n");
    },
  );
});
