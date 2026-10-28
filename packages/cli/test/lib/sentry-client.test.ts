/**
 * Tests for the authenticated fetch retry + timeout behavior — CLI-1D6
 * regression coverage.
 */

import {
  getActiveSpan,
  SEMANTIC_ATTRIBUTE_SENTRY_OP,
  spanToJSON,
  startSpan,
} from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { RateLimitError, TimeoutError } from "../../src/lib/errors.js";
import {
  __injectTimeoutOverrideForTests,
  __resolveRequestTimeoutMsForTests,
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { initSentry } from "../../src/lib/telemetry.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("sentry-client-");

let originalFetch: typeof globalThis.fetch;
const REGION_URL = "https://us.sentry.io";

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  // Non-expiring token — refreshToken() becomes a no-op.
  setAuthToken("test-token");
  resetAuthenticatedFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

function getAuthenticatedFetch(): typeof fetch {
  return getSdkConfig(REGION_URL).fetch as typeof fetch;
}

/** Fetch for callers that opted in to replaying writes (chunk uploads). */
function getIdempotentFetch(): typeof fetch {
  return getSdkConfig(REGION_URL, { idempotent: true }).fetch as typeof fetch;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("fetchWithRetry / buildAttemptFactory", () => {
  test("retries an opted-in POST with a string body without re-consuming the body", async () => {
    const marker = "__test_string_body__";
    const seen: string[] = [];
    let callCount = 0;

    globalThis.fetch = mockFetch(async (_input, init) => {
      callCount += 1;
      const body = init?.body;
      if (typeof body === "string") {
        seen.push(body);
      } else if (body) {
        seen.push(await new Response(body as BodyInit).text());
      } else {
        seen.push("<empty>");
      }
      if (callCount === 1) {
        return new Response("busy", { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const authFetch = getIdempotentFetch();
    const res = await authFetch(
      `${REGION_URL}/api/0/${marker}/organizations/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "acme" }),
      },
    );

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(seen).toEqual([
      JSON.stringify({ slug: "acme" }),
      JSON.stringify({ slug: "acme" }),
    ]);
  });

  test("retries an opted-in POST built from a Request object without consuming its body", async () => {
    // SDK path: @sentry/api hands us a Request as the sole argument.
    // Pre-fix: attempt 2 saw a consumed body stream.
    const marker = "__test_request_body__";
    let callCount = 0;
    const seen: string[] = [];

    globalThis.fetch = mockFetch(async (input) => {
      callCount += 1;
      if (input instanceof Request) {
        seen.push(await input.clone().text());
      } else {
        seen.push("<non-request>");
      }
      if (callCount === 1) {
        return new Response("gateway", { status: 502 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const payload = JSON.stringify({ checksum: "abc", chunks: ["abc"] });
    const request = new Request(`${REGION_URL}/api/0/${marker}/assemble/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    const authFetch = getIdempotentFetch();
    const res = await authFetch(request);

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(seen).toEqual([payload, payload]);
  });

  test("retries an opted-in ReadableStream body by materializing once", async () => {
    // Streams are consumed on first read; without up-front materialization
    // attempt 2 would see an undefined body.
    const marker = "__test_stream_body__";
    let callCount = 0;
    const seen: string[] = [];

    globalThis.fetch = mockFetch(async (_input, init) => {
      callCount += 1;
      const body = init?.body;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        seen.push(new TextDecoder().decode(body as ArrayBuffer));
      } else if (typeof body === "string") {
        seen.push(body);
      } else if (body) {
        seen.push(await new Response(body as BodyInit).text());
      } else {
        seen.push("<empty>");
      }
      if (callCount === 1) {
        return new Response("", { status: 500 });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed-body"));
        controller.close();
      },
    });

    const authFetch = getIdempotentFetch();
    // Node's fetch requires duplex: "half" for streamed bodies; Bun accepts
    // it as a no-op.
    const res = await authFetch(`${REGION_URL}/api/0/${marker}/streamed/`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex?: string });

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(seen).toEqual(["streamed-body", "streamed-body"]);
  });

  test("retries an opted-in FormData body without losing the multipart boundary", async () => {
    // Regression for a Cursor Bugbot finding: materializing FormData to
    // an ArrayBuffer drops the auto-negotiated
    // `Content-Type: multipart/form-data; boundary=...` header that
    // `fetch` derives from the FormData body. Sourcemap chunk upload
    // (src/lib/api/sourcemaps.ts) sends FormData through this path;
    // without correct handling even the first upload attempt fails.
    const marker = "__test_formdata_body__";
    let callCount = 0;
    const contentTypes: (string | null)[] = [];
    const bodies: string[] = [];

    globalThis.fetch = mockFetch(async (input, init) => {
      callCount += 1;
      const req = new Request(input as string, init);
      contentTypes.push(req.headers.get("content-type"));
      bodies.push(await req.text());
      if (callCount === 1) {
        return new Response("retry me", { status: 503 });
      }
      return new Response("", { status: 200 });
    });

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: "application/octet-stream",
      }),
      "chunk.bin",
    );

    const authFetch = getIdempotentFetch();
    const res = await authFetch(`${REGION_URL}/api/0/${marker}/chunks/`, {
      method: "POST",
      body: form,
    });

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    // Both attempts must carry a well-formed multipart Content-Type.
    // Bun picks a fresh boundary per serialization, so the two
    // headers differ — the invariant is that each attempt's
    // header+body is internally consistent, and that
    // Content-Type is never lost to a raw `application/octet-stream`
    // or missing header (the pre-fix failure mode).
    for (const ct of contentTypes) {
      expect(ct).toMatch(/^multipart\/form-data; boundary=.+/u);
    }
    // And both attempts carried the same FormData contents.
    for (const body of bodies) {
      expect(body).toContain('name="file"');
      expect(body).toContain("chunk.bin");
    }
  });
});

describe("non-idempotent requests", () => {
  test("does not retry a POST on a transient status", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/acme/issues/1/autofix/`,
      { method: "POST", body: "{}" },
    );

    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  test("does not retry a POST after a network error", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });

    await expect(
      getAuthenticatedFetch()(`${REGION_URL}/api/0/projects/acme/`, {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
  });

  test("does not retry deterministic 5xx statuses", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return new Response("nope", { status: 501 });
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    );

    expect(res.status).toBe(501);
    expect(calls).toBe(1);
  });

  test("still retries a GET on a transient status", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 502 })
        : jsonResponse({ ok: true });
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("replays a POST Request body after a 401 token refresh", async () => {
    // The server rejected the request before processing it, so the refresh
    // retry applies to every method.
    process.env.SENTRY_CLIENT_ID = "test-client-id";
    setAuthToken("initial-token", 3600, "test-refresh-token");
    const seen: { auth: string | null; body: string }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input as Request, init);
      if (req.url.includes("/oauth/token/")) {
        return jsonResponse({
          access_token: "refreshed-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
        });
      }
      seen.push({
        auth: req.headers.get("authorization"),
        body: await req.text(),
      });
      return seen.length === 1
        ? jsonResponse({ detail: "Unauthorized" }, { status: 401 })
        : jsonResponse({ ok: true });
    });

    const payload = JSON.stringify({ step: "root_cause" });
    const res = await getAuthenticatedFetch()(
      new Request(`${REGION_URL}/api/0/organizations/acme/issues/1/autofix/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { auth: "Bearer initial-token", body: payload },
      { auth: "Bearer refreshed-token", body: payload },
    ]);
  });
});

