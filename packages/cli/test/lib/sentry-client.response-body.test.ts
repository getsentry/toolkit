/**
 * Interrupted GET recovery through direct fetch, API helpers and the real SDK.
 */

import { listOrganizations } from "@sentry/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getReplayRecordingSegments,
  listIssuesPaginated,
  rawApiRequest,
} from "../../src/lib/api-client.js";
import {
  apiRequestToRegion,
  apiRequestToRegionNoContent,
} from "../../src/lib/api/infrastructure.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import { TimeoutError } from "../../src/lib/errors.js";
import {
  __injectTimeoutOverrideForTests,
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { getSdkClientConfig } from "../../src/lib/sentry-sdk-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("response-body-");

const REGION_URL = "https://us.sentry.io";
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

function interruptedResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

async function whileStreamIsOpen<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The request waited for the stream to close")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("handwritten API response body recovery", () => {
  test.each(["json", "no-content"] as const)(
    "retries interrupted GET bodies in the %s helper",
    async (kind) => {
      let calls = 0;
      globalThis.fetch = mockFetch(async () => {
        calls += 1;
        return calls === 1
          ? interruptedResponse()
          : Response.json(
              { ok: true },
              { headers: { "X-Request-Id": "complete" } },
            );
      });

      if (kind === "json") {
        const result = await apiRequestToRegion(
          "https://us.sentry.io",
          "/body/",
        );
        expect(result.data).toEqual({ ok: true });
        expect(result.headers.get("X-Request-Id")).toBe("complete");
      } else {
        await apiRequestToRegionNoContent("https://us.sentry.io", "/body/");
      }
      expect(calls).toBe(2);
    },
  );

  test("does not misreport an exhausted interrupted GET as invalid JSON", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return interruptedResponse();
    });

    await expect(
      apiRequestToRegion("https://us.sentry.io", "/body/"),
    ).rejects.toThrow("terminated");
    expect(calls).toBe(3);
  });

  test("does not retry a complete but invalid JSON body", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return new Response("{invalid", {
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      apiRequestToRegion("https://us.sentry.io", "/body/"),
    ).rejects.toThrow("Invalid JSON");
    expect(calls).toBe(1);
  });
});

describe("raw API and direct fetch response bodies", () => {
  test("respects a null signal overriding an aborted Request signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = new Request("https://us.sentry.io/api/0/body-signal/", {
      signal: controller.signal,
    });
    globalThis.fetch = mockFetch(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ ok: true });
    });

    const response = await getSdkConfig("https://us.sentry.io", {
      bufferResponseBody: true,
    }).fetch(input, { signal: null });

    expect(await response.json()).toEqual({ ok: true });
  });

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
        return interruptedResponse();
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

  test("does not replay a successful POST when its body fails", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return interruptedResponse();
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

  test("keeps direct fetch streaming after a raw API request", async () => {
    globalThis.fetch = mockFetch(async () => Response.json({ ok: true }));
    await rawApiRequest("buffered/");

    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    globalThis.fetch = mockFetch(async () => response);

    try {
      const returned = await whileStreamIsOpen(
        getSdkConfig(REGION_URL).fetch(`${REGION_URL}/api/0/stream/`),
      );
      expect(returned).toBe(response);
      expect(returned.bodyUsed).toBe(false);
    } finally {
      streamController.close();
    }
  });
});

