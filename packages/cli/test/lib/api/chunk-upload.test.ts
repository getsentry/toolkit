/**
 * Tests for the chunk-upload server options, the assemble requests, and
 * assembly polling.
 *
 * Focuses on the optional `maxFileSize` / `maxWait` fields added for
 * `debug-files upload`: a server response that omits them must still parse
 * (backward compatibility), and present values must be carried through. The
 * request functions are exercised against a mocked `fetch`.
 */

import { safeParse } from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AssembleResponse,
  assembleArtifactBundle,
  assembleDebugFiles,
  ChunkServerOptionsSchema,
  getChunkUploadOptions,
  pollAssembly,
} from "../../../src/lib/api/chunk-upload.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-chunk-upload-");

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  setAuthToken("test-token");
  setOrgRegion("my-org", "https://us.sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Captured request from {@link respondWith}. */
type CapturedRequest = { url: string; method: string; body: unknown };

/** Answer every request with `body` and record what was sent. */
function respondWith(body: unknown, status = 200): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    const req = new Request(input, init);
    const text = await req.text();
    requests.push({
      url: req.url,
      method: req.method,
      body: text ? JSON.parse(text) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

const BASE = {
  url: "https://us.sentry.io/api/0/chunk-upload/",
  chunkSize: 8192,
  chunksPerRequest: 64,
  maxRequestSize: 1_048_576,
  hashAlgorithm: "sha1",
  concurrency: 8,
  compression: ["gzip"],
};

describe("getChunkUploadOptions", () => {
  test("strips embedded credentials from the server-returned chunk-upload URL", async () => {
    const requests = respondWith({
      ...BASE,
      url: "https://08d1f409cc5d402783b7ce48189675e8@bugsink.example.com/8/api/0/organizations/my-org/chunk-upload/",
    });

    const result = await getChunkUploadOptions("my-org");

    expect(result.url).toBe(
      "https://bugsink.example.com/8/api/0/organizations/my-org/chunk-upload/",
    );
    expect(requests[0]?.url).toBe(
      "https://us.sentry.io/api/0/organizations/my-org/chunk-upload/",
    );
  });

  test("leaves a credential-free URL unchanged", async () => {
    respondWith({ ...BASE });

    const result = await getChunkUploadOptions("my-org");

    expect(result.url).toBe(BASE.url);
  });

  test("keeps maxWait, which the generated response type lacks", async () => {
    respondWith({ ...BASE, maxWait: 300 });

    const result = await getChunkUploadOptions("my-org");

    expect(result.maxWait).toBe(300);
  });

  test("rejects a response that does not match the schema", async () => {
    respondWith({ url: BASE.url });

    await expect(getChunkUploadOptions("my-org")).rejects.toThrow(
      "Unexpected response format from organizations/my-org/chunk-upload/",
    );
  });

  test("throws an ApiError on an HTTP error", async () => {
    respondWith({ detail: "Organization not found" }, 404);

    const error = await getChunkUploadOptions("my-org").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).detail).toBe("Organization not found");
  });
});

describe("assemble requests", () => {
  test("assembleDebugFiles posts the body to the project DIF endpoint", async () => {
    const requests = respondWith({ abc: { state: "ok", missingChunks: [] } });
    const body = {
      abc: { name: "libfoo.so", debug_id: "id-1", chunks: ["c1"] },
    };

    const result = await assembleDebugFiles("my-org", "my-project", body);

    expect(result).toEqual({ abc: { state: "ok", missingChunks: [] } });
    expect(requests).toEqual([
      {
        url: "https://us.sentry.io/api/0/projects/my-org/my-project/files/difs/assemble/",
        method: "POST",
        body,
      },
    ]);
  });

  test("assembleArtifactBundle posts the body to the org bundle endpoint", async () => {
    const requests = respondWith({ state: "created", missingChunks: [] });
    const body = { checksum: "abc", chunks: ["c1"], projects: ["my-project"] };

    const result = await assembleArtifactBundle("my-org", body);

    expect(result.state).toBe("created");
    expect(requests).toEqual([
      {
        url: "https://us.sentry.io/api/0/organizations/my-org/artifactbundle/assemble/",
        method: "POST",
        body,
      },
    ]);
  });

  test("assembleArtifactBundle rejects an unknown assemble state", async () => {
    respondWith({ state: "bogus", missingChunks: [] });

    await expect(
      assembleArtifactBundle("my-org", { checksum: "abc", chunks: [] }),
    ).rejects.toThrow("Unexpected response format");
  });
});

describe("ChunkServerOptionsSchema", () => {
  test("parses a response that omits maxFileSize and maxWait", () => {
    const result = safeParse(ChunkServerOptionsSchema, BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.maxFileSize).toBeUndefined();
      expect(result.output.maxWait).toBeUndefined();
    }
  });

  test("carries through present maxFileSize and maxWait", () => {
    const result = safeParse(ChunkServerOptionsSchema, {
      ...BASE,
      maxFileSize: 2_147_483_648,
      maxWait: 300,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.maxFileSize).toBe(2_147_483_648);
      expect(result.output.maxWait).toBe(300);
    }
  });
});

describe("pollAssembly: waitForOk", () => {
  const assemble = vi.fn<() => Promise<AssembleResponse>>();
  const params = {
    assemble,
    endpoint: "org/artifactbundle/assemble/",
    entityName: "Artifact bundle",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    assemble.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("default (waitForOk=false) returns as soon as state is 'created'", async () => {
    assemble.mockResolvedValue({ state: "created" });
    const promise = pollAssembly(params);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(assemble).toHaveBeenCalledTimes(1);
  });

  test("waitForOk=true keeps polling through 'created' until 'ok'", async () => {
    assemble
      .mockResolvedValueOnce({ state: "created" })
      .mockResolvedValueOnce({ state: "ok" });
    const promise = pollAssembly({ ...params, waitForOk: true });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(assemble).toHaveBeenCalledTimes(2);
  });
});
