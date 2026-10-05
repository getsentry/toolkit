/**
 * Unit tests for ZIP archive scanning in the DIF scanner.
 *
 * Covers {@link readZipDifEntries} directly (magic/extension detection, the
 * per-entry / cumulative / container size gates, unsupported-compression
 * handling, malformed input) and the end-to-end `prepareDifs` integration
 * (entries found, no nested-archive recursion, `scanZips` toggle, advisory
 * oversized accounting). Archives are built in memory with `fflate.zipSync`
 * (with a header-patching helper for unsupported compression) so no binary
 * fixtures are needed.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildDifFilters,
  prepareDifs,
  scanPaths,
} from "../../../src/lib/dif/scan.js";
import { readZipDifEntries } from "../../../src/lib/dif/zip.js";

/** A minimal, valid Breakpad symbol file with a known debug id. */
const BREAKPAD_FIXTURE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "1000 10 42 1",
  "PUBLIC 2000 0 some_symbol",
].join("\n");

const BREAKPAD_BYTES = new TextEncoder().encode(BREAKPAD_FIXTURE);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-zip-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a ZIP built from `entries` to `name` under the temp dir, return path. */
async function writeZip(
  name: string,
  entries: Record<string, Uint8Array>
): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, zipSync(entries));
  return path;
}

/**
 * Overwrite the 2-byte compression-method field of `targetName` (in both its
 * local file header and central directory record) with `method`, producing an
 * archive fflate cannot inflate for that one entry. Offsets follow the ZIP
 * spec: LFH method @+8 / fnLen @+26 / name @+30; CDH method @+10 / fnLen @+28 /
 * name @+46.
 */
function corruptCompressionMethod(
  zip: Uint8Array,
  targetName: string,
  method: number
): Uint8Array {
  const out = new Uint8Array(zip);
  const target = new TextEncoder().encode(targetName);
  const nameMatchesAt = (start: number): boolean => {
    if (start + target.length > out.length) {
      return false;
    }
    for (let k = 0; k < target.length; k++) {
      if (out[start + k] !== target[k]) {
        return false;
      }
    }
    return true;
  };
  // Little-endian 16-bit read/write via arithmetic (Biome bans bitwise ops).
  const readU16 = (offset: number): number =>
    (out[offset] ?? 0) + (out[offset + 1] ?? 0) * 256;
  const setMethod = (offset: number) => {
    out[offset] = method % 256;
    out[offset + 1] = Math.floor(method / 256) % 256;
  };
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b) {
      continue;
    }
    if (out[i + 2] === 0x03 && out[i + 3] === 0x04) {
      if (readU16(i + 26) === target.length && nameMatchesAt(i + 30)) {
        setMethod(i + 8);
      }
    } else if (
      out[i + 2] === 0x01 &&
      out[i + 3] === 0x02 &&
      readU16(i + 28) === target.length &&
      nameMatchesAt(i + 46)
    ) {
      setMethod(i + 10);
    }
  }
  return out;
}