describe("429 rate limiting", () => {
  test("waits for X-Sentry-Rate-Limit-Reset, then retries a GET", async () => {
    let calls = 0;
    const started = Date.now();
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      if (calls > 1) {
        return jsonResponse({ ok: true });
      }
      // Server clock an hour behind ours: the Date header keeps the wait at 1s.
      const serverNow = Math.floor(Date.now() / 1000) - 3600;
      return jsonResponse(
        { detail: "Limit is 40 requests in 1 seconds" },
        {
          status: 429,
          headers: {
            Date: new Date(serverNow * 1000).toUTCString(),
            "X-Sentry-Rate-Limit-Remaining": "0",
            "X-Sentry-Rate-Limit-Reset": String(serverNow + 1),
          },
        },
      );
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("throws RateLimitError with the wait when it exceeds the cap", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return jsonResponse(
        { detail: "Limit is 100 requests in 60 seconds" },
        { status: 429, headers: { "Retry-After": "45" } },
      );
    });

    const error = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    ).catch((err: unknown) => err);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(RateLimitError);
    const rateLimit = error as RateLimitError;
    expect(rateLimit.status).toBe(429);
    expect(rateLimit.retryAfterMs).toBe(45_000);
    expect(rateLimit.endpoint).toBe("/api/0/organizations/");
    expect(rateLimit.format()).toContain("Limit is 100 requests in 60 seconds");
    expect(rateLimit.format()).toContain(
      "Retry in 45 seconds; do not repeat the request before then. Make fewer requests in parallel.",
    );
  });

  test("throws RateLimitError once retries are exhausted", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return jsonResponse(
        { detail: "slow down" },
        { status: 429, headers: { "Retry-After": "0" } },
      );
    });

    const error = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).format()).toContain("Retry in 1 second;");
    // MAX_RETRIES = 2 → attempts 0, 1, 2.
    expect(calls).toBe(3);
  });

  test("backs off on concurrency-limit 429s instead of waiting for the reset", async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      if (calls > 1) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse(
        { detail: "Too many concurrent requests" },
        {
          status: 429,
          headers: {
            "X-Sentry-Rate-Limit-Remaining": "30",
            "X-Sentry-Rate-Limit-ConcurrentRemaining": "0",
            "X-Sentry-Rate-Limit-Reset": String(
              Math.floor(Date.now() / 1000) + 3600,
            ),
          },
        },
      );
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("retries a POST on 429, since the request was rejected before processing", async () => {
    const bodies: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      bodies.push(await new Request(input as string, init).text());
      return bodies.length === 1
        ? jsonResponse(
            { detail: "slow down" },
            { status: 429, headers: { "Retry-After": "0" } },
          )
        : jsonResponse({ ok: true });
    });

    const res = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/acme/issues/1/autofix/`,
      { method: "POST", body: '{"step":"root_cause"}' },
    );

    expect(res.status).toBe(200);
    expect(bodies).toEqual(['{"step":"root_cause"}', '{"step":"root_cause"}']);
  });

  test("says to retry in a few seconds when the 429 has no wait hint", async () => {
    globalThis.fetch = mockFetch(async () =>
      jsonResponse({ detail: "slow down" }, { status: 429 }),
    );

    const error = await getAuthenticatedFetch()(
      `${REGION_URL}/api/0/organizations/`,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBeUndefined();
    expect((error as RateLimitError).format()).toContain(
      "Retry in a few seconds; do not repeat the request before then.",
    );
  });
});

describe("fetchWithTimeout internal timeout classification", () => {
  test("surfaces TimeoutError on the last attempt when our own timeout fires", async () => {
    // Inject a tiny timeout so we don't wait 30 s for the default to fire.
    const marker = "___timeout-test___";
    const restore = __injectTimeoutOverrideForTests({
      pattern: new RegExp(`/${marker}/`),
      timeoutMs: 50,
    });

    try {
      let calls = 0;
      globalThis.fetch = mockFetch(async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("no signal provided — test bug"));
            return;
          }
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      });

      const authFetch = getAuthenticatedFetch();
      let thrown: unknown;
      try {
        await authFetch(`${REGION_URL}/${marker}/`);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TimeoutError);
      expect((thrown as TimeoutError).message).toContain(
        "Request timed out after",
      );
      // MAX_RETRIES = 2 → attempts 0, 1, 2.
      expect(calls).toBe(3);
    } finally {
      restore();
    }
  });

  test("does not retry a timed-out POST and warns it may have applied", async () => {
    const marker = "___post-timeout-test___";
    const restore = __injectTimeoutOverrideForTests({
      pattern: new RegExp(`/${marker}/`),
      timeoutMs: 50,
    });

    try {
      let calls = 0;
      globalThis.fetch = mockFetch(async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      });

      const error = await getAuthenticatedFetch()(`${REGION_URL}/${marker}/`, {
        method: "POST",
        body: "{}",
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).hint).toContain(
        "may still have been applied",
      );
      expect(calls).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("user abort passthrough", () => {
  test("external AbortSignal.abort() propagates the original AbortError", async () => {
    const marker = "__test_user_abort__";
    let fetchCalled = false;
    globalThis.fetch = mockFetch(async (_input, init) => {
      fetchCalled = true;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const controller = new AbortController();
    const authFetch = getAuthenticatedFetch();
    const promise = authFetch(`${REGION_URL}/api/0/${marker}/organizations/`, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    let thrown: unknown;
    try {
      await promise;
    } catch (err) {
      thrown = err;
    }

    expect(fetchCalled).toBe(true);
    // User aborts must propagate unchanged — neither a TimeoutError nor an
    // ApiError wrapper. The central error handler in app.ts depends on it.
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
  });
});

describe("API request tracing", () => {
  afterEach(() => {
    initSentry(false);
  });

  async function tracedRequest(): Promise<{
    headers: Headers;
    activeSpanOp: string | undefined;
  }> {
    let headers = new Headers();
    let activeSpanOp: string | undefined;
    globalThis.fetch = mockFetch(async (input, init) => {
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const span = getActiveSpan();
      activeSpanOp = span
        ? spanToJSON(span).attributes?.[SEMANTIC_ATTRIBUTE_SENTRY_OP]
        : undefined;
      return jsonResponse({ ok: true });
    });
    await startSpan({ name: "host", op: "test" }, () =>
      getAuthenticatedFetch()(`${REGION_URL}/api/0/organizations/`),
    );
    return { headers, activeSpanOp };
  }

  test("adds its own http.client span and trace headers in library mode", async () => {
    initSentry(true, { libraryMode: true });
    const { headers, activeSpanOp } = await tracedRequest();
    expect(headers.get("sentry-trace")).toBeTruthy();
    expect(headers.get("baggage")).toBeTruthy();
    expect(activeSpanOp).toBe("http.client");
  });

  test("leaves HTTP spans and headers to the SDK integrations in CLI mode", async () => {
    initSentry(true);
    const { headers, activeSpanOp } = await tracedRequest();
    expect(headers.get("sentry-trace")).toBeNull();
    expect(activeSpanOp).toBe("test");
  });
});

describe("resolveTimeoutMs", () => {
  test("returns 120 000 ms for Seer /autofix/ POST paths", () => {
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/organizations/acme/issues/1/autofix/",
      ),
    ).toBe(120_000);
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/organizations/acme/issues/1/autofix/?run_id=42",
      ),
    ).toBe(120_000);
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/organizations/acme/issues/1/autofix",
      ),
    ).toBe(120_000);
  });

  test("returns the 30 000 ms default for non-overridden paths", () => {
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/organizations/",
      ),
    ).toBe(30_000);
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/issues/1/events/",
      ),
    ).toBe(30_000);
    // Substring-only matches must not inherit the override.
    expect(
      __resolveRequestTimeoutMsForTests(
        "https://us.sentry.io/api/0/autofixation-report/",
      ),
    ).toBe(30_000);
  });
});
