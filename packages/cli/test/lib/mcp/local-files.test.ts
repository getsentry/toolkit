import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { readLocalFile } from "../../../src/lib/mcp/local-files.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sentry-local-files-"));
}

describe("readLocalFile", () => {
  test("reads a file relative to the root", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "repro.mp4"), Uint8Array.from([1, 2, 3]));

    const file = await readLocalFile("repro.mp4", dir);

    expect(file.name).toBe("repro.mp4");
    expect([...file.data]).toEqual([1, 2, 3]);
  });

  test("reads an absolute path inside the root", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "videos"));
    const path = join(dir, "videos", "clip.webm");
    writeFileSync(path, "x");

    expect((await readLocalFile(path, dir)).name).toBe("clip.webm");
  });

  test("refuses a file outside the root", async () => {
    const root = tempDir();
    const outside = join(tempDir(), "private.mp4");
    writeFileSync(outside, "x");

    await expect(readLocalFile(outside, root)).rejects.toThrow("only files in");
    await expect(readLocalFile(relative(root, outside), root)).rejects.toThrow(
      "only files in",
    );
  });

  test("refuses a symlink inside the root that points outside it", async () => {
    const root = tempDir();
    const outside = join(tempDir(), "private.mp4");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(root, "innocent.mp4"));

    await expect(readLocalFile("innocent.mp4", root)).rejects.toThrow(
      "only files in",
    );
  });

  test("refuses directories", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "videos.mp4"));

    await expect(readLocalFile("videos.mp4", dir)).rejects.toThrow(
      "not a regular file",
    );
  });

  test("fails for a missing file", async () => {
    await expect(readLocalFile("missing.mp4", tempDir())).rejects.toThrow(
      "ENOENT",
    );
  });
});
