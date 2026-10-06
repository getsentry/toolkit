/**
 * Tests for ProGuard upload infrastructure.
 *
 * Tests the raw-byte chunking used by the DIF upload protocol.
 * ProGuard mappings are chunked as raw bytes (no ZIP wrapping).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashBuffer } from "../../../src/lib/api/chunk-upload.js";
import { apiRequestToRegion } from "../../../src/lib/api/infrastructure.js";
import { uploadProguardMappings } from "../../../src/lib/api/proguard.js";

vi.mock("../../../src/lib/api/infrastructure.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/api/infrastructure.js")
    >();
  return { ...actual, apiRequestToRegion: vi.fn() };
});
vi.mock("../../../src/lib/region.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/region.js")>();
  return {
    ...actual,
    resolveOrgRegion: vi.fn(async () => "https://us.sentry.io"),
  };
});

const apiMock = vi.mocked(apiRequestToRegion);

describe("hashBuffer", () => {
  test("single chunk for small content", () => {
    const content = Buffer.from("void\n");
    const { chunks, overallChecksum } = hashBuffer(content, 8192);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[0]?.size).toBe(5);
    expect(chunks[0]?.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(overallChecksum).toMatch(/^[0-9a-f]{40}$/);
    // Single chunk: chunk sha1 === overall checksum
    expect(chunks[0]?.sha1).toBe(overallChecksum);
  });

  test("splits into multiple chunks when content exceeds chunkSize", () => {
    const content = Buffer.alloc(100, "a");
    const { chunks, overallChecksum } = hashBuffer(content, 30);

    // 100 bytes / 30 per chunk = 4 chunks (30 + 30 + 30 + 10)
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[0]?.size).toBe(30);
    expect(chunks[1]?.offset).toBe(30);
    expect(chunks[1]?.size).toBe(30);
    expect(chunks[2]?.offset).toBe(60);
    expect(chunks[2]?.size).toBe(30);
    expect(chunks[3]?.offset).toBe(90);
    expect(chunks[3]?.size).toBe(10);
    expect(overallChecksum).toMatch(/^[0-9a-f]{40}$/);
  });

  test("overall checksum is deterministic", () => {
    const content = Buffer.from("com.example.MyClass -> a:\n");
    const result1 = hashBuffer(content, 8192);
    const result2 = hashBuffer(content, 8192);

    expect(result1.overallChecksum).toBe(result2.overallChecksum);
    expect(result1.chunks).toHaveLength(result2.chunks.length);
  });

  test("different content yields different checksums", () => {
    const content1 = Buffer.from("mapping one\n");
    const content2 = Buffer.from("mapping two\n");
    const result1 = hashBuffer(content1, 8192);
    const result2 = hashBuffer(content2, 8192);

    expect(result1.overallChecksum).not.toBe(result2.overallChecksum);
  });

  test("chunk SHA-1 checksums are valid hex strings", () => {
    const content = Buffer.alloc(200, "x");
    const { chunks } = hashBuffer(content, 50);

    for (const chunk of chunks) {
      expect(chunk.sha1).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("empty buffer yields no chunks", () => {
    const content = Buffer.alloc(0);
    const { chunks, overallChecksum } = hashBuffer(content, 8192);

    expect(chunks).toHaveLength(0);
    expect(overallChecksum).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("uploadProguardMappings", () => {
  const CHUNK_UPLOAD_OPTIONS = {
    url: "https://us.sentry.io/api/0/chunk-upload/",
    chunkSize: 8192,
    chunksPerRequest: 64,
    maxRequestSize: 1_048_576,
    hashAlgorithm: "sha1",
    concurrency: 8,
    compression: ["gzip"],
  };

  beforeEach(() => {
    apiMock.mockReset();
  });

  test("assemble request names each mapping with a leading-slash /proguard/ path", async () => {
    let assembleBody: Record<string, { name: string; chunks: string[] }> = {};

    apiMock.mockImplementation(
      async (_regionUrl, endpoint, options?: { body?: unknown }) => {
        if (endpoint.includes("chunk-upload/")) {
          return { data: CHUNK_UPLOAD_OPTIONS } as never;
        }
        // DIF assemble endpoint: report every checksum as already "ok" so the
        // upload short-circuits without needing to mock chunk uploads too.
        assembleBody = options?.body as typeof assembleBody;
        const response: Record<string, { state: string }> = {};
        for (const checksum of Object.keys(assembleBody)) {
          response[checksum] = { state: "ok" };
        }
        return { data: response } as never;
      }
    );

    await uploadProguardMappings({
      org: "test-org",
      project: "test-project",
      mappings: [
        {
          path: "mapping.txt",
          uuid: "5db7294d-87fc-5726-a5c0-4a90679657a5",
          content: Buffer.from("void\n"),
        },
      ],
    });

    const [entry] = Object.values(assembleBody);
    // Leading slash required for the server to recognize the DIF as proguard.
    expect(entry?.name).toBe(
      "/proguard/5db7294d-87fc-5726-a5c0-4a90679657a5.txt"
    );
  });
});
