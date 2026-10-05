/**
 * Tests for the debug information file upload API.
 *
 * Mocks the chunk-upload primitives and the region request layer so the
 * assemble body shape, missing-chunk upload, and the no-wait/wait completion
 * modes can be exercised without a network. `hashBuffer` and `pickUploadEncoding`
 * remain real (they are pure).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getChunkUploadOptions } from "../../../src/lib/api/chunk-upload.js";
import {
  type DebugFileUpload,
  uploadDebugFiles,
} from "../../../src/lib/api/debug-files.js";
import { ApiError } from "../../../src/lib/errors.js";

const { apiRequestToRegionMock, uploadMissingBufferChunksMock } = vi.hoisted(
  () => ({
    apiRequestToRegionMock: vi.fn(),
    uploadMissingBufferChunksMock: vi.fn(() => Promise.resolve()),
  })
);

vi.mock("../../../src/lib/region.js", () => ({
  resolveOrgRegion: vi.fn(async () => "https://us.sentry.io"),
}));

vi.mock("../../../src/lib/api/infrastructure.js", () => ({
  apiRequestToRegion: apiRequestToRegionMock,
}));

vi.mock("../../../src/lib/api/chunk-upload.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/api/chunk-upload.js")
    >();
  return {
    ...actual,
    getChunkUploadOptions: vi.fn(async () => ({
      url: "https://us.sentry.io/api/0/chunk-upload/",
      chunkSize: 8192,
      chunksPerRequest: 64,
      maxRequestSize: 1_048_576,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: ["gzip"],
    })),
    uploadMissingBufferChunks: uploadMissingBufferChunksMock,
  };
});

/** Build a single debug-file upload payload. */
function makeDif(
  name: string,
  content: string,
  debugId?: string
): DebugFileUpload {
  return { name, debugId, content: Buffer.from(content) };
}

/** The single checksum key from the most recent assemble body. */
function lastAssembleBody(): Record<
  string,
  { name: string; debug_id?: string; chunks: string[] }
> {
  const calls = apiRequestToRegionMock.mock.calls;
  const lastCall = calls.at(-1);
  return lastCall?.[2].body;
}

const SOLE = {
  org: "acme",
  project: "app",
};

/** Base server options the mock returns unless a test overrides it. */
const BASE_SERVER_OPTIONS = {
  url: "https://us.sentry.io/api/0/chunk-upload/",
  chunkSize: 8192,
  chunksPerRequest: 64,
  maxRequestSize: 1_048_576,
  hashAlgorithm: "sha1",
  concurrency: 8,
  compression: ["gzip"],
};

/** Override the chunk-upload server options for the current test. */
function setServerOptions(overrides: Record<string, unknown>): void {
  vi.mocked(getChunkUploadOptions).mockResolvedValue({
    ...BASE_SERVER_OPTIONS,
    ...overrides,
  } as Awaited<ReturnType<typeof getChunkUploadOptions>>);
}

