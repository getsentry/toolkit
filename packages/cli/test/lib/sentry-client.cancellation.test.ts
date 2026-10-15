import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getAuthConfig, setAuthToken } from "../../src/lib/db/auth.js";
import {
  disableResponseCache,
  getCachedResponse,
  resetCacheState,
  storeCachedResponse,
} from "../../src/lib/response-cache.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("sentry-client-cancellation-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
  "SENTRY_CLIENT_ID",
  "SENTRY_NO_CACHE",
]);

const BASE_URL = "https://sentry.io";
const RESOURCE_URL = `${BASE_URL}/api/0/organizations/synthetic-org/projects/`;
const originalFetch = globalThis.fetch;

function deferred<T>() {
  const state: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });
  return { promise, resolve: (value: T) => state.resolve?.(value) };
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

beforeEach(() => {
  process.env.SENTRY_CLIENT_ID = "synthetic-client";
  resetCacheState();
  disableResponseCache();
  resetAuthenticatedFetch();
  setAuthToken("synthetic-token", undefined, undefined, { host: BASE_URL });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCacheState();
  resetAuthenticatedFetch();
});

describe("authenticated fetch cancellation", () => {
  test.each([
    { name: "Error", reason: new Error("cancelled") },
    { name: "string", reason: "cancelled" },
    { name: "null", reason: null },
    { name: "false", reason: false },
    { name: "zero", reason: 0 },
  ])(
    "pre-aborted $name reaches neither auth refresh nor fetch",
    async ({ reason }) => {
      setAuthToken("expired-access", -1, "synthetic-refresh", {
        host: BASE_URL,
      });
      const calls = vi.fn(async () => Response.json([]));
      globalThis.fetch = mockFetch(calls);
      const controller = new AbortController();
      controller.abort(reason);
      const fetch = getSdkConfig(BASE_URL).fetch;

      await expect(
        fetch(new Request(RESOURCE_URL, { signal: controller.signal })),
      ).rejects.toBe(reason);
      await expect(
        fetch(RESOURCE_URL, { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(calls).not.toHaveBeenCalled();
      expect(getAuthConfig()?.token).toBe("expired-access");
    },
  );

  test.each([undefined, {}])(
    "inherits a Request signal with init %j",
    async (init) => {
      const started = deferred<AbortSignal>();
      globalThis.fetch = mockFetch(async (input, options) => {
        const signal = new Request(input, options).signal;
        started.resolve(signal);
        return await waitForAbort(signal);
      });
      const controller = new AbortController();
      const reason = new Error("request cancelled");
      const outcome = getSdkConfig(BASE_URL)
        .fetch(new Request(RESOURCE_URL, { signal: controller.signal }), init)
        .catch((error: unknown) => error);
      const dispatchedSignal = await started.promise;

      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(dispatchedSignal.reason).toBe(reason);
    },
  );

  test.each([null, new AbortController().signal])(
    "an explicit signal override clears a Request's cancelled signal: %j",
    async (signal) => {
      const controller = new AbortController();
      controller.abort("inherited cancellation");
      const signals: AbortSignal[] = [];
      globalThis.fetch = mockFetch(async (input, options) => {
        signals.push(new Request(input, options).signal);
        return Response.json({ ok: true });
      });

      const response = await getSdkConfig(BASE_URL).fetch(
        new Request(RESOURCE_URL, { signal: controller.signal }),
        { signal },
      );

      expect(await response.json()).toEqual({ ok: true });
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
    },
  );

  test.each(["cancelled", null, false, 0])(
    "in-flight reason %j is preserved without retrying",
    async (reason) => {
      const started = deferred<AbortSignal>();
      const calls = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const signal = new Request(input, init).signal;
          started.resolve(signal);
          return await waitForAbort(signal);
        },
      );
      globalThis.fetch = mockFetch(calls);
      const controller = new AbortController();
      const outcome = getSdkConfig(BASE_URL)
        .fetch(RESOURCE_URL, {
          signal: controller.signal,
        })
        .catch((error: unknown) => error);
      await started.promise;

      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(calls).toHaveBeenCalledTimes(1);
    },
  );

  test("cancelling one request does not cancel a sibling on the shared fetch", async () => {
    const started = deferred<AbortSignal>();
    const siblingStarted = deferred<AbortSignal>();
    const releaseSibling = deferred<Response>();
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("?sibling=1")) {
        siblingStarted.resolve(request.signal);
        return await releaseSibling.promise;
      }
      started.resolve(request.signal);
      return await waitForAbort(request.signal);
    });
    const fetch = getSdkConfig(BASE_URL).fetch;
    const controller = new AbortController();
    const reason = new Error("only this request");
    const outcome = fetch(RESOURCE_URL, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    const sibling = fetch(`${RESOURCE_URL}?sibling=1`);
    await started.promise;
    const siblingSignal = await siblingStarted.promise;

    controller.abort(reason);

    expect(await outcome).toBe(reason);
    expect(siblingSignal.aborted).toBe(false);
    releaseSibling.resolve(Response.json({ sibling: true }));
    expect(await (await sibling).json()).toEqual({ sibling: true });
  });

  test("cancellation interrupts retry backoff before another dispatch", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const calls = vi.fn(async () => {
      started.resolve();
      return new Response(null, { status: 503 });
    });
    globalThis.fetch = mockFetch(calls);
    const controller = new AbortController();
    const reason = new Error("stop retries");
    const outcome = getSdkConfig(BASE_URL)
      .fetch(RESOURCE_URL, {
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);

    controller.abort(reason);

    expect(await outcome).toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  test("cancellation between validated redirect hops stops the next dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("stop redirects");
    const destinations: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      destinations.push(request.url);
      return new Response(
        new ReadableStream({
          cancel() {
            controller.abort(reason);
          },
        }),
        {
          status: 307,
          headers: { location: "https://de.sentry.io/api/0/organizations/" },
        },
      );
    });

    await expect(
      getSdkConfig(BASE_URL, { validatedRedirects: true }).fetch(
        new Request(RESOURCE_URL, { signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(destinations).toEqual([RESOURCE_URL]);
  });

  test("validated redirects honor an explicit null signal", async () => {
    const inherited = new AbortController();
    inherited.abort("inherited cancellation");
    const destinations: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      destinations.push(request.url);
      expect(request.signal.aborted).toBe(false);
      return destinations.length === 1
        ? Response.redirect("https://de.sentry.io/api/0/organizations/", 307)
        : Response.json([]);
    });

    const response = await getSdkConfig(BASE_URL, {
      validatedRedirects: true,
    }).fetch(new Request(RESOURCE_URL, { signal: inherited.signal }), {
      signal: null,
    });

    expect(response.status).toBe(200);
    expect(destinations).toHaveLength(2);
  });

  test.each(["proactive", "401"] as const)(
    "%s refresh survives cancellation of one waiter and serves its sibling",
    async (mode) => {
      setAuthToken(
        "old-access",
        mode === "proactive" ? -1 : 3600,
        "shared-refresh",
        {
          host: BASE_URL,
        },
      );
      const refreshStarted = deferred<Request>();
      const releaseRefresh = deferred<Response>();
      const initialRequests = deferred<void>();
      const resources: Array<{ url: string; authorization: string | null }> =
        [];
      let refreshCalls = 0;
      globalThis.fetch = mockFetch(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/oauth/token/")) {
          refreshCalls += 1;
          refreshStarted.resolve(request);
          return await releaseRefresh.promise;
        }
        const authorization = request.headers.get("authorization");
        resources.push({ url: request.url, authorization });
        if (mode === "401" && authorization === "Bearer old-access") {
          if (resources.length === 2) {
            initialRequests.resolve();
          }
          return Response.json({ detail: "expired" }, { status: 401 });
        }
        return Response.json({ authorization });
      });
      const fetch = getSdkConfig(BASE_URL).fetch;
      const controller = new AbortController();
      const reason = new Error("cancel this waiter");
      const cancelled = fetch(RESOURCE_URL, {
        signal: controller.signal,
      }).catch((error: unknown) => error);
      const sibling = fetch(`${RESOURCE_URL}?sibling=1`);
      const refreshRequest = await refreshStarted.promise;
      if (mode === "401") {
        await initialRequests.promise;
      }

      controller.abort(reason);

      // The cancelled waiter settles while the shared OAuth exchange is pending.
      expect(await cancelled).toBe(reason);
      expect(refreshRequest.signal.aborted).toBe(false);
      releaseRefresh.resolve(
        Response.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "bearer",
        }),
      );
      expect(await (await sibling).json()).toEqual({
        authorization: "Bearer new-access",
      });
      expect(refreshCalls).toBe(1);
      expect(
        resources.filter(
          ({ authorization }) => authorization === "Bearer new-access",
        ),
      ).toEqual([
        {
          url: `${RESOURCE_URL}?sibling=1`,
          authorization: "Bearer new-access",
        },
      ]);
      expect(getAuthConfig()?.token).toBe("new-access");
    },
  );

  test("caller cancellation remains connected after response headers", async () => {
    const calls = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = new Request(input, init).signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                {
                  once: true,
                },
              );
            },
          }),
        );
      },
    );
    globalThis.fetch = mockFetch(calls);
    const controller = new AbortController();
    const response = await getSdkConfig(BASE_URL).fetch(RESOURCE_URL, {
      signal: controller.signal,
    });
    const body = response.text().catch((error: unknown) => error);
    const reason = new Error("stop reading");

    controller.abort(reason);

    expect(await body).toBe(reason);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  test("older Node runtimes preserve cancellation during fetch and body reads", async () => {
    const composeSignals = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined });
    try {
      const started = deferred<AbortSignal>();
      globalThis.fetch = mockFetch(async (input, init) => {
        const signal = new Request(input, init).signal;
        started.resolve(signal);
        return await waitForAbort(signal);
      });
      const controller = new AbortController();
      const reason = new Error("older runtime cancellation");
      const pending = getSdkConfig(BASE_URL).fetch(
        new Request(RESOURCE_URL, { signal: controller.signal }),
      );
      const outcome = expect(pending).rejects.toBe(reason);
      await started.promise;
      controller.abort(reason);
      await outcome;

      const bodyController = new AbortController();
      globalThis.fetch = mockFetch(async (input, init) => {
        const signal = new Request(input, init).signal;
        return new Response(
          new ReadableStream({
            start(stream) {
              signal.addEventListener(
                "abort",
                () => stream.error(signal.reason),
                {
                  once: true,
                },
              );
            },
          }),
        );
      });
      const response = await getSdkConfig(BASE_URL).fetch(RESOURCE_URL, {
        signal: bodyController.signal,
      });
      const body = expect(response.text()).rejects.toBe(reason);
      bodyController.abort(reason);
      await body;
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: composeSignals });
    }
  });

  test("a caller abort remains the winner when fetch rejects after the timeout deadline", async () => {
    vi.useFakeTimers();
    const started = deferred<AbortSignal>();
    const releaseRejection = deferred<void>();
    const calls = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const signal = new Request(input, init).signal;
        started.resolve(signal);
        await releaseRejection.promise;
        throw signal.reason;
      },
    );
    globalThis.fetch = mockFetch(calls);
    const controller = new AbortController();
    const reason = new Error("caller won");
    const outcome = getSdkConfig(BASE_URL)
      .fetch(RESOURCE_URL, {
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await started.promise;

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(30_001);
    releaseRejection.resolve();

    expect(await outcome).toBe(reason);
    expect(Object.getOwnPropertySymbols(reason)).toEqual([]);
    expect(reason).not.toHaveProperty("timeoutMs");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  test("the existing timeout ends at headers rather than timing out body reads", async () => {
    vi.useFakeTimers();
    const received = deferred<AbortSignal>();
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>();
    globalThis.fetch = mockFetch(async (input, init) => {
      received.resolve(new Request(input, init).signal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body.resolve(controller);
          },
        }),
      );
    });
    const response = await getSdkConfig(BASE_URL).fetch(RESOURCE_URL);
    const signal = await received.promise;

    await vi.advanceTimersByTimeAsync(30_001);

    expect(signal.aborted).toBe(false);
    const stream = await body.promise;
    stream.enqueue(new TextEncoder().encode("complete"));
    stream.close();
    expect(await response.text()).toBe("complete");
  });

  test("pre-aborted requests cannot return a cached response", async () => {
    resetCacheState();
    await storeCachedResponse("GET", RESOURCE_URL, {}, Response.json([]));
    expect(await getCachedResponse("GET", RESOURCE_URL, {})).toBeDefined();
    const calls = vi.fn(async () => Response.json([]));
    globalThis.fetch = mockFetch(calls);
    const controller = new AbortController();
    controller.abort("cancel cached read");

    await expect(
      getSdkConfig(BASE_URL).fetch(RESOURCE_URL, { signal: controller.signal }),
    ).rejects.toBe("cancel cached read");
    expect(calls).not.toHaveBeenCalled();
  });

  test("a successful mutation still invalidates cache if cancellation follows its response", async () => {
    resetCacheState();
    const detail = `${BASE_URL}/api/0/organizations/synthetic-org/issues/123/`;
    const list = `${BASE_URL}/api/0/organizations/synthetic-org/issues/`;
    await storeCachedResponse("GET", detail, {}, Response.json({ id: "123" }));
    await storeCachedResponse("GET", list, {}, Response.json([]));
    expect(await getCachedResponse("GET", detail, {})).toBeDefined();
    const controller = new AbortController();
    const calls = vi.fn(async () => {
      const response = new Response(null, { status: 204 });
      controller.abort("mutation already completed");
      return response;
    });
    globalThis.fetch = mockFetch(calls);

    await expect(
      getSdkConfig(BASE_URL).fetch(detail, {
        method: "PUT",
        signal: controller.signal,
      }),
    ).rejects.toBe("mutation already completed");

    expect(calls).toHaveBeenCalledTimes(1);
    expect(await getCachedResponse("GET", detail, {})).toBeUndefined();
    expect(await getCachedResponse("GET", list, {})).toBeUndefined();
  });
});
