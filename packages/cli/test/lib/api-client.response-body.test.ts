/**
 * Regression coverage for interrupted successful GET responses (CLI-294).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rawApiRequest } from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { TimeoutError } from "../../src/lib/errors.js";
import {
  __injectTimeoutOverrideForTests,
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("response-body-");

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  resetAuthenticatedFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

function interruptedResponse(error: Error): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      pull(controller) {
        controller.error(error);
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("rawApiRequest response body recovery", () => {
  test.each([
    {
      name: "JSON from the default host",
      baseUrl: undefined,
      bytes: new TextEncoder().encode('{"ok":true}'),
      contentType: "application/json",
      expected: { ok: true },
    },
    {
      name: "binary data from a regional host",
      baseUrl: "https://us.sentry.io",
      bytes: new Uint8Array([0, 255, 128, 1]),
      contentType: "application/octet-stream",
      expected: new Uint8Array([0, 255, 128, 1]),
    },
  ])("retries an interrupted GET and preserves $name", async (fixture) => {
    let calls = 0;
    // An existing streaming fetch must not prevent this call opting in.
    getSdkConfig(fixture.baseUrl ?? "https://sentry.io");
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return interruptedResponse(new TypeError("terminated"));
      }
      return new Response(fixture.bytes, {
        headers: {
          "Content-Type": fixture.contentType,
          "X-Request-Id": "complete-response",
        },
      });
    });

    const result = await rawApiRequest("body-recovery/", {
      baseUrl: fixture.baseUrl,
    });

    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.headers.get("X-Request-Id")).toBe("complete-response");
    expect(result.body).toEqual(fixture.expected);
  });

  test("exhausts the existing retry budget when every GET body fails", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return interruptedResponse(new TypeError("terminated"));
    });

    await expect(rawApiRequest("body-failure/")).rejects.toThrow("terminated");
    expect(calls).toBe(3);
  });

  test("does not replay a successful POST when its body fails", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return interruptedResponse(new TypeError("terminated"));
    });

    await expect(
      rawApiRequest("body-failure/", {
        method: "POST",
        body: { name: "example" },
      }),
    ).rejects.toThrow("terminated");
    expect(calls).toBe(1);
  });

  test("keeps the attempt timeout active while reading a GET body", async () => {
    const restore = __injectTimeoutOverrideForTests({
      pattern: /\/body-timeout\//,
      timeoutMs: 20,
    });
    let calls = 0;
    globalThis.fetch = mockFetch(async (_input, init) => {
      calls += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"pending":'));
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      await expect(rawApiRequest("body-timeout/")).rejects.toBeInstanceOf(
        TimeoutError,
      );
      expect(calls).toBe(3);
    } finally {
      restore();
    }
  });

  test("does not buffer other SDK callers after a raw API request", async () => {
    globalThis.fetch = mockFetch(async () => Response.json({ ok: true }));
    await rawApiRequest("buffered/");

    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    globalThis.fetch = mockFetch(async () => response);

    try {
      const returned = await getSdkConfig("https://us.sentry.io").fetch(
        "https://us.sentry.io/api/0/stream/",
      );
      expect(returned).toBe(response);
      expect(returned.bodyUsed).toBe(false);
    } finally {
      streamController.close();
    }
  });

  test("propagates a caller abort during body reading without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = mockFetch(async (_input, init) => {
      calls += 1;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"pending":'));
            init?.signal?.addEventListener(
              "abort",
              () => stream.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
          pull() {
            controller.abort();
          },
        }),
      );
    });

    const request = getSdkConfig("https://us.sentry.io", {
      bufferResponseBody: true,
    }).fetch("https://us.sentry.io/api/0/body-abort/", {
      signal: controller.signal,
    });

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});
