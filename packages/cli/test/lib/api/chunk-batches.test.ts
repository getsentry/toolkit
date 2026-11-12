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

/** Where undici 8 (Node 26) registers its global dispatcher. */
const GLOBAL_DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");

function payload(sha1: string, size: number): ChunkPayload {
  return { sha1, data: Buffer.alloc(size, 1) };
}

afterEach(() => {
  fetchMock.mockClear();
  getSdkConfigMock.mockClear();
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

  test("uploads through a retrying fetch with the chunk-upload timeout", async () => {
    await uploadChunkPayloads({
      chunks: [payload("a", 10)],
      serverOptions: SERVER_OPTIONS,
      encoding: undefined,
      regionUrl: "https://us.sentry.io",
    });

    expect(getSdkConfigMock).toHaveBeenCalledWith("https://us.sentry.io", {
      idempotent: true,
      timeoutMs: CHUNK_UPLOAD_TIMEOUT_MS,
    });
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

  test("sends every request over one HTTP/1.1 dispatcher and destroys it after", async () => {
    // Node 26's fetch (undici 8) multiplexes the parallel uploads as HTTP/2
    // streams on one connection, and Sentry's edge resets all but one with
    // ENHANCE_YOUR_CALM. The uploads must use their own HTTP/1.1 dispatcher.
    const created: FakeAgent[] = [];
    class FakeAgent {
      readonly options: unknown;
      destroyed = false;
      constructor(options?: unknown) {
        this.options = options;
        created.push(this);
      }
      destroy(): Promise<void> {
        this.destroyed = true;
        return Promise.resolve();
      }
    }
    const global = globalThis as Record<PropertyKey, unknown>;
    const original = global[GLOBAL_DISPATCHER_V2];
    global[GLOBAL_DISPATCHER_V2] = Object.create(FakeAgent.prototype);
    try {
      await uploadChunkPayloads({
        chunks: ["a", "b", "c", "d"].map((id) => payload(id, 10)),
        serverOptions: SERVER_OPTIONS,
        encoding: undefined,
        regionUrl: "https://us.sentry.io",
      });
    } finally {
      global[GLOBAL_DISPATCHER_V2] = original;
    }

    expect(created).toHaveLength(1);
    const [dispatcher] = created;
    expect(dispatcher?.options).toEqual({ allowH2: false });
    expect(dispatcher?.destroyed).toBe(true);
    const inits = fetchMock.mock.calls.map(
      (call) => (call as unknown as [string, { dispatcher?: unknown }])[1],
    );
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init.dispatcher).toBe(dispatcher);
    }
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
