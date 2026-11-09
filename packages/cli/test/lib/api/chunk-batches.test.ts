/**
 * Unit tests for batched chunk uploads: how chunks are grouped into requests
 * against the server's limits, and that one request carries a whole batch.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.hoisted(() =>
  vi.fn(async () => new Response(null, { status: 200 })),
);

vi.mock("../../../src/lib/sentry-client.js", () => ({
  getSdkConfig: () => ({ fetch: fetchMock }),
}));

import {
  batchChunkPayloads,
  type ChunkPayload,
  uploadChunkPayloads,
} from "../../../src/lib/api/chunk-upload.js";

const SERVER_OPTIONS = {
  url: "https://us.sentry.io/api/0/chunk-upload/",
  chunkSize: 8192,
  chunksPerRequest: 3,
  maxRequestSize: 100,
  hashAlgorithm: "sha1",
  concurrency: 2,
  compression: [] as string[],
};

function payload(sha1: string, size: number): ChunkPayload {
  return { sha1, data: Buffer.alloc(size, 1) };
}

afterEach(() => {
  fetchMock.mockClear();
});

describe("batchChunkPayloads", () => {
  test("fills a request up to chunksPerRequest", () => {
    const chunks = ["a", "b", "c", "d", "e"].map((id) => payload(id, 10));
    const batches = batchChunkPayloads(chunks, SERVER_OPTIONS);
    expect(batches.map((b) => b.map((c) => c.sha1))).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  test("starts a new request when maxRequestSize would be exceeded", () => {
    const chunks = [payload("a", 60), payload("b", 50), payload("c", 40)];
    const batches = batchChunkPayloads(chunks, SERVER_OPTIONS);
    expect(batches.map((b) => b.map((c) => c.sha1))).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  test("sends an oversized chunk on its own", () => {
    const batches = batchChunkPayloads(
      [payload("big", 500), payload("small", 1)],
      SERVER_OPTIONS,
    );
    expect(batches.map((b) => b.map((c) => c.sha1))).toEqual([
      ["big"],
      ["small"],
    ]);
  });

  test("returns nothing for no chunks", () => {
    expect(batchChunkPayloads([], SERVER_OPTIONS)).toEqual([]);
  });
});

describe("uploadChunkPayloads", () => {
  test("posts one multipart request per batch with one field per chunk", async () => {
    const chunks = ["a", "b", "c", "d"].map((id) => payload(id, 10));

    await uploadChunkPayloads({
      chunks,
      serverOptions: SERVER_OPTIONS,
      encoding: undefined,
      regionUrl: "https://us.sentry.io",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const forms = fetchMock.mock.calls.map(
      (call) => (call as unknown as [string, { body: FormData }])[1].body,
    );
    expect(
      forms.map((f) => f.getAll("file").length).sort((a, b) => a - b),
    ).toEqual([1, 3]);
    const names = forms.flatMap((f) =>
      f.getAll("file").map((entry) => (entry as File).name),
    );
    expect(names.sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("makes no request for no chunks", async () => {
    await uploadChunkPayloads({
      chunks: [],
      serverOptions: SERVER_OPTIONS,
      encoding: undefined,
      regionUrl: "https://us.sentry.io",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
