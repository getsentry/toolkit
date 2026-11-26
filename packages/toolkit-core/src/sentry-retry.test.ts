import { describe, expect, it, vi } from "vitest";
import { withSentryRetry } from "./sentry-retry";

const URL_ = "https://us.sentry.io/api/0/organizations/acme/issues/";

const policy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 1000,
  maxTotalDelayMs: 1000,
};

function answering(...statuses: number[]) {
  return vi.fn(
    async (_input: Request | string | URL, _init?: RequestInit) =>
      new Response(null, {
        status: statuses.shift() ?? 200,
        headers: {
          "x-sentry-rate-limit-remaining": "0",
          "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000)),
        },
      }),
  );
}

describe("withSentryRetry", () => {
  it("replays a rate-limited write, since Sentry rejects it before the view runs", async () => {
    const request = answering(429);

    const response = await withSentryRetry({ request }, { policy }).request(
      URL_,
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not replay a write after a 5xx", async () => {
    const request = answering(503);

    const response = await withSentryRetry({ request }, { policy }).request(
      URL_,
      {
        method: "PUT",
      },
    );

    expect(response.status).toBe(503);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("replays a write the request marks idempotent, and passes its options on", async () => {
    const request = vi.fn(
      async (
        _input: Request | string | URL,
        _init?: RequestInit,
        _options?: { idempotent?: boolean },
      ) =>
        new Response(null, {
          status: request.mock.calls.length === 1 ? 503 : 200,
        }),
    );

    const response = await withSentryRetry({ request }, { policy }).request(
      URL_,
      { method: "PUT" },
      { idempotent: true },
    );

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[2]).toEqual({ idempotent: true });
  });
});
