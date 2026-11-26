/**
 * Tests for the CLI adapter over the `@sentry/api/client` Objectstore client.
 *
 * The batch protocol itself is tested in `@sentry/api`. These tests check what
 * the CLI adds: requests go through `customFetch`, files are read from disk,
 * and failures surface as CLI `ApiError`s.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/lib/errors.js";

const { customFetchMock } = vi.hoisted(() => ({ customFetchMock: vi.fn() }));
vi.mock("../../src/lib/custom-ca.js", () => ({ customFetch: customFetchMock }));

import {
  findExistingObjects,
  type ObjectstoreConfig,
  putObjects,
} from "../../src/lib/objectstore.js";

const config: ObjectstoreConfig = {
  url: "https://objectstore.example.com/",
  usecase: "preprod_snapshots",
  scopes: [
    ["org", "123"],
    ["project", "456"],
  ],
  authToken: "jwt-token",
  expirationPolicy: "ttl:30d",
};

const BATCH_URL =
  "https://objectstore.example.com/v1/objects:batch/preprod_snapshots/org=123;project=456/";

beforeEach(() => {
  customFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build a batch response in the server's layout: one JSON part per
 * operation, named by its index.
 */
function batchResponse(
  parts: { index: number; status: number; error?: { detail?: string } }[],
): Response {
  const boundary = "os-boundary-00000000000000000000000000000abc";
  let text = "";
  for (const { index, ...result } of parts) {
    text +=
      `--${boundary}\r\n` +
      `content-disposition: form-data; name="${index}"\r\n` +
      "content-type: application/json\r\n\r\n" +
      `${JSON.stringify(result)}\r\n`;
  }
  text += `--${boundary}--\r\n`;
  return new Response(text, {
    status: 200,
    headers: { "content-type": `multipart/form-data; boundary="${boundary}"` },
  });
}

/** The operations a captured batch request sends, one per index-named part. */
function sentOperations(init: RequestInit): unknown[] {
  return [...(init.body as FormData)]
    .filter(([name]) => /^\d+$/.test(name))
    .map(([, value]) => JSON.parse(value as string));
}

describe("findExistingObjects", () => {
  test("sends HEADs as one batch through customFetch", async () => {
    customFetchMock.mockResolvedValue(
      batchResponse([
        { index: 1, status: 404 },
        { index: 0, status: 200 },
        { index: 2, status: 200 },
      ]),
    );

    const existing = await findExistingObjects(config, ["k0", "k1", "k2"]);

    expect([...existing].sort()).toEqual(["k0", "k2"]);
    expect(customFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = customFetchMock.mock.calls[0] ?? [];
    expect(url).toBe(BATCH_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-os-auth")).toBe("Bearer jwt-token");
    expect(sentOperations(init)).toEqual([
      { kind: "head", key: "k0" },
      { kind: "head", key: "k1" },
      { kind: "head", key: "k2" },
    ]);
  });

  test("throws a CLI ApiError with the request URL when the batch fails", async () => {
    customFetchMock.mockResolvedValue(
      new Response(null, { status: 429, statusText: "Too Many Requests" }),
    );

    const error = await findExistingObjects(config, ["k0"]).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.endpoint).toBe(BATCH_URL);
  });

  test("throws a CLI ApiError for a failed operation inside a batch", async () => {
    customFetchMock.mockResolvedValue(
      batchResponse([
        { index: 0, status: 200 },
        { index: 1, status: 429, error: { detail: "slow down" } },
      ]),
    );

    const error = await findExistingObjects(config, ["k0", "k1"]).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.endpoint).toMatch(/\/v1\/objects\/preprod_snapshots\/.*\/k1$/);
  });
});

describe("putObjects", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "objectstore-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("batches small files and PUTs files over the batch part limit", async () => {
    const small = join(dir, "small.png");
    const large = join(dir, "large.png");
    await writeFile(small, new Uint8Array([1, 2, 3]));
    await writeFile(large, new Uint8Array(1024 * 1024 + 1));
    customFetchMock.mockImplementation(async (_url, init: RequestInit) =>
      init.method === "POST"
        ? batchResponse([{ index: 0, status: 201 }])
        : new Response(null, { status: 201 }),
    );

    await putObjects(config, [
      { key: "1/2/small", path: small },
      { key: "1/2/large", path: large },
    ]);

    expect(customFetchMock).toHaveBeenCalledTimes(2);
    const [batchUrl, batchInit] = customFetchMock.mock.calls.find(
      ([, init]) => init.method === "POST",
    ) ?? [undefined, undefined];
    expect(batchUrl).toBe(BATCH_URL);
    const payload = (batchInit.body as FormData).get("0.payload") as File;
    expect(new Uint8Array(await payload.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const [putUrl, putInit] = customFetchMock.mock.calls.find(
      ([, init]) => init.method === "PUT",
    ) ?? [undefined, undefined];
    expect(putUrl).toMatch(
      /\/v1\/objects\/preprod_snapshots\/.*\/1\/2\/large$/,
    );
    expect(putInit.body.byteLength).toBe(1024 * 1024 + 1);
  });

  test("throws a CLI ApiError when an insert in the batch fails", async () => {
    const small = join(dir, "small.png");
    await writeFile(small, new Uint8Array([1]));
    customFetchMock.mockResolvedValue(
      batchResponse([{ index: 0, status: 500 }]),
    );

    const error = await putObjects(config, [{ key: "k", path: small }]).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
  });

  test("fails before any request when a file is missing", async () => {
    await expect(
      putObjects(config, [{ key: "k", path: join(dir, "missing.png") }]),
    ).rejects.toThrow(/ENOENT/);
    expect(customFetchMock).not.toHaveBeenCalled();
  });
});
