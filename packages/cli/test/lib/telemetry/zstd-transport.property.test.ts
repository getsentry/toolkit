/**
 * Property tests for the zstd transport's compression pipeline.
 *
 * Exercises our actual `normalizeBody` + `maybeCompress` helpers (not
 * just `Bun.zstdCompress` directly) so we verify the real wire path
 * round-trips for arbitrary inputs.
 *
 * Properties under test:
 *   1. zstd-encoded compress → decompress round-trips for any byte sequence.
 *   2. gzip-encoded compress → gunzip round-trips for any byte sequence.
 *   3. UTF-8 string and equivalent `Uint8Array` inputs produce identical
 *      wire bytes when fed through `normalizeBody` + `maybeCompress`.
 *      (This validates our string-vs-bytes normalization, not Bun's
 *      determinism.)
 *   4. Sub-threshold inputs are passthrough — `payload === buf` and
 *      `encodingApplied === "none"`.
 */

import { promisify } from "node:util";
import { gunzipSync, zstdDecompress } from "node:zlib";
import {
  asyncProperty,
  assert as fcAssert,
  property,
  string,
  uint8Array,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  maybeCompress,
  normalizeBody,
} from "../../../src/lib/telemetry/zstd-transport.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const ZSTD_THRESHOLD = 1024;
const GZIP_THRESHOLD = 32 * 1024;

describe("property: maybeCompress round-trip (zstd path)", () => {
  test("zstd compress → decompress returns the original bytes", async () => {
    await fcAssert(
      asyncProperty(
        uint8Array({ minLength: ZSTD_THRESHOLD + 1, maxLength: 64 * 1024 }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const result = await maybeCompress(buf, "zstd");
          expect(result.encodingApplied).toBe("zstd");
          const decompressed = await promisify(zstdDecompress)(result.payload);
          expect(Buffer.from(decompressed).equals(buf)).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: maybeCompress round-trip (gzip path)", () => {
  test("gzip compress → gunzip returns the original bytes", async () => {
    await fcAssert(
      asyncProperty(
        uint8Array({ minLength: GZIP_THRESHOLD + 1, maxLength: 96 * 1024 }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const result = await maybeCompress(buf, "gzip");
          expect(result.encodingApplied).toBe("gzip");
          expect(gunzipSync(result.payload).equals(buf)).toBe(true);
        }
      ),
      { numRuns: 25 } // gzip on 96 KiB is slower; fewer runs
    );
  });
});

describe("property: normalizeBody string/Uint8Array equivalence", () => {
  test("string and TextEncoder-encoded bytes normalize to identical Buffers", () => {
    fcAssert(
      property(string({ minLength: 0, maxLength: 16 * 1024 }), (s) => {
        const fromString = normalizeBody(s);
        const fromBytes = normalizeBody(new TextEncoder().encode(s));
        expect(fromString.equals(fromBytes)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("string input through full compress pipeline matches bytes input", async () => {
    await fcAssert(
      asyncProperty(
        string({ minLength: ZSTD_THRESHOLD + 1, maxLength: 16 * 1024 }),
        async (s) => {
          const fromString = await maybeCompress(normalizeBody(s), "zstd");
          const fromBytes = await maybeCompress(
            normalizeBody(new TextEncoder().encode(s)),
            "zstd"
          );
          expect(fromString.encodingApplied).toBe(fromBytes.encodingApplied);
          expect(fromString.payload.equals(fromBytes.payload)).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: maybeCompress passthrough below threshold", () => {
  test('zstd encoding + body ≤ 1 KiB → encodingApplied="none", payload === buf', async () => {
    await fcAssert(
      asyncProperty(
        uint8Array({ minLength: 0, maxLength: ZSTD_THRESHOLD }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const result = await maybeCompress(buf, "zstd");
          expect(result.encodingApplied).toBe("none");
          expect(result.payload).toBe(buf);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test('gzip encoding + body ≤ 32 KiB → encodingApplied="none", payload === buf', async () => {
    await fcAssert(
      asyncProperty(
        uint8Array({ minLength: 0, maxLength: GZIP_THRESHOLD }),
        async (bytes) => {
          const buf = Buffer.from(bytes);
          const result = await maybeCompress(buf, "gzip");
          expect(result.encodingApplied).toBe("none");
          expect(result.payload).toBe(buf);
        }
      ),
      { numRuns: 25 } // 32 KiB arbitrary alloc is slower; fewer runs
    );
  });
});
