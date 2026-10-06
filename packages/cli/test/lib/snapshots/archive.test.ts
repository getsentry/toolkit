/**
 * Tests for streaming snapshot archive extraction, including Zip-Slip protection.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import { extractZipStream } from "../../../src/lib/snapshots/archive.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "snap-extract-"));
  dirs.push(dir);
  return dir;
}

/** Yield a buffer as an async stream, split into fixed-size chunks. */
async function* streamOf(
  buffer: Uint8Array,
  chunkSize = 8
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, offset + chunkSize);
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extractZipStream", () => {
  test("extracts files (incl. nested) and skips directory entries", async () => {
    const zip = zipSync({
      "a.png": strToU8("A"),
      "sub/b.png": strToU8("BB"),
      "emptydir/": new Uint8Array(),
    });
    const out = tempDir();

    const count = await extractZipStream(streamOf(zip), out);

    expect(count).toBe(2);
    expect(readFileSync(join(out, "a.png"), "utf8")).toBe("A");
    expect(readFileSync(join(out, "sub", "b.png"), "utf8")).toBe("BB");
  });

  test("skips traversal, absolute, and empty entries but keeps safe names", async () => {
    const zip = zipSync({
      "../evil.png": strToU8("X"),
      "a/../../evil2.png": strToU8("X"),
      "/etc/evil3.png": strToU8("X"),
      "": strToU8("X"),
      // Legitimate name that merely starts with ".." — must NOT be skipped.
      "..config.png": strToU8("C"),
      "ok.png": strToU8("Y"),
    });
    const out = tempDir();

    const count = await extractZipStream(streamOf(zip), out);

    expect(count).toBe(2); // "..config.png" + "ok.png"
    expect(existsSync(join(out, "ok.png"))).toBe(true);
    expect(readFileSync(join(out, "..config.png"), "utf8")).toBe("C");
    // No traversal entry escaped the output dir.
    expect(existsSync(join(out, "..", "evil.png"))).toBe(false);
    expect(existsSync(join(out, "..", "..", "evil2.png"))).toBe(false);
  });

  test("handles a larger deflated entry split across many chunks", async () => {
    const big = "pixel-data-".repeat(5000);
    const zip = zipSync({ "big.png": strToU8(big) });
    const out = tempDir();

    const count = await extractZipStream(streamOf(zip, 64), out);

    expect(count).toBe(1);
    expect(readFileSync(join(out, "big.png"), "utf8")).toBe(big);
  });

  test("extracts stored (uncompressed, method 0) entries", async () => {
    const body = "A".repeat(4000);
    // level: 0 → STORE, exercising the UnzipPassThrough decoder.
    const zip = zipSync({ "img.png": [strToU8(body), { level: 0 }] });
    const out = tempDir();

    const count = await extractZipStream(streamOf(zip, 128), out);

    expect(count).toBe(1);
    expect(readFileSync(join(out, "img.png"), "utf8")).toBe(body);
  });

  test("surfaces a write error without emitting unhandled rejections", async () => {
    const out = tempDir();
    // Pre-create the entry's destination as a directory → write fails (EISDIR).
    mkdirSync(join(out, "a.png"));
    const zip = zipSync({ "a.png": strToU8("A"), "b.png": strToU8("B") });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(extractZipStream(streamOf(zip), out)).rejects.toThrow();
      // Let any stray microtasks/timers surface a rejection if one leaked.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("propagates a mid-stream source error and cleans up", async () => {
    const out = tempDir();
    const zip = zipSync({ "a.png": strToU8("A".repeat(2000)) });
    // Emit a partial chunk (opening a write stream) then fail, exercising the
    // early-bail cleanup path (skips Promise.all).
    async function* faulty(): AsyncIterable<Uint8Array> {
      yield zip.subarray(0, 40);
      throw new Error("network boom");
    }

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(extractZipStream(faulty(), out)).rejects.toThrow(
        "network boom"
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