describe("SDK response body recovery", () => {
  test("does not restart the budget after an HTTP retry", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : interruptedResponse();
    });

    await expect(
      listOrganizations({
        ...getSdkClientConfig(REGION_URL),
        throwOnError: true,
      }),
    ).rejects.toThrow("terminated");
    expect(calls).toBe(3);
  });

  test("recovers binary data and preserves the SDK Response", async () => {
    let calls = 0;
    const bytes = new Uint8Array([0, 255, 128, 1]);
    const completeResponse = new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Request-Id": "complete-response",
      },
    });
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1 ? interruptedResponse() : completeResponse;
    });
    const config = getSdkClientConfig(REGION_URL);

    const result = await config.client.get({
      ...config,
      url: "/api/0/body-parsing/",
      parseAs: "arrayBuffer",
    });

    expect(result.data).toEqual(bytes.buffer);
    expect(result.response).toBe(completeResponse);
    expect(result.response?.headers.get("X-Request-Id")).toBe(
      "complete-response",
    );
    expect(calls).toBe(2);
  });

  test("propagates the SDK Request signal while reading the body", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = mockFetch(async (input, init) => {
      calls += 1;
      expect(input).toBeInstanceOf(Request);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("["));
            init?.signal?.addEventListener(
              "abort",
              () => stream.error(init?.signal?.reason),
              { once: true },
            );
          },
          pull() {
            controller.abort();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await listOrganizations({
      ...getSdkClientConfig(REGION_URL),
      signal: controller.signal,
    });

    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test.each(["invalid JSON", "validation"] as const)(
    "does not retry %s failures",
    async (failureKind) => {
      let calls = 0;
      const validationError = new Error("unexpected response shape");
      globalThis.fetch = mockFetch(async () => {
        calls += 1;
        return new Response(failureKind === "invalid JSON" ? "{" : "[]", {
          headers: { "Content-Type": "application/json" },
        });
      });
      const operation = listOrganizations({
        ...getSdkClientConfig(REGION_URL),
        responseValidator:
          failureKind === "validation"
            ? () => {
                throw validationError;
              }
            : undefined,
      });

      if (failureKind === "validation") {
        await expect(operation).rejects.toBe(validationError);
      } else {
        await expect(operation).rejects.toBeInstanceOf(SyntaxError);
      }
      expect(calls).toBe(1);
    },
  );

  test("does not replay a successful SDK POST when its body fails", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return interruptedResponse();
    });
    const config = getSdkClientConfig(REGION_URL);

    await expect(
      config.client.post({
        ...config,
        url: "/api/0/body-post/",
        body: { name: "example" },
      }),
    ).rejects.toThrow("terminated");
    expect(calls).toBe(1);
  });
});

describe("SDK streaming compatibility", () => {
  test.each([
    { parseAs: "stream" as const, contentType: "application/json" },
    { parseAs: "auto" as const, contentType: undefined },
  ])(
    "returns an open $parseAs body with Content-Type $contentType",
    async ({ parseAs, contentType }) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const bytes = new Uint8Array([1, 2, 3]);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(bytes);
          },
        }),
        { headers: contentType ? { "Content-Type": contentType } : undefined },
      );
      let calls = 0;
      globalThis.fetch = mockFetch(async () => {
        calls += 1;
        return response;
      });
      const config = getSdkClientConfig(REGION_URL);

      try {
        const result = await whileStreamIsOpen(
          config.client.get({
            ...config,
            url: "/api/0/open-stream/",
            parseAs,
          }),
        );
        expect(result.response).toBe(response);
        expect(result.data).toBe(response.body);
        expect(response.bodyUsed).toBe(false);
        const reader = response.body!.getReader();
        expect(await reader.read()).toEqual({ value: bytes, done: false });
        reader.releaseLock();
        expect(calls).toBe(1);
      } finally {
        streamController.close();
      }
    },
  );

  test("delivers an SSE event before the server closes the connection", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              new TextEncoder().encode('data: {"ok":true}\n\n'),
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
      );
    });
    const config = getSdkClientConfig(REGION_URL);
    const { stream } = await config.client.sse.get<{ ok: boolean }>({
      ...config,
      url: "/api/0/events/",
    });

    try {
      const event = await whileStreamIsOpen(stream.next());
      expect(event).toMatchObject({ done: false, value: { ok: true } });
      expect(calls).toBe(1);
    } finally {
      streamController.close();
      await stream.return(undefined);
    }
  });
});

describe("command API response body recovery", () => {
  test("recovers issue list data and pagination metadata", async () => {
    setOrgRegion("example-org", REGION_URL);
    const issues = [
      {
        id: "1",
        shortId: "TEST-1",
        title: "Example error",
        status: "unresolved",
      },
    ];
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1
        ? interruptedResponse()
        : Response.json(issues, {
            headers: {
              Link: `<${REGION_URL}/api/0/organizations/example-org/issues/>; rel="next"; results="true"; cursor="0:1:0"`,
            },
          });
    });

    const result = await listIssuesPaginated("example-org", "example-project");

    expect(result).toMatchObject({ data: issues, nextCursor: "0:1:0" });
    expect(calls).toBe(2);
  });

  test("recovers replay segments before the real response validator", async () => {
    setOrgRegion("example-org", REGION_URL);
    const segments = [[{ timestamp: 1 }]];
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1 ? interruptedResponse() : Response.json(segments);
    });

    const result = await getReplayRecordingSegments(
      "example-org",
      "42",
      "0123456789abcdef0123456789abcdef",
    );

    expect(result).toEqual(segments);
    expect(calls).toBe(2);
  });
});