describe("readZipDifEntries", () => {
  test("returns null for a non-.zip extension", async () => {
    const path = join(tempDir, "data.bin");
    await writeFile(path, zipSync({ "example.sym": BREAKPAD_BYTES }));
    expect(await readZipDifEntries(path)).toBeNull();
  });

  test("returns null for a .zip extension without PK magic", async () => {
    const path = join(tempDir, "notzip.zip");
    await writeFile(path, BREAKPAD_BYTES);
    expect(await readZipDifEntries(path)).toBeNull();
  });

  test("does not treat a source bundle (SYSB header) as a container", async () => {
    // symbolic source bundles (incl. JVM bundles, .src.zip) are a ZIP archive
    // preceded by an 8-byte `SYSB`+version header, so they start with `SYSB`,
    // not `PK`. They must fall through to the DIF parser and upload as-is, never
    // get expanded into their inner source files.
    const path = join(tempDir, "bundle.src.zip");
    const header = new Uint8Array([0x53, 0x59, 0x53, 0x42, 0x02, 0, 0, 0]); // "SYSB" + v2
    const inner = zipSync({ "example.sym": BREAKPAD_BYTES });
    await writeFile(
      path,
      Buffer.concat([Buffer.from(header), Buffer.from(inner)])
    );
    expect(await readZipDifEntries(path)).toBeNull();
  });

  test("returns null for a malformed (truncated) zip", async () => {
    const path = join(tempDir, "broken.zip");
    // Valid local-header magic, then garbage — fflate throws, we skip.
    await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]));
    expect(await readZipDifEntries(path)).toBeNull();
  });

  test("extracts entries, dropping directory placeholders", async () => {
    const path = await writeZip("syms.zip", {
      "dir/": new Uint8Array(0),
      "example.sym": BREAKPAD_BYTES,
    });
    const result = await readZipDifEntries(path);
    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]?.path).toBe(`${path}/example.sym`);
    expect(result?.oversizedCount).toBe(0);
  });

  test("size-gates oversized entries before decompression and counts them", async () => {
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const result = await readZipDifEntries(path, { maxFileSize: 1 });
    expect(result?.entries).toHaveLength(0);
    expect(result?.oversizedCount).toBe(1);
  });

  test("skips an unsupported-compression entry without discarding the archive", async () => {
    // fflate throws on any method other than store/deflate; returning it from
    // the filter would discard the whole archive and its valid siblings. The
    // unsupported entry must be dropped while its sibling DIF still extracts.
    const raw = zipSync(
      { "good.sym": BREAKPAD_BYTES, "bad.bin": new Uint8Array([1, 2, 3, 4]) },
      { level: 0 }
    );
    const path = join(tempDir, "mixed.zip");
    await writeFile(path, corruptCompressionMethod(raw, "bad.bin", 99));
    const result = await readZipDifEntries(path);
    expect(result).not.toBeNull();
    expect(result?.entries.map((e) => e.path)).toEqual([`${path}/good.sym`]);
  });

  test("skips a container whose compressed size exceeds the total budget", async () => {
    // The whole archive is larger than 1 byte, so it is skipped wholesale
    // rather than buffered into memory.
    const path = await writeZip("syms.zip", { "example.sym": BREAKPAD_BYTES });
    expect(await readZipDifEntries(path, { maxTotalSize: 1 })).toBeNull();
  });

  test("caps cumulative extraction via maxTotalSize", async () => {
    // Two highly-compressible entries: the container (compressed) stays under
    // the budget so it is read, but the second entry would push cumulative
    // *uncompressed* extraction past it and is skipped.
    const big = new Uint8Array(10_000);
    const path = await writeZip("syms.zip", { "a.bin": big, "b.bin": big });
    const result = await readZipDifEntries(path, { maxTotalSize: 15_000 });
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]?.path).toBe(`${path}/a.bin`);
  });
});

describe("prepareDifs ZIP scanning", () => {
  test("finds a debug file inside a .zip", async () => {
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const files = await scanPaths([path]);
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({})
    );
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.path).toBe(`${path}/example.sym`);
    expect(oversizedCount).toBe(0);
  });

  test("does not double-count the .zip container itself", async () => {
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const files = await scanPaths([path]);
    const { prepared } = await prepareDifs(files, buildDifFilters({}));
    // Exactly the one entry — the container is never also parsed as a DIF.
    expect(prepared).toHaveLength(1);
  });

  test("does not recurse into nested .zip archives", async () => {
    const inner = zipSync({ "example.sym": BREAKPAD_BYTES });
    const path = await writeZip("outer.zip", { "inner.zip": inner });
    const files = await scanPaths([path]);
    const { prepared } = await prepareDifs(files, buildDifFilters({}));
    // The inner archive is an opaque, non-object entry — its DIF is not found.
    expect(prepared).toHaveLength(0);
  });

  test("scanZips: false ignores entries inside archives", async () => {
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const files = await scanPaths([path]);
    const { prepared } = await prepareDifs(files, buildDifFilters({}), {
      scanZips: false,
    });
    expect(prepared).toHaveLength(0);
  });

  test("oversized zip entries are advisory and do not drive the exit count", async () => {
    // A compressed entry's format is unknown until it is inflated, so an
    // oversized zip entry cannot be attributed to the requested --type the way
    // an on-disk file can. It is skipped (and warned per entry) but must not
    // inflate `oversizedCount`, which gates the command's exit code — otherwise
    // an unrelated large asset inside a .zip would cause a false
    // "all matched files too large" failure.
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const files = await scanPaths([path]);
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({}),
      { maxFileSize: 1 }
    );
    expect(prepared).toHaveLength(0);
    expect(oversizedCount).toBe(0);
  });

  test("falls back to normal parsing for a .zip-named non-archive", async () => {
    // A Breakpad file misnamed `.zip` lacks PK magic, so it is parsed directly.
    const path = join(tempDir, "misnamed.zip");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    const { prepared } = await prepareDifs(files, buildDifFilters({}));
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.path).toBe(path);
  });

  test("applies --type filter to zip entries", async () => {
    const path = await writeZip("syms.zip", {
      "example.sym": BREAKPAD_BYTES,
    });
    const files = await scanPaths([path]);
    // Breakpad entry filtered out by --type elf.
    const elf = await prepareDifs(files, buildDifFilters({ types: ["elf"] }));
    expect(elf.prepared).toHaveLength(0);
    // ...and kept by --type breakpad.
    const bp = await prepareDifs(
      files,
      buildDifFilters({ types: ["breakpad"] })
    );
    expect(bp.prepared).toHaveLength(1);
  });
});
