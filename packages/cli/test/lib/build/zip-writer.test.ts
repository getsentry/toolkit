/**
 * Tests for the deterministic streaming ZIP writer.
 *
 * The wrapper output must stay byte-for-byte identical to the previous
 * in-memory `fflate.zipSync(..., { level: 0, mtime, os, attrs })` encoding so
 * chunk dedup across re-uploads is unaffected. These tests pin that parity for
 * both the in-memory ({@link DeterministicZipWriter.addData}) and streamed
 * ({@link DeterministicZipWriter.addFile}) entry paths across the cases the
 * build normalizer relies on: plain files, nested paths, empty entries,
 * multi-byte names, and Unix symlink/permission attributes.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import {
  DeterministicZipWriter,
  FIXED_MTIME,
} from "../../../src/lib/build/zip-writer.js";

type Entry = {
  name: string;
  data: Uint8Array;
  os?: number;
  attrs?: number;
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zip-writer-"));
  tmpDirs.push(dir);
  return dir;
}

/** Reference bytes from fflate's in-memory zipSync (the encoding to match). */
function referenceZip(entries: Entry[]): Buffer {
  const map: Record<string, [Uint8Array, Record<string, unknown>]> = {};
  for (const e of entries) {
    map[e.name] = [
      e.data,
      { level: 0, mtime: FIXED_MTIME, os: e.os, attrs: e.attrs },
    ];
  }
  return Buffer.from(zipSync(map));
}

/** Build a ZIP with the writer using in-memory `addData` for every entry. */
async function writeWithData(entries: Entry[]): Promise<Buffer> {
  const out = join(makeTmpDir(), "out.zip");
  const zip = await DeterministicZipWriter.create(out);
  for (const e of entries) {
    await zip.addData(e.name, e.data, { os: e.os, attrs: e.attrs });
  }
  await zip.finalize();
  return readFileSync(out);
}

/** Build a ZIP with the writer streaming every entry from a source file. */
async function writeWithFiles(entries: Entry[]): Promise<Buffer> {
  const dir = makeTmpDir();
  const out = join(dir, "out.zip");
  const zip = await DeterministicZipWriter.create(out);
  let i = 0;
  for (const e of entries) {
    const src = join(dir, `src-${i++}`);
    writeFileSync(src, Buffer.from(e.data));
    await zip.addFile(e.name, src, { os: e.os, attrs: e.attrs });
  }
  await zip.finalize();
  return readFileSync(out);
}

const cases: Array<[string, Entry[]]> = [
  ["a single plain entry", [{ name: "a.txt", data: strToU8("hello") }]],
  [
    "multiple entries with nested paths",
    [
      { name: "a.txt", data: strToU8("hello") },
      { name: "b/c.txt", data: strToU8("another entry") },
    ],
  ],
  ["an empty entry", [{ name: "empty", data: new Uint8Array(0) }]],
  [
    "a multi-byte (UTF-8) entry name",
    [{ name: "café/naïve.txt", data: strToU8("résumé") }],
  ],
  [
    "a Unix symlink entry (os=3 + mode attrs)",
    [
      {
        name: "link",
        data: strToU8("target/path"),
        os: 3,
        attrs: ((0o120_777 & 0xff_ff) << 16) >>> 0,
      },
    ],
  ],
  [
    "an executable entry (os=3 + mode attrs)",
    [
      {
        name: "bin",
        data: strToU8("ELF"),
        os: 3,
        attrs: ((0o100_755 & 0xff_ff) << 16) >>> 0,
      },
    ],
  ],
  [
    "a larger entry followed by a tiny one",
    [
      { name: "big", data: strToU8("x".repeat(100_000)) },
      { name: "z", data: strToU8("z") },
    ],
  ],
];

describe("DeterministicZipWriter byte-parity with zipSync", () => {
  for (const [label, entries] of cases) {
    test(`addData matches zipSync for ${label}`, async () => {
      expect((await writeWithData(entries)).equals(referenceZip(entries))).toBe(
        true
      );
    });

    test(`addFile matches zipSync for ${label}`, async () => {
      expect(
        (await writeWithFiles(entries)).equals(referenceZip(entries))
      ).toBe(true);
    });
  }
});

describe("DeterministicZipWriter round-trips", () => {
  test("produces an archive fflate can extract", async () => {
    const zip = await writeWithFiles([
      { name: "one.txt", data: strToU8("first") },
      { name: "dir/two.bin", data: strToU8("second value") },
    ]);
    const entries = unzipSync(zip);
    expect(new TextDecoder().decode(entries["one.txt"])).toBe("first");
    expect(new TextDecoder().decode(entries["dir/two.bin"])).toBe(
      "second value"
    );
  });

  test("streams a payload larger than the internal chunk buffer", async () => {
    // 3 MiB exceeds the 1 MiB stream buffer, exercising multi-read CRC + copy.
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) {
      big[i] = i & 0xff;
    }
    const dataZip = await writeWithData([{ name: "big.bin", data: big }]);
    const fileZip = await writeWithFiles([{ name: "big.bin", data: big }]);
    // Both entry paths must agree and extract to the original bytes.
    expect(fileZip.equals(dataZip)).toBe(true);
    expect(Buffer.from(unzipSync(fileZip)["big.bin"]).equals(Buffer.from(big))).toBe(
      true
    );
  });
});
