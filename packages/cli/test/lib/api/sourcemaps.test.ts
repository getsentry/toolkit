import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { safeParse } from "valibot";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildArtifactBundle,
  ChunkServerOptionsSchema,
  DEFAULT_UPLOAD_MAX_WAIT_MS,
  encodeChunk,
  pickUploadEncoding,
  resolveUploadWait,
} from "../../../src/lib/api/sourcemaps.js";

describe("resolveUploadWait", () => {
  test("no flags → do not wait, default cap", () => {
    expect(resolveUploadWait({})).toEqual({
      wait: false,
      maxWaitMs: DEFAULT_UPLOAD_MAX_WAIT_MS,
    });
  });

  test("--wait → wait with default cap", () => {
    expect(resolveUploadWait({ wait: true })).toEqual({
      wait: true,
      maxWaitMs: DEFAULT_UPLOAD_MAX_WAIT_MS,
    });
  });

  test("--wait-for <secs> → wait with a custom cap (enables waiting)", () => {
    expect(resolveUploadWait({ "wait-for": 45 })).toEqual({
      wait: true,
      maxWaitMs: 45_000,
    });
  });

  test.each([
    Number.NaN,
    0,
    -5,
  ])("rejects a non-positive --wait-for (%s)", (value) => {
    expect(() => resolveUploadWait({ "wait-for": value })).toThrow(
      /positive number of seconds/
    );
  });
});

describe("pickUploadEncoding", () => {
  test("prefers zstd when both zstd and gzip are advertised", () => {
    expect(pickUploadEncoding(["gzip", "zstd"])).toBe("zstd");
    expect(pickUploadEncoding(["zstd", "gzip"])).toBe("zstd");
  });

  test("falls back to gzip when zstd is absent", () => {
    expect(pickUploadEncoding(["gzip"])).toBe("gzip");
  });

  test("returns undefined when the server opts out of compression", () => {
    expect(pickUploadEncoding([])).toBeUndefined();
  });

  test("ignores unknown codecs the CLI does not implement", () => {
    expect(pickUploadEncoding(["br", "deflate"])).toBeUndefined();
    expect(pickUploadEncoding(["br", "gzip"])).toBe("gzip");
  });
});

describe("encodeChunk", () => {
  const payload = Buffer.from("hello chunk-upload world".repeat(128));

  test("gzip encoding emits gzip magic bytes and round-trips", async () => {
    const encoded = await encodeChunk(payload, "gzip");
    expect(encoded.byteLength).toBeLessThan(payload.byteLength);
    // gzip magic: 1f 8b
    expect(encoded[0]).toBe(0x1f);
    expect(encoded[1]).toBe(0x8b);
    expect(Buffer.from(gunzipSync(encoded)).equals(payload)).toBe(true);
  });

  test("zstd encoding emits zstd magic bytes and round-trips", async () => {
    const encoded = await encodeChunk(payload, "zstd");
    expect(encoded.byteLength).toBeLessThan(payload.byteLength);
    // zstd magic: 28 b5 2f fd (little-endian 0xFD2FB528)
    expect(encoded[0]).toBe(0x28);
    expect(encoded[1]).toBe(0xb5);
    expect(encoded[2]).toBe(0x2f);
    expect(encoded[3]).toBe(0xfd);
    const decoded = zstdDecompressSync(encoded);
    expect(Buffer.from(decoded).equals(payload)).toBe(true);
  });

  test("returns the input unchanged when no encoding is selected", async () => {
    const encoded = await encodeChunk(payload, undefined);
    // Plain path returns the same buffer, not a copy.
    expect(encoded).toBe(payload);
  });
});

