/**
 * ZipWriter on Node.js versions without `zlib.crc32` (< 20.15 / < 22.2).
 * Kept in a separate file so the node:zlib mock doesn't leak into zip.test.ts.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const withoutCrc32 = { ...actual, crc32: undefined };
  return { ...withoutCrc32, default: withoutCrc32 };
});

// Import AFTER the mock so zip.ts sees a node:zlib without crc32.
import { ZipWriter } from "../../../src/lib/sourcemap/zip.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "zip-no-crc32-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("writes archives with valid CRCs when zlib.crc32 is unavailable", async () => {
  const zipPath = join(tmpDir, "bundle.zip");
  const zip = await ZipWriter.create(zipPath);
  await zip.addEntry("bundle.js", Buffer.from("console.log(1);\n"));
  await zip.addEntry("bundle.js.map", Buffer.from('{"version":3}'));
  await zip.finalize();

  // `unzip -t` recomputes each entry's CRC-32 and fails on a mismatch.
  const proc = spawnSync("unzip", ["-t", zipPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  expect(proc.stderr.toString()).toBe("");
  expect(proc.status).toBe(0);
});
