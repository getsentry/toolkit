import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readLocalFile } from "../../../src/lib/mcp/local-files.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sentry-local-files-"));
}

describe("readLocalFile", () => {
  test("reads a file relative to the working directory", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "repro.mp4"), Uint8Array.from([1, 2, 3]));

    const file = await readLocalFile("repro.mp4", dir);

    expect(file.name).toBe("repro.mp4");
    expect([...file.data]).toEqual([1, 2, 3]);
  });

  test("reads an absolute path", async () => {
    const dir = tempDir();
    const path = join(dir, "clip.webm");
    writeFileSync(path, "x");

    expect((await readLocalFile(path, "/")).name).toBe("clip.webm");
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
