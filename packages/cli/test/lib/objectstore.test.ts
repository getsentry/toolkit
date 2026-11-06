/**
 * Tests for the minimal Objectstore HTTP client.
 *
 * `customFetch` is mocked so URL construction, the `x-os-auth` header, the
 * batch request/response protocol, and PUT request shape can be verified
 * without a network.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/lib/errors.js";

const { customFetchMock } = vi.hoisted(() => ({ customFetchMock: vi.fn() }));
vi.mock("../../src/lib/custom-ca.js", () => ({ customFetch: customFetchMock }));

import {
  buildObjectUrl,
  encodeHeaderValue,
  findExistingObjects,
  type ObjectstoreConfig,
  putObject,
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

beforeEach(() => {
  customFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildObjectUrl", () => {
  test("joins usecase, scope, and key (stripping a trailing slash)", () => {
    expect(
      buildObjectUrl({ ...config, usecase: "preprod" }, "123/456/abc"),
    ).toBe(
      "https://objectstore.example.com/v1/objects/preprod/org=123;project=456/123/456/abc",
    );
  });
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
  const headers = init.headers as Record<string, string>;
  const form = await new Response(init.body as BodyInit, {
    headers: { "content-type": headers["content-type"] as string },
  }).formData();
  return form.getAll("part");
}

describe("encodeHeaderValue", () => {
  test("leaves visible ASCII alone and escapes %, controls, and non-ASCII", () => {
    expect(encodeHeaderValue("1/2/abc")).toBe("1/2/abc");
    expect(encodeHeaderValue("100% done")).toBe("100%25 done");
    expect(encodeHeaderValue("r\u00e9port")).toBe("r%C3%A9port");
    expect(encodeHeaderValue("a\nb")).toBe("a%0Ab");
  });
});

describe("findExistingObjects", () => {
  test("sends all HEADs in one batch request and returns existing keys", async () => {
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
    expect(url).toBe(
      "https://objectstore.example.com/v1/objects:batch/preprod_snapshots/org=123;project=456/",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["x-os-auth"]).toBe("Bearer jwt-token");
    expect(await sentParts(init)).toHaveLength(3);
    const raw = Buffer.from(init.body).toString();
    expect(raw).toContain("x-sn-batch-operation-kind: head\r\n");
    expect(raw).toContain("x-sn-batch-operation-key: k1\r\n");
  });

  test("throws on a per-operation error other than 404", async () => {
    customFetchMock.mockResolvedValue(
      batchResponse([
        { index: 0, status: "200 OK" },
        { index: 1, status: "429 Too Many Requests", body: "slow down" },
      ]),
    );
    await expect(findExistingObjects(config, ["k0", "k1"])).rejects.toThrow(
      ApiError,
    );
  });

  test("throws when the batch request itself fails", async () => {
    customFetchMock.mockResolvedValue(
      new Response(null, { status: 429, statusText: "Too Many Requests" }),
    );
    const error = await findExistingObjects(config, ["k0"]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
  });

  test("throws when the response is missing an operation", async () => {
    customFetchMock.mockResolvedValue(
      batchResponse([{ index: 0, status: "200 OK" }]),
    );
    await expect(findExistingObjects(config, ["k0", "k1"])).rejects.toThrow(
      ApiError,
    );
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
        : { ok: true, status: 201 },
    );

    await putObjects(config, [
      { key: "1/2/small", path: small },
      { key: "1/2/large", path: large },
    ]);

    expect(customFetchMock).toHaveBeenCalledTimes(2);
    const [, batchInit] = customFetchMock.mock.calls.find(
      ([, init]) => init.method === "POST",
    ) ?? [undefined, undefined];
    const parts = await sentParts(batchInit);
    expect(parts).toHaveLength(1);
    // Parts without a filename decode as strings.
    expect(parts[0]).toBe("\x01\x02\x03");
    const raw = Buffer.from(batchInit.body).toString("latin1");
    expect(raw).toContain("x-sn-batch-operation-kind: insert\r\n");
    expect(raw).toContain("x-sn-batch-operation-key: 1/2/small\r\n");
    expect(raw).toContain("x-sn-expiration: ttl:30d\r\n");

    const [putUrl, putInit] = customFetchMock.mock.calls.find(
      ([, init]) => init.method === "PUT",
    ) ?? [undefined, undefined];
    expect(putUrl).toMatch(
      /\/v1\/objects\/preprod_snapshots\/.*\/1\/2\/large$/,
    );
    expect(putInit.body.byteLength).toBe(1024 * 1024 + 1);
  });

  test("throws when an insert in the batch fails", async () => {
    const small = join(dir, "small.png");
    await writeFile(small, new Uint8Array([1]));
    customFetchMock.mockResolvedValue(
      batchResponse([{ index: 0, status: "500 Internal Server Error" }]),
    );
    await expect(
      putObjects(config, [{ key: "k", path: small }]),
    ).rejects.toThrow(ApiError);
  });
});

describe("putObject", () => {
  test("PUTs the body with auth + expiration headers", async () => {
    customFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const body = new Uint8Array([1, 2, 3]);
    await putObject(config, "123/456/abc", body);

    const [url, init] = customFetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://objectstore.example.com/v1/objects/preprod_snapshots/org=123;project=456/123/456/abc",
    );
    expect(init.method).toBe("PUT");
    expect(init.headers["x-os-auth"]).toBe("Bearer jwt-token");
    expect(init.headers["x-sn-expiration"]).toBe("ttl:30d");
    expect(init.body).toBe(body);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("throws on a non-2xx response", async () => {
    customFetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      statusText: "too large",
    });
    await expect(putObject(config, "k", new Uint8Array([0]))).rejects.toThrow(
      ApiError,
    );
  });
});
