import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
import { isFolderInGitignore } from "../../../../src/lib/wizard/react-native/git.js";

// Mock fs module
vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    appendFile: vi.fn(),
  },
}));

describe("git", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isFolderInGitignore", () => {
    test("returns true when ios is in gitignore", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios\nandroid\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true when android is in gitignore", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios\nandroid\n",
      );

      const result = await isFolderInGitignore("android");

      expect(result).toBe(true);
    });

    test("returns true when folder has trailing slash pattern", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios/\nandroid/\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true when folder has leading slash pattern", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\n/ios\nandroid\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true when folder has wildcard pattern", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios/*\nandroid/*\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true with leading and trailing slash pattern", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\n/ios/\nandroid\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true when folder is in gitignore with additional content", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "# Dependencies\nnode_modules\n\n# Native folders\nios\nandroid\n\n# Build\nbuild/\ndist/\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns false when specified folder is not in gitignore", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nandroid\nbuild\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns true when specified folder is in gitignore", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios\nbuild\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns false when gitignore is empty", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue("");

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns false when gitignore contains folder only in comments", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "# ios folder\n# android folder\nnode_modules\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns false when gitignore contains similar names as substrings", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\niosApp\nandroidApp\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns false when gitignore file does not exist", async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns false when fs.promises.readFile throws permission error", async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("EACCES: permission denied"),
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns false when fs.promises.readFile throws any error", async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Unknown error"),
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("handles gitignore with CRLF line endings", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\r\nios\r\nandroid\r\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("handles gitignore with no trailing newline", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nios\nandroid",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("ignores folder name in comments", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\n# ios - native folder\nios\nandroid\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns false when similar folder names exist but not exact match", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nbiosensor\nhumanoid\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(false);
    });

    test("returns true when folder is at the start of gitignore file", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "ios\nandroid\nnode_modules\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("returns true when folder is at the start with trailing slash", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "ios/\nandroid/\nnode_modules\n",
      );

      const result = await isFolderInGitignore("ios");

      expect(result).toBe(true);
    });

    test("works with different folder names", async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "node_modules\nbuild\ndist\n",
      );

      const buildResult = await isFolderInGitignore("build");
      const distResult = await isFolderInGitignore("dist");
      const srcResult = await isFolderInGitignore("src");

      expect(buildResult).toBe(true);
      expect(distResult).toBe(true);
      expect(srcResult).toBe(false);
    });
  });
});