describe("buildArtifactBundle", () => {
  // ZIP local file header format: at offset 8 (LE u16) is the
  // compression method (0 = STORED, 8 = DEFLATE). The CLI prefixes
  // every artifact bundle with an 8-byte SYSB SourceBundle header.
  const SYSB_HEADER_BYTES = 8;
  const LOCAL_HEADER_METHOD_OFFSET = SYSB_HEADER_BYTES + 8;

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bundle-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makePair(): Promise<
    {
      path: string;
      debugId: string;
      type: "minified_source" | "source_map";
      url: string;
      sourcemapFilename?: string;
    }[]
  > {
    const jsPath = join(tmpDir, "app.js");
    const mapPath = join(tmpDir, "app.js.map");
    // Highly redundant content so DEFLATE has work to do — the size
    // assertions below depend on this.
    await writeFile(jsPath, "console.log('hello');\n".repeat(500));
    await writeFile(mapPath, JSON.stringify({ version: 3, sources: [] }));
    return [
      {
        path: jsPath,
        debugId: "00000000-0000-0000-0000-000000000001",
        type: "minified_source" as const,
        url: "~/app.js",
        sourcemapFilename: "app.js.map",
      },
      {
        path: mapPath,
        debugId: "00000000-0000-0000-0000-000000000001",
        type: "source_map" as const,
        url: "~/app.js.map",
      },
    ];
  }

  test("default compression is DEFLATE", async () => {
    const files = await makePair();
    const out = join(tmpDir, "bundle-default.zip");
    await buildArtifactBundle(out, files, { org: "o", project: "p" });

    const bytes = await readFile(out);
    expect(bytes.readUInt16LE(LOCAL_HEADER_METHOD_OFFSET)).toBe(8);
  });

  test("compression: 'stored' writes entries uncompressed", async () => {
    const files = await makePair();
    const out = join(tmpDir, "bundle-stored.zip");
    await buildArtifactBundle(out, files, {
      org: "o",
      project: "p",
      compression: "stored",
    });

    const bytes = await readFile(out);
    expect(bytes.readUInt16LE(LOCAL_HEADER_METHOD_OFFSET)).toBe(0);
  });

  test("uses in-memory content and never reads disk for inline maps", async () => {
    const mapBytes = Buffer.from(
      JSON.stringify({ version: 3, sources: [], mappings: "AAAA" })
    );
    const out = join(tmpDir, "bundle-inline.zip");
    // `path` points at a nonexistent file — must not be read because
    // `content` is provided.
    await buildArtifactBundle(
      out,
      [
        {
          path: join(tmpDir, "does-not-exist.map"),
          content: mapBytes,
          debugId: "00000000-0000-0000-0000-000000000002",
          type: "source_map" as const,
          url: "~/app.js.map",
        },
      ],
      { org: "o", project: "p", compression: "stored" }
    );

    // Build succeeded (no ENOENT) and the STORED archive contains the bytes.
    const bytes = await readFile(out);
    expect(bytes.includes(mapBytes)).toBe(true);
  });

  test("STORED archive is larger than DEFLATE for the same redundant input", async () => {
    const files = await makePair();
    const deflateOut = join(tmpDir, "bundle-deflate.zip");
    const storedOut = join(tmpDir, "bundle-stored-size.zip");
    await buildArtifactBundle(deflateOut, files, { org: "o", project: "p" });
    await buildArtifactBundle(storedOut, files, {
      org: "o",
      project: "p",
      compression: "stored",
    });

    const deflateSize = (await readFile(deflateOut)).length;
    const storedSize = (await readFile(storedOut)).length;
    // Sanity: redundant input should DEFLATE meaningfully smaller than
    // STORED. If this ever fails, either the ZIP layout changed or the
    // payload stopped being compressible.
    expect(storedSize).toBeGreaterThan(deflateSize * 2);
  });
});

describe("ChunkServerOptionsSchema", () => {
  test("accepts compression: [] (server opt-out)", () => {
    const result = safeParse(ChunkServerOptionsSchema, {
      url: "https://example.com/api/0/organizations/o/chunk-upload/",
      chunkSize: 8_388_608,
      chunksPerRequest: 64,
      maxRequestSize: 33_554_432,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts compression with zstd + gzip advertised", () => {
    const result = safeParse(ChunkServerOptionsSchema, {
      url: "https://example.com/api/0/organizations/o/chunk-upload/",
      chunkSize: 8_388_608,
      chunksPerRequest: 64,
      maxRequestSize: 33_554_432,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: ["gzip", "zstd"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(pickUploadEncoding(result.output.compression)).toBe("zstd");
    }
  });
});
