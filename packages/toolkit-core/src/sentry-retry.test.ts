import type { RetryRequest } from "@sentry/api/client";
import { describe, expect, it, vi } from "vitest";
import { sentryRetry } from "./sentry-retry";

const policy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 1000,
  maxTotalDelayMs: 1000,
};

function request(method: string, idempotent = false): RetryRequest {
  return {
    method,
    url: "https://us.sentry.io/api/0/organizations/acme/issues/",
    idempotent,
    signal: undefined,
  };
}

function answering(...statuses: number[]) {
  return vi.fn(
    async () =>
      new Response(null, {
        status: statuses.shift() ?? 200,
        headers: {
          "x-sentry-rate-limit-remaining": "0",
          "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000)),
        },
      }),
  );
}

describe("sentryRetry", () => {
  it("replays a rate-limited write, since Sentry rejects it before the view runs", async () => {
    const attempt = answering(429);

    const response = await sentryRetry({ policy })(attempt, request("POST"));

    expect(response.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not replay a write after a 5xx", async () => {
    const attempt = answering(503);

    const response = await sentryRetry({ policy })(attempt, request("PUT"));

    expect(response.status).toBe(503);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("replays a write the transport marks idempotent", async () => {
    const attempt = answering(503);

    const response = await sentryRetry({ policy })(
      attempt,
      request("PUT", true),
    );

    expect(response.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error the host calls permanent", async () => {
    const error = new Error("certificate has expired");
    const attempt = vi.fn(async (): Promise<Response> => {
      throw error;
    });

    await expect(
      sentryRetry({ policy, isRetryableError: (e) => e !== error })(
        attempt,
        request("GET"),
      ),
    ).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("tells onRetry which request it retries", async () => {
    const onRetry = vi.fn();
    const get = request("GET");

    await sentryRetry({ policy, onRetry })(answering(502), get);

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 0, status: 502 }),
      get,
    );
  });
});
