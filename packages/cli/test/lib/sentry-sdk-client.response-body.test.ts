/**
 * Response-body recovery through the real generated SDK and command API paths.
 */

import { createSentryClient, listOrganizations } from "@sentry/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getReplayRecordingSegments,
  listIssuesPaginated,
} from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import {
  getSdkConfig,
  registerSdkResponseBodyMode,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { getSdkClientConfig } from "../../src/lib/sentry-sdk-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("sdk-response-body-");

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
          () => reject(new Error("The SDK waited for the stream to close")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("SDK response body recovery", () => {
  test("retries a truncated generated operation response", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1
        ? interruptedResponse()
        : Response.json([{ id: "1", slug: "example-org" }]);
    });

    const result = await listOrganizations({
      ...getSdkClientConfig(REGION_URL),
    });

    expect(result.data).toEqual([{ id: "1", slug: "example-org" }]);
    expect(calls).toBe(2);
  });

  test("shares one attempt budget between HTTP and body failures", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return calls === 2 ? interruptedResponse() : Response.json([]);
    });

    const result = await listOrganizations({
      ...getSdkClientConfig(REGION_URL),
    });

    expect(result.data).toEqual([]);
    expect(calls).toBe(3);
  });

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

  test.each([
    {
      parseAs: "json" as const,
      body: '{"ok":true}',
      contentType: "application/json",
      expected: { ok: true },
    },
    {
      parseAs: "text" as const,
      body: "complete text",
      contentType: "text/plain",
      expected: "complete text",
    },
    {
      parseAs: "arrayBuffer" as const,
      body: new Uint8Array([0, 255, 128, 1]),
      contentType: "application/octet-stream",
      expected: new Uint8Array([0, 255, 128, 1]).buffer,
    },
  ])("recovers before SDK $parseAs parsing", async (fixture) => {
    let calls = 0;
    const completeResponse = new Response(fixture.body, {
      headers: {
        "Content-Type": fixture.contentType,
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
      parseAs: fixture.parseAs,
    });

    expect(result.data).toEqual(fixture.expected);
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

  test.each(["POST", "PUT", "PATCH"] as const)(
    "does not replay a successful SDK %s when its body fails",
    async (method) => {
      let calls = 0;
      globalThis.fetch = mockFetch(async () => {
        calls += 1;
        return interruptedResponse();
      });
      const config = getSdkClientConfig(REGION_URL);

      await expect(
        config.client.request({
          ...config,
          method,
          url: "/api/0/body-post/",
          body: { name: "example" },
        }),
      ).rejects.toThrow("terminated");
      expect(calls).toBe(1);
    },
  );

  test("recovers through an independently configured bound SDK client", async () => {
    const sentry = createSentryClient(getSdkConfig(REGION_URL));
    registerSdkResponseBodyMode(sentry.client);
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1 ? interruptedResponse() : Response.json([]);
    });

    expect((await sentry.listOrganizations()).data).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("SDK streaming compatibility", () => {
  test.each([
    { parseAs: "stream" as const, contentType: "application/json" },
    { parseAs: "stream" as const, contentType: "application/octet-stream" },
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
