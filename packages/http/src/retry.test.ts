import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  isIdempotentRequest,
  nextRetryDelayMs,
  parseRetryAfterMs,
  type RetryPolicy,
  serverDelayUntil,
  sleep,
} from "./retry.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0, 300);
const NOW_SECONDS = Math.floor(NOW / 1000);

const policy: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 2000,
  maxTotalDelayMs: 3000,
};

describe("parseRetryAfterMs", () => {
  it("reads Retry-After in seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "3" }), NOW)).toBe(
      3000,
    );
  });

  it("reads Retry-After as an HTTP-date", () => {
    const headers = new Headers({
      "Retry-After": new Date(NOW + 5300).toUTCString(),
    });

    // HTTP-dates drop milliseconds, so this is 12:00:05.000.
    expect(parseRetryAfterMs(headers, NOW)).toBe(4700);
  });

  it("returns undefined for a missing or malformed header", () => {
    expect(parseRetryAfterMs(new Headers(), NOW)).toBeUndefined();
    expect(
      parseRetryAfterMs(new Headers({ "Retry-After": "soon" }), NOW),
    ).toBeUndefined();
  });
});

describe("serverDelayUntil", () => {
  const target = (NOW_SECONDS + 1) * 1000;

  it("keeps the local estimate without a response Date", () => {
    expect(serverDelayUntil(target, new Headers(), NOW)).toBe(700);
  });

  it("measures against the response Date when the local clock is skewed", () => {
    const serverNow = NOW + 10 * 60 * 1000;
    const headers = new Headers({ Date: new Date(serverNow).toUTCString() });

    expect(
      serverDelayUntil((Math.floor(serverNow / 1000) + 1) * 1000, headers, NOW),
    ).toBe(1000);
  });

  it("bounds the delay by the response Date when the local clock lags slightly", () => {
    // Local clock 1.5s behind: alone it would put a 1s window 2.2s away.
    const headers = new Headers({ Date: new Date(NOW).toUTCString() });

    expect(serverDelayUntil(target, headers, NOW - 1500)).toBe(1000);
  });

  it("bounds the delay by the response Date when the local clock runs ahead", () => {
    const headers = new Headers({ Date: new Date(NOW).toUTCString() });

    // 2.5s ahead would put the target 1.8s in the past; the Date puts it
    // 0-1s away, so the estimate is clamped to the lower bound.
    expect(serverDelayUntil(target, headers, NOW + 2500)).toBe(0);
  });

  it("keeps the local estimate when it agrees with the response Date", () => {
    const headers = new Headers({ Date: new Date(NOW).toUTCString() });

    expect(serverDelayUntil(target, headers, NOW)).toBe(700);
  });

  it("treats a target already in the past as no wait", () => {
    expect(serverDelayUntil((NOW_SECONDS - 5) * 1000, new Headers(), NOW)).toBe(
      0,
    );
  });
});

describe("nextRetryDelayMs", () => {
  const base = {
    policy,
    method: "GET",
    status: 429,
    serverDelayMs: undefined,
    attempt: 0,
    waitedMs: 0,
    random: () => 0,
  };

  it("waits for the server delay plus jitter of at most half the base step", () => {
    expect(nextRetryDelayMs({ ...base, serverDelayMs: 700 })).toBe(700);
    expect(
      nextRetryDelayMs({ ...base, serverDelayMs: 700, random: () => 1 }),
    ).toBe(825);
  });

  it("falls back to equal-jitter exponential backoff", () => {
    expect(nextRetryDelayMs({ ...base, attempt: 0 })).toBe(125);
    expect(nextRetryDelayMs({ ...base, attempt: 0, random: () => 1 })).toBe(
      250,
    );
    expect(nextRetryDelayMs({ ...base, attempt: 1, random: () => 1 })).toBe(
      500,
    );
  });

  it("caps the backoff step at maxDelayMs", () => {
    expect(
      nextRetryDelayMs({
        ...base,
        policy: { ...policy, maxRetries: 10, maxTotalDelayMs: 60_000 },
        attempt: 6,
        random: () => 1,
      }),
    ).toBe(2000);
  });

  it("stops when the server delay exceeds the per-wait cap", () => {
    expect(
      nextRetryDelayMs({ ...base, serverDelayMs: 30_000 }),
    ).toBeUndefined();
  });

  it("stops when the wait would exceed the total budget", () => {
    expect(
      nextRetryDelayMs({
        ...base,
        attempt: 1,
        serverDelayMs: 1000,
        waitedMs: 2500,
      }),
    ).toBeUndefined();
  });

  it("stops after maxRetries", () => {
    expect(nextRetryDelayMs({ ...base, attempt: 2 })).toBeUndefined();
  });

  it("retries reads in any case", () => {
    for (const method of ["GET", "head", "OPTIONS"]) {
      expect(nextRetryDelayMs({ ...base, method })).toBe(125);
    }
  });

  it("retries a rate-limited write only when the caller maps 429 to any", () => {
    const retryableStatuses = new Map([[429, "any" as const]]);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(
        nextRetryDelayMs({ ...base, method, status: 429 }),
      ).toBeUndefined();
      expect(
        nextRetryDelayMs({ ...base, method, status: 429, retryableStatuses }),
      ).toBe(125);
    }
  });

  it("never retries a write on a 5xx without the idempotent opt-in", () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      for (const status of [500, 502, 503, 504]) {
        expect(nextRetryDelayMs({ ...base, method, status })).toBeUndefined();
      }
    }
    expect(
      nextRetryDelayMs({
        ...base,
        method: "POST",
        status: 503,
        idempotent: true,
      }),
    ).toBe(125);
  });

  it("retries a GET on a transient 5xx", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(nextRetryDelayMs({ ...base, status })).toBe(125);
    }
  });

  it("retries a network error or timeout only for idempotent requests", () => {
    expect(nextRetryDelayMs({ ...base, status: undefined })).toBe(125);
    expect(
      nextRetryDelayMs({ ...base, method: "POST", status: undefined }),
    ).toBeUndefined();
    expect(
      nextRetryDelayMs({
        ...base,
        method: "POST",
        status: undefined,
        idempotent: true,
      }),
    ).toBe(125);
  });

  it("does not retry deterministic 5xx codes or other 4xx", () => {
    for (const status of [400, 404, 501, 505]) {
      expect(nextRetryDelayMs({ ...base, status })).toBeUndefined();
    }
  });
});

