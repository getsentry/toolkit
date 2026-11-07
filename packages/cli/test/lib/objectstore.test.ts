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

/** Build a batch response in the server's `multipart/form-data` shape. */
function batchResponse(
  parts: { index: number; status: string; body?: string }[],
): Response {
  const boundary = "os-boundary-00000000000000000000000000000abc";
  let text = "";
  for (const part of parts) {
    text +=
      `--${boundary}\r\n` +
      `x-sn-batch-operation-index: ${part.index}\r\n` +
      `x-sn-batch-operation-status: ${part.status}\r\n` +
      "content-disposition: form-data; name=part\r\n\r\n" +
      `${part.body ?? ""}\r\n`;
  }
  text += `--${boundary}--`;
  return new Response(text, {
    status: 200,
    headers: { "content-type": `multipart/form-data; boundary="${boundary}"` },
  });
}

/** Decode a captured batch request body as multipart form data. */
async function sentParts(init: RequestInit): Promise<FormDataEntryValue[]> {
  const headers = new Headers(init.headers);
  const form = await new Response(init.body as BodyInit, {
    headers: { "content-type": headers.get("content-type") as string },
  }).formData();
  return form.getAll("part");
}

describe("findExistingObjects", () => {
  test("sends HEADs as one batch through customFetch", async () => {
    customFetchMock.mockResolvedValue(
      batchResponse([
        { index: 1, status: "404 Not Found" },
        { index: 0, status: "200 OK" },
        { index: 2, status: "200 OK" },
      ]),
    );

    const existing = await findExistingObjects(config, ["k0", "k1", "k2"]);

    expect([...existing].sort()).toEqual(["k0", "k2"]);
    expect(customFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = customFetchMock.mock.calls[0] ?? [];
    expect(url).toBe(BATCH_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-os-auth")).toBe("Bearer jwt-token");
    expect(await sentParts(init)).toHaveLength(3);
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
        { index: 0, status: "200 OK" },
        { index: 1, status: "429 Too Many Requests", body: "slow down" },
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
        ? batchResponse([{ index: 0, status: "201 Created" }])
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
    const parts = await sentParts(batchInit);
    // Parts without a filename decode as strings.
    expect(parts).toEqual(["\x01\x02\x03"]);

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
      batchResponse([{ index: 0, status: "500 Internal Server Error" }]),
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
