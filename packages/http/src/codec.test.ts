import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type BodyEncoding,
  createBodyCodec,
  MIN_COMPRESSED_BYTES,
  type ZlibRuntime,
} from "./codec.js";

const encoder = new TextEncoder();

/** A Node.js runtime before 22.15, which has brotli but no zstd. */
const zlibWithoutZstd: ZlibRuntime = {
  constants: zlib.constants,
  brotliCompress: zlib.brotliCompress,
  brotliDecompress: zlib.brotliDecompress,
};

/** An issue-list-like JSON body, well above the compression threshold. */
function issueListBody(): Uint8Array {
  const issues = Array.from({ length: 50 }, (_, i) => ({
    id: String(4_000_000 + i),
    shortId: `WEB-${i}`,
    title: `TypeError: Cannot read properties of undefined (reading 'id')`,
    culprit: "app/components/issueList.tsx in renderRow",
    status: "unresolved",
    count: String(i * 17),
  }));
  return encoder.encode(JSON.stringify(issues));
}

describe("createBodyCodec", () => {
  it("stores bodies with zstd where the runtime has it", async () => {
    const codec = createBodyCodec();
    const raw = issueListBody();
    const encoded = await codec.encode(raw);

    expect(encoded.encoding).toBe("zstd");
    expect(encoded.rawSize).toBe(raw.byteLength);
    expect(encoded.bytes.byteLength).toBeLessThan(raw.byteLength / 4);
    expect(await codec.decode(encoded)).toEqual(raw);
  });

  it("stores bodies below the threshold uncompressed", async () => {
    const codec = createBodyCodec();
    const raw = encoder.encode('{"detail":"ok"}');
    expect(raw.byteLength).toBeLessThan(MIN_COMPRESSED_BYTES);

    const encoded = await codec.encode(raw);

    expect(encoded).toEqual({
      bytes: raw,
      encoding: "identity",
      rawSize: raw.byteLength,
    });
    expect(await codec.decode(encoded)).toEqual(raw);
  });

  describe("without zstd", () => {
    it("falls back to brotli and still round-trips", async () => {
      const codec = createBodyCodec(zlibWithoutZstd);
      const raw = issueListBody();
      const encoded = await codec.encode(raw);

      expect(encoded.encoding).toBe("br");
      expect(await codec.decode(encoded)).toEqual(raw);
    });

    it("treats zstd entries from a newer runtime as unreadable, not as errors", async () => {
      const entry = await createBodyCodec().encode(issueListBody());

      expect(await createBodyCodec(zlibWithoutZstd).decode(entry)).toBe(
        undefined,
      );
    });
  });

  it("reads brotli entries after the runtime gains zstd", async () => {
    const raw = issueListBody();
    const entry = await createBodyCodec(zlibWithoutZstd).encode(raw);

    expect(await createBodyCodec().decode(entry)).toEqual(raw);
  });

  it("skips entries that need a dictionary or an unknown encoding", async () => {
    const codec = createBodyCodec();
    const entry = await codec.encode(issueListBody());

    expect(await codec.decode({ ...entry, dictId: "v1" })).toBe(undefined);
    expect(
      await codec.decode({ ...entry, encoding: "lz4" as BodyEncoding }),
    ).toBe(undefined);
  });

  it("rejects bytes that do not decode to the recorded size", async () => {
    const codec = createBodyCodec();
    const entry = await codec.encode(issueListBody());

    await expect(
      codec.decode({ ...entry, rawSize: entry.rawSize - 1 }),
    ).rejects.toThrow();
    await expect(
      codec.decode({ ...entry, rawSize: entry.rawSize + 1 }),
    ).rejects.toThrow(/expected/);
    await expect(
      codec.decode({ ...entry, bytes: entry.bytes.subarray(0, 8) }),
    ).rejects.toThrow();
  });
});
