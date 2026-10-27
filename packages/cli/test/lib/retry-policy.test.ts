import { describe, expect, test } from "vitest";
import {
  backoffDelayMs,
  decideStatusRetry,
  isRetryableMethod,
  serverRetryDelayMs,
} from "../../src/lib/retry-policy.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const NOW_SECONDS = NOW / 1000;

describe("isRetryableMethod", () => {
  test("retries only safe methods by default", () => {
    expect(isRetryableMethod("GET")).toBe(true);
    expect(isRetryableMethod("head")).toBe(true);
    expect(isRetryableMethod("OPTIONS")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isRetryableMethod(method)).toBe(false);
    }
  });

  test("retries any method when the caller opts in", () => {
    expect(isRetryableMethod("POST", true)).toBe(true);
  });
});

describe("backoffDelayMs", () => {
  test("jitters within the upper half of the capped step", () => {
    expect(backoffDelayMs(0, 10_000, () => 0)).toBe(500);
    expect(backoffDelayMs(0, 10_000, () => 1)).toBe(1000);
    expect(backoffDelayMs(1, 10_000, () => 1)).toBe(2000);
    expect(backoffDelayMs(10, 10_000, () => 0)).toBe(5000);
    expect(backoffDelayMs(10, 10_000, () => 1)).toBe(10_000);
  });
});

describe("serverRetryDelayMs", () => {
  test("reads Retry-After seconds", () => {
    const headers = new Headers({ "Retry-After": "3" });
    expect(serverRetryDelayMs(503, headers, NOW)).toBe(3000);
  });

  test("reads a Retry-After HTTP date against the server Date header", () => {
    const headers = new Headers({
      Date: new Date(NOW).toUTCString(),
      "Retry-After": new Date(NOW + 2000).toUTCString(),
    });
    // Local clock is an hour ahead; the server Date keeps the wait at 2s.
    expect(serverRetryDelayMs(429, headers, NOW + 3_600_000)).toBe(2000);
  });

  test("reads X-Sentry-Rate-Limit-Reset when the window is exhausted", () => {
    const headers = new Headers({
      "X-Sentry-Rate-Limit-Remaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS + 1),
    });
    expect(serverRetryDelayMs(429, headers, NOW)).toBe(1000);
  });

  test("guards the reset against a skewed local clock", () => {
    const headers = new Headers({
      Date: new Date(NOW).toUTCString(),
      "X-Sentry-Rate-Limit-Remaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS + 1),
    });
    expect(serverRetryDelayMs(429, headers, NOW - 3_600_000)).toBe(1000);
    expect(serverRetryDelayMs(429, headers, NOW + 3_600_000)).toBe(1000);
  });

  test("ignores the reset for concurrency-limit 429s", () => {
    const headers = new Headers({
      "X-Sentry-Rate-Limit-Remaining": "12",
      "X-Sentry-Rate-Limit-ConcurrentRemaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS + 60),
    });
    expect(serverRetryDelayMs(429, headers, NOW)).toBeUndefined();
  });

  test("ignores the reset on non-429 statuses", () => {
    const headers = new Headers({
      "X-Sentry-Rate-Limit-Remaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS + 5),
    });
    expect(serverRetryDelayMs(503, headers, NOW)).toBeUndefined();
  });

  test("drops past and malformed values", () => {
    const headers = new Headers({
      "Retry-After": "soon",
      "X-Sentry-Rate-Limit-Remaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS - 5),
    });
    expect(serverRetryDelayMs(429, headers, NOW)).toBeUndefined();
  });

  test("uses the longest of Retry-After and the reset", () => {
    const headers = new Headers({
      "Retry-After": "4",
      "X-Sentry-Rate-Limit-Remaining": "0",
      "X-Sentry-Rate-Limit-Reset": String(NOW_SECONDS + 1),
    });
    expect(serverRetryDelayMs(429, headers, NOW)).toBe(4000);
  });
});

describe("decideStatusRetry", () => {
  const base = {
    headers: new Headers(),
    methodRetryable: true,
    attempt: 0,
    maxRetries: 2,
    maxDelayMs: 10_000,
    nowMs: NOW,
    random: () => 1,
  };

  test("does not retry non-transient statuses", () => {
    for (const status of [404, 501, 505]) {
      expect(decideStatusRetry({ ...base, status })).toEqual({
        retry: false,
      });
    }
  });

  test("backs off without a server hint", () => {
    expect(decideStatusRetry({ ...base, status: 503 })).toEqual({
      retry: true,
      delayMs: 1000,
    });
  });

  test("waits for the server-requested delay", () => {
    const headers = new Headers({ "Retry-After": "2" });
    expect(decideStatusRetry({ ...base, status: 429, headers })).toEqual({
      retry: true,
      delayMs: 2000,
    });
  });

  test("gives up when the server-requested delay exceeds the cap", () => {
    const headers = new Headers({ "Retry-After": "60" });
    expect(decideStatusRetry({ ...base, status: 429, headers })).toEqual({
      retry: false,
      retryAfterMs: 60_000,
    });
  });

  test("does not retry non-idempotent methods on 5xx", () => {
    const headers = new Headers({ "Retry-After": "1" });
    expect(
      decideStatusRetry({
        ...base,
        status: 503,
        headers,
        methodRetryable: false,
      }),
    ).toEqual({ retry: false, retryAfterMs: 1000 });
  });

  test("retries 429 for non-idempotent methods", () => {
    const headers = new Headers({ "Retry-After": "1" });
    expect(
      decideStatusRetry({
        ...base,
        status: 429,
        headers,
        methodRetryable: false,
      }),
    ).toEqual({ retry: true, delayMs: 1000 });
  });

  test("stops when retries are exhausted", () => {
    expect(decideStatusRetry({ ...base, status: 502, attempt: 2 })).toEqual({
      retry: false,
    });
  });
});
