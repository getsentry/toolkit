/**
 * Tests for the minimal Objectstore HTTP client.
 *
 * `customFetch` is mocked so URL construction, the `x-os-auth` header, HEAD
 * existence semantics, and PUT request shape can be verified without a network.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/lib/errors.js";

const { customFetchMock } = vi.hoisted(() => ({ customFetchMock: vi.fn() }));
vi.mock("../../src/lib/custom-ca.js", () => ({ customFetch: customFetchMock }));

import {
  buildObjectUrl,
  type ObjectstoreConfig,
  objectExists,
  putObject,
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
      buildObjectUrl({ ...config, usecase: "preprod" }, "123/456/abc")
    ).toBe(
      "https://objectstore.example.com/v1/objects/preprod/org=123;project=456/123/456/abc"
    );
  });
});

describe("objectExists", () => {
  test("returns true on a 2xx HEAD and sends the auth header", async () => {
    customFetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await objectExists(config, "123/456/abc")).toBe(true);
    const [url, init] = customFetchMock.mock.calls[0] ?? [];
    expect(url).toContain(
      "/v1/objects/preprod_snapshots/org=123;project=456/123/456/abc"
    );
    expect(init.method).toBe("HEAD");
    expect(init.headers["x-os-auth"]).toBe("Bearer jwt-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("returns false on a 404", async () => {
    customFetchMock.mockResolvedValue({ ok: false, status: 404 });
    expect(await objectExists(config, "123/456/abc")).toBe(false);
  });

  test("throws on other non-2xx responses", async () => {
    customFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
    });
    await expect(objectExists(config, "123/456/abc")).rejects.toThrow(ApiError);
  });

  test("omits the auth header when no token is configured", async () => {
    customFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await objectExists({ ...config, authToken: null }, "k");
    const [, init] = customFetchMock.mock.calls[0] ?? [];
    expect(init.headers["x-os-auth"]).toBeUndefined();
  });
});

describe("putObject", () => {
  test("PUTs the body with auth + expiration headers", async () => {
    customFetchMock.mockResolvedValue({ ok: true, status: 200 });
    const body = new Uint8Array([1, 2, 3]);
    await putObject(config, "123/456/abc", body);

    const [url, init] = customFetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://objectstore.example.com/v1/objects/preprod_snapshots/org=123;project=456/123/456/abc"
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
      ApiError
    );
  });
});
