/**
 * DeterministicZipWriter compatibility tests for Node.js versions without
 * `zlib.crc32`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { expect, test, vi } from "vitest";

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const withoutCrc32 = { ...actual, crc32: undefined };
  return { ...withoutCrc32, default: withoutCrc32 };
});

// Import after the mock so crc32.ts selects its portable implementation.
import { DeterministicZipWriter } from "../../../src/lib/build/zip-writer.js";

test("writes valid CRCs when zlib.crc32 is unavailable", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "zip-writer-no-crc32-"));
  try {
    const outputPath = join(tmpDir, "bundle.zip");
    const sourcePath = join(tmpDir, "source.bin");
    await writeFile(sourcePath, Buffer.from("streamed contents"));

    const zip = await DeterministicZipWriter.create(outputPath);
    await zip.addData("memory.txt", Buffer.from("in-memory contents"));
    await zip.addFile("streamed.txt", sourcePath);
    await zip.finalize();

    const entries = unzipSync(await readFile(outputPath));
    expect(Buffer.from(entries["memory.txt"])).toEqual(
      Buffer.from("in-memory contents"),
    );
    expect(Buffer.from(entries["streamed.txt"])).toEqual(
      Buffer.from("streamed contents"),
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