describe("isIdempotentRequest", () => {
  it("replays only GET, HEAD, and OPTIONS by default", () => {
    for (const method of ["GET", "head", "OPTIONS"]) {
      expect(isIdempotentRequest(method)).toBe(true);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isIdempotentRequest(method)).toBe(false);
    }
  });

  it("replays any method when the caller opts in", () => {
    expect(isIdempotentRequest("POST", true)).toBe(true);
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves after the delay", async () => {
    const started = performance.now();
    const resolved = vi.fn();
    const promise = sleep(30).then(resolved);

    await delay(0);
    expect(resolved).not.toHaveBeenCalled();
    await promise;
    expect(resolved).toHaveBeenCalled();
    // Timers may fire up to a millisecond early.
    expect(performance.now() - started).toBeGreaterThanOrEqual(29);
  });

  it("rejects with the abort reason as soon as the signal aborts", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const controller = new AbortController();
    const promise = sleep(60_000, controller.signal);
    const reason = new Error("cancelled");

    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));

    await expect(sleep(1000, controller.signal)).rejects.toThrow("gone");
  });
});

describe("fetchWithRetry", () => {
  const fast: RetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 2,
    maxDelayMs: 50,
    maxTotalDelayMs: 100,
  };

  function responses(...items: (Response | Error)[]) {
    return vi.fn(async (_attempt: number) => {
      const next = items.shift();
      if (!next) {
        throw new Error("unexpected request");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    });
  }

  it("retries a GET after a transient failure and returns the success", async () => {
    const send = responses(
      new Response(null, { status: 503 }),
      new TypeError("fetch failed"),
      new Response("ok"),
    );
    const onRetry = vi.fn();

    const response = await fetchWithRetry(send, {
      policy: fast,
      method: "GET",
      onRetry,
    });

    expect(await response.text()).toBe("ok");
    expect(send.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1, 2]);
    expect(onRetry.mock.calls.map(([retry]) => retry.status)).toEqual([
      503,
      undefined,
    ]);
  });

  it("returns the last failure once retries are used up", async () => {
    const send = responses(
      new Response(null, { status: 502 }),
      new Response(null, { status: 502 }),
      new Response(null, { status: 502 }),
    );

    const response = await fetchWithRetry(send, {
      policy: fast,
      method: "GET",
    });

    expect(response.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not replay a write the server may have run", async () => {
    const send = responses(new Response(null, { status: 503 }));

    const response = await fetchWithRetry(send, {
      policy: fast,
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledOnce();
  });

  it("replays an idempotent write", async () => {
    const send = responses(
      new Response(null, { status: 503 }),
      new Response("ok"),
    );

    const response = await fetchWithRetry(send, {
      policy: fast,
      method: "PUT",
      idempotent: true,
    });

    expect(response.status).toBe(200);
  });

  it("waits for Retry-After, and gives up when it exceeds maxDelayMs", async () => {
    const onRetry = vi.fn();
    const send = responses(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
      new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    );

    const response = await fetchWithRetry(send, {
      policy: fast,
      method: "GET",
      random: () => 0,
      onRetry,
    });

    expect(response.status).toBe(429);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 0,
      delayMs: 0,
      status: 429,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses the caller's server delay", async () => {
    const serverDelayMs = vi.fn(() => 1);
    const send = responses(
      new Response(null, { status: 429 }),
      new Response("ok"),
    );

    await fetchWithRetry(send, {
      policy: fast,
      method: "GET",
      serverDelayMs,
    });

    expect(serverDelayMs).toHaveBeenCalledOnce();
  });

  it("throws an error the caller marks as not retryable", async () => {
    const failure = new Error("certificate has expired");
    const send = responses(failure);

    await expect(
      fetchWithRetry(send, {
        policy: fast,
        method: "GET",
        isRetryableError: (error) => error !== failure,
      }),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce();
  });

  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const send = responses(new Response(null, { status: 503 }));

    const pending = fetchWithRetry(send, {
      policy: {
        ...fast,
        baseDelayMs: 10_000,
        maxDelayMs: 10_000,
        maxTotalDelayMs: 60_000,
      },
      method: "GET",
      signal: controller.signal,
      onRetry: () => controller.abort(reason),
    });

    await expect(pending).rejects.toBe(reason);
  });
});