beforeEach(() => {
  apiRequestToRegionMock.mockReset();
  uploadMissingBufferChunksMock.mockClear();
  vi.mocked(getChunkUploadOptions).mockResolvedValue(
    BASE_SERVER_OPTIONS as Awaited<ReturnType<typeof getChunkUploadOptions>>
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("uploadDebugFiles", () => {
  test("empty input returns no results and makes no requests", async () => {
    const results = await uploadDebugFiles({
      ...SOLE,
      difs: [],
      wait: false,
      maxWaitMs: 1000,
    });
    expect(results).toEqual([]);
    expect(apiRequestToRegionMock).not.toHaveBeenCalled();
  });

  test("assemble body keys by checksum and includes name + debug_id + chunks", async () => {
    const dif = makeDif("libfoo.so", "ELF debug bytes", "abc123-def");
    // The checksum is content-derived, so we capture the request body and
    // echo its keys back as "ok" — server already holds the file, so no-wait
    // completes on the first assemble.
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, unknown>;
        const data: Record<string, { state: string }> = {};
        for (const key of Object.keys(body)) {
          data[key] = { state: "ok" };
        }
        return { data };
      }
    );

    const results = await uploadDebugFiles({
      ...SOLE,
      difs: [dif],
      wait: false,
      maxWaitMs: 1000,
    });

    const body = lastAssembleBody();
    const keys = Object.keys(body);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{40}$/);
    const entry = body[keys[0] as string];
    expect(entry?.name).toBe("libfoo.so");
    expect(entry?.debug_id).toBe("abc123-def");
    expect(Array.isArray(entry?.chunks)).toBe(true);
    expect(entry?.chunks.every((c) => /^[0-9a-f]{40}$/.test(c))).toBe(true);

    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe("ok");
    expect(results[0]?.name).toBe("libfoo.so");
  });

  test("omits debug_id from the body when not provided", async () => {
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, unknown>;
        const data: Record<string, { state: string }> = {};
        for (const key of Object.keys(body)) {
          data[key] = { state: "ok" };
        }
        return { data };
      }
    );

    await uploadDebugFiles({
      ...SOLE,
      difs: [makeDif("anon.so", "bytes")],
      wait: false,
      maxWaitMs: 1000,
    });

    const entry = Object.values(lastAssembleBody())[0];
    expect(entry).toBeDefined();
    expect("debug_id" in (entry as object)).toBe(false);
  });

  test("uploads missing chunks then completes (no-wait)", async () => {
    vi.useFakeTimers();
    const dif = makeDif("libbar.so", "more debug bytes", "id-1");

    // First assemble: server is missing the chunk. Second: held (created).
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, { chunks: string[] }>;
        const key = Object.keys(body)[0] as string;
        return {
          data: {
            [key]: { state: "not_found", missingChunks: body[key]?.chunks },
          },
        };
      }
    );
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "created" } } };
      }
    );

    const promise = uploadDebugFiles({
      ...SOLE,
      difs: [dif],
      wait: false,
      maxWaitMs: 60_000,
    });
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(uploadMissingBufferChunksMock).toHaveBeenCalled();
    expect(apiRequestToRegionMock).toHaveBeenCalledTimes(2);
    expect(results[0]?.state).toBe("created");
  });

  test("wait mode polls past 'assembling' until terminal 'ok'", async () => {
    vi.useFakeTimers();
    const dif = makeDif("libbaz.so", "debug bytes", "id-2");

    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "assembling" } } };
      }
    );
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "ok" } } };
      }
    );

    const promise = uploadDebugFiles({
      ...SOLE,
      difs: [dif],
      wait: true,
      maxWaitMs: 60_000,
    });
    await vi.runAllTimersAsync();
    const results = await promise;

    expect(apiRequestToRegionMock).toHaveBeenCalledTimes(2);
    expect(results[0]?.state).toBe("ok");
  });

  test("wait mode collects an 'error' state without throwing", async () => {
    const dif = makeDif("broken.so", "debug bytes", "id-3");
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return {
          data: { [key]: { state: "error", detail: "corrupt object" } },
        };
      }
    );

    const results = await uploadDebugFiles({
      ...SOLE,
      difs: [dif],
      wait: true,
      maxWaitMs: 60_000,
    });

    expect(results[0]?.state).toBe("error");
    expect(results[0]?.detail).toBe("corrupt object");
  });

  test("wait mode throws ApiError when assembly does not finish in time", async () => {
    const dif = makeDif("slow.so", "debug bytes", "id-4");
    // Always "assembling" → never terminal. maxWaitMs=0 trips the deadline.
    apiRequestToRegionMock.mockImplementation(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "assembling" } } };
      }
    );

    await expect(
      uploadDebugFiles({
        ...SOLE,
        difs: [dif],
        wait: true,
        maxWaitMs: 0,
      })
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("batches multiple files into one assemble request", async () => {
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, unknown>;
        const data: Record<string, { state: string }> = {};
        for (const key of Object.keys(body)) {
          data[key] = { state: "ok" };
        }
        return { data };
      }
    );

    const results = await uploadDebugFiles({
      ...SOLE,
      difs: [makeDif("a.so", "alpha", "id-a"), makeDif("b.so", "beta", "id-b")],
      wait: false,
      maxWaitMs: 1000,
    });

    expect(apiRequestToRegionMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(lastAssembleBody())).toHaveLength(2);
    expect(results).toHaveLength(2);
  });

  test("re-sends every chunk when server response omits a file's entry", async () => {
    // First call: server has no record of either file (entries missing).
    // Second call: server holds both files. No-wait completes on the second
    // call after the chunks are re-uploaded.
    apiRequestToRegionMock.mockImplementationOnce(async () => ({ data: {} }));
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, unknown>;
        const data: Record<string, { state: string }> = {};
        for (const key of Object.keys(body)) {
          data[key] = { state: "ok" };
        }
        return { data };
      }
    );

    await uploadDebugFiles({
      ...SOLE,
      difs: [makeDif("missing.so", "alpha", "id-a")],
      wait: false,
      maxWaitMs: 60_000,
    });

    // First call has the file's entry missing from response, so all its
    // chunks must have been queued for re-upload.
    expect(uploadMissingBufferChunksMock).toHaveBeenCalled();
    const firstCall = uploadMissingBufferChunksMock.mock.calls[0]?.[0];
    const passedMissing = firstCall?.missingChecksums as Set<string>;
    expect(passedMissing.size).toBeGreaterThan(0);
  });

  test("re-sends every chunk when entry state is not_found without missingChunks", async () => {
    // Server returns `not_found` but omits the `missingChunks` field — the
    // client must still upload all chunks for that file, otherwise the loop
    // would poll forever without sending anything.
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "not_found" } } };
      }
    );
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "ok" } } };
      }
    );

    await uploadDebugFiles({
      ...SOLE,
      difs: [makeDif("silent.so", "alpha", "id-x")],
      wait: false,
      maxWaitMs: 60_000,
    });

    const firstCall = uploadMissingBufferChunksMock.mock.calls[0]?.[0];
    const passedMissing = firstCall?.missingChecksums as Set<string>;
    // Must contain the file's chunk checksums, not be empty.
    expect(passedMissing.size).toBeGreaterThan(0);
  });

  test("does not assemble oversized files but reports them as failures", async () => {
    setServerOptions({ maxFileSize: 5 });
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const body = init.body as Record<string, unknown>;
        const data: Record<string, { state: string }> = {};
        for (const key of Object.keys(body)) {
          data[key] = { state: "ok" };
        }
        return { data };
      }
    );

    const results = await uploadDebugFiles({
      ...SOLE,
      // "small" is 5 bytes (<= cap), "this-one-is-too-long" exceeds it.
      difs: [
        makeDif("small.so", "small", "id-ok"),
        makeDif("big.so", "this-one-is-too-long", "id-big"),
      ],
      wait: false,
      maxWaitMs: 1000,
    });

    // Only the in-cap file is actually assembled.
    const body = lastAssembleBody();
    const names = Object.values(body).map((e) => e.name);
    expect(names).toEqual(["small.so"]);

    // But the oversized file is surfaced as an `error` result so a partial
    // drop yields a non-zero exit instead of a silent success.
    expect(results).toHaveLength(2);
    const small = results.find((r) => r.name === "small.so");
    const big = results.find((r) => r.name === "big.so");
    expect(small?.state).toBe("ok");
    expect(big?.state).toBe("error");
    expect(big?.detail).toMatch(/maximum file size/);
  });

  test("throws when every file exceeds the server maxFileSize", async () => {
    setServerOptions({ maxFileSize: 1 });

    await expect(
      uploadDebugFiles({
        ...SOLE,
        difs: [makeDif("big.so", "way too large", "id-big")],
        wait: false,
        maxWaitMs: 1000,
      })
    ).rejects.toThrow(/exceed the maximum file size/);
    expect(apiRequestToRegionMock).not.toHaveBeenCalled();
  });

  test("clamps the wait to the server maxWait (reflected in the timeout)", async () => {
    setServerOptions({ maxWait: 1 });
    vi.useFakeTimers();
    // Always "assembling" → never terminal. The clamped 1s deadline trips
    // well before the requested 60s.
    apiRequestToRegionMock.mockImplementation(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "assembling" } } };
      }
    );

    const promise = uploadDebugFiles({
      ...SOLE,
      difs: [makeDif("slow.so", "debug bytes", "id-slow")],
      wait: true,
      maxWaitMs: 60_000,
    }).catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    const err = await promise;

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).detail).toContain("within 1s");
  });

  test("does not clamp when the server advertises no maxWait (0)", async () => {
    setServerOptions({ maxWait: 0 });
    const dif = makeDif("ok.so", "debug bytes", "id-ok");
    apiRequestToRegionMock.mockImplementationOnce(
      async (_url: string, _endpoint: string, init: { body: object }) => {
        const key = Object.keys(init.body as object)[0] as string;
        return { data: { [key]: { state: "ok" } } };
      }
    );

    const results = await uploadDebugFiles({
      ...SOLE,
      difs: [dif],
      wait: true,
      maxWaitMs: 60_000,
    });

    expect(results[0]?.state).toBe("ok");
  });
});
