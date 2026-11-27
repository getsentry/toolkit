import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./fetch-retry.js";
import type { RetryPolicy } from "./retry.js";

const URL_ = "https://api.example.com/items/";

const policy: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 10,
  maxTotalDelayMs: 100,
};

/** A fetch that answers with each response in turn, and records what it was sent. */
function scripted(...responses: (() => Response | Promise<Response>)[]) {
  const sent: { method: string; body: string }[] = [];
  const fetch = vi.fn(
    async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({ method: request.method, body: await request.text() });
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected request");
      }
      return await next();
    },
  );
  return { fetch, sent };
}

/** A fetch that never answers until its signal aborts. */
function hanging() {
  return vi.fn(
    (_input: Request | string | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- mirrors fetch, which rejects with the signal's reason
        const abort = () => reject(signal?.reason);
        if (signal?.aborted) {
          abort();
        }
        signal?.addEventListener("abort", abort);
      }),
  );
}

describe("withRetry", () => {
  it("retries a transient 503 for a GET and returns the success", async () => {
    const { fetch } = scripted(
      () => new Response("down", { status: 503 }),
      () => new Response("ok"),
    );
    const onRetry = vi.fn();
    const retrying = withRetry(fetch, { policy, onRetry });

    const response = await retrying(URL_);

    expect(await response.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 0, status: 503 }),
    );
  });

  it("returns the last failure once the retries are used up", async () => {
    const { fetch } = scripted(
      ...Array.from(
        { length: 3 },
        () => () => new Response("", { status: 502 }),
      ),
    );

    const response = await withRetry(fetch, { policy })(URL_);

    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not replay a write the handler may have run", async () => {
    const { fetch } = scripted(() => new Response("", { status: 503 }));

    const response = await withRetry(fetch, { policy })(URL_, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("replays a write the caller marks idempotent, with its body each time", async () => {
    const { fetch, sent } = scripted(
      () => new Response("", { status: 503 }),
      () => new Response("ok"),
    );
    const isIdempotent = vi.fn(() => true);

    await withRetry(fetch, { policy, isIdempotent })(
      new Request(URL_, { method: "PUT", body: "payload" }),
    );

    expect(isIdempotent).toHaveBeenCalledWith({ method: "PUT", url: URL_ });
    expect(sent).toEqual([
      { method: "PUT", body: "payload" },
      { method: "PUT", body: "payload" },
    ]);
  });

  it("replays a stream body by reading it once", async () => {
    const { fetch, sent } = scripted(
      () => new Response("", { status: 500 }),
      () => new Response("ok"),
    );

    await withRetry(fetch, { policy, idempotent: true })(URL_, {
      method: "POST",
      body: new Response("streamed").body,
      // Node needs `duplex` for a stream body.
      duplex: "half",
    });

    expect(sent.map((request) => request.body)).toEqual([
      "streamed",
      "streamed",
    ]);
  });

  it("replays a stream body that overrides a Request input's body", async () => {
    const { fetch, sent } = scripted(
      () => new Response("", { status: 500 }),
      () => new Response("ok"),
    );

    await withRetry(fetch, { policy, idempotent: true })(
      new Request(URL_, { method: "POST", body: "original" }),
      {
        body: new Response("override").body,
        // Node needs `duplex` for a stream body.
        duplex: "half",
      },
    );

    expect(sent.map((request) => request.body)).toEqual([
      "override",
      "override",
    ]);
  });

  it("stops at once when the caller aborts", async () => {
    const fetch = hanging();
    const controller = new AbortController();
    const reason = new Error("cancelled");

    const pending = withRetry(fetch, { policy })(URL_, {
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws an error the caller marks permanent without retrying", async () => {
    const failure = new Error("certificate has expired");
    const fetch = vi.fn(async () => {
      throw failure;
    });

    await expect(
      withRetry(fetch, { policy, isRetryableError: () => false })(URL_),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the delay the server asks for", async () => {
    const { fetch } = scripted(
      () => new Response("", { status: 429, headers: { "x-wait-ms": "7" } }),
      () => new Response("ok"),
    );
    const onRetry = vi.fn();

    await withRetry(fetch, {
      policy,
      serverDelayMs: (response) => Number(response.headers.get("x-wait-ms")),
      onRetry,
      random: () => 0,
    })(URL_);

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 7, status: 429 }),
    );
  });
});
