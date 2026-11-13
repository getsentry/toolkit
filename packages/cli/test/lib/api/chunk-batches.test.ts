/**
 * Unit tests for batched chunk uploads: how chunks are grouped into requests
 * against the server's limits, and that one request carries a whole batch.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.hoisted(() =>
  vi.fn(async () => new Response(null, { status: 200 })),
);
const getSdkConfigMock = vi.hoisted(() =>
  vi.fn((_regionUrl: string, _options?: unknown) => ({ fetch: fetchMock })),
);

vi.mock("../../../src/lib/sentry-client.js", () => ({
  getSdkConfig: getSdkConfigMock,
  getApiBaseUrl: () => "https://sentry.io",
}));

const http1Dispatcher = vi.hoisted(() => ({
  destroy: () => Promise.resolve(),
}));
const destroyHttp1DispatcherMock = vi.hoisted(() =>
  vi.fn(async (_dispatcher: unknown) => {}),
);

vi.mock("../../../src/lib/http1-dispatcher.js", () => ({
  createHttp1Dispatcher: () => http1Dispatcher,
  destroyHttp1Dispatcher: destroyHttp1DispatcherMock,
}));

import {
  batchChunkPayloads,
  CHUNK_UPLOAD_TIMEOUT_MS,
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
  getSdkConfigMock.mockClear();
  destroyHttp1DispatcherMock.mockClear();
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

  test("uploads through a retrying HTTP/1.1 fetch with the chunk-upload timeout", async () => {
    await uploadChunkPayloads({
      chunks: [payload("a", 10)],
      serverOptions: SERVER_OPTIONS,
      encoding: undefined,
      regionUrl: "https://us.sentry.io",
    });

    expect(getSdkConfigMock).toHaveBeenCalledWith("https://us.sentry.io", {
      idempotent: true,
      timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS,
      dispatcher: http1Dispatcher,
    });
    expect(destroyHttp1DispatcherMock).toHaveBeenCalledWith(http1Dispatcher);
  });

  test("gives a failed chunk upload the shared 403 guidance", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: "You do not have permission to perform this action." },
        { status: 403, statusText: "Forbidden" },
      ),
    );

    await expect(
      uploadChunkPayloads({
        chunks: [payload("a", 10)],
        serverOptions: SERVER_OPTIONS,
        encoding: undefined,
        regionUrl: "https://us.sentry.io",
      }),
    ).rejects.toMatchObject({
      message: "Chunk upload failed: 403 Forbidden",
      status: 403,
      enriched403: true,
      detail: expect.stringContaining("may lack the required scope"),
    });
  });

  test("names the network cause when a chunk upload gets no response", async () => {
    const streamReset = Object.assign(
      new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"),
      { code: "ERR_HTTP2_STREAM_ERROR" },
    );
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: streamReset }),
    );

    await expect(
      uploadChunkPayloads({
        chunks: [payload("a", 10)],
        serverOptions: SERVER_OPTIONS,
        encoding: undefined,
        regionUrl: "https://us.sentry.io",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "Chunk upload failed: Network error",
      status: 0,
      detail: expect.stringContaining(
        "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
      ),
    });
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
