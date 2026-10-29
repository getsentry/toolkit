import { describe, expect, it, vi } from "vitest";
import { type ApiRequestTransport, createApiClientCore } from "./core.js";
import {
  ApiNotFoundError,
  ApiRateLimitError,
  ApiServerError,
  ConfigurationError,
} from "./errors.js";

const ORIGIN = "https://us.sentry.io";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** A core over a transport that answers every request with `respond`. */
function setup(respond: ApiRequestTransport["request"]) {
  const transport = { request: vi.fn(respond) };
  const logger = { warn: vi.fn() };
  const core = createApiClientCore({
    transport,
    headers: () => ({ Authorization: "Bearer token", "User-Agent": "test" }),
    logger,
  });
  return { core, transport, logger };
}

describe("createApiClientCore request", () => {
  it("sends the host's headers to the API URL, replacing the caller's", async () => {
    const { core, transport } = setup(async () => jsonResponse({}));
    const signal = new AbortController().signal;

    await core.request(ORIGIN, "/organizations/acme/", {
      method: "PUT",
      body: "{}",
      signal,
      headers: { "X-Dropped": "1" },
    });

    expect(transport.request).toHaveBeenCalledWith(
      "https://us.sentry.io/api/0/organizations/acme/",
      {
        method: "PUT",
        body: "{}",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
          "User-Agent": "test",
        },
      },
    );
  });

  it("throws the host's header error before sending", async () => {
    const transport = { request: vi.fn() };
    const core = createApiClientCore({
      transport,
      headers: () => {
        throw new ConfigurationError("Malformed authentication token");
      },
      logger: { warn: vi.fn() },
    });

    await expect(core.request(ORIGIN, "/")).rejects.toThrow(
      "Malformed authentication token",
    );
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("throws the status's ApiError with the server's detail", async () => {
    const { core, logger } = setup(async () =>
      jsonResponse({ detail: "Project not found" }, { status: 404 }),
    );

    const error = await core
      .request(ORIGIN, "/projects/acme/x/")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiNotFoundError);
    expect(error).toMatchObject({
      message: "Project not found",
      status: 404,
      detail: "Project not found",
      responseBody: { detail: "Project not found" },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns an allowed error status instead of throwing", async () => {
    const { core } = setup(async () =>
      jsonResponse({ detail: "Gone" }, { status: 404 }),
    );

    const response = await core.request(ORIGIN, "/x/", undefined, {
      allowStatuses: [404],
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Gone" });
  });

  it("carries a rate limit's wait on the error", async () => {
    const { core } = setup(async () =>
      jsonResponse(
        { detail: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": "3" } },
      ),
    );

    const error = await core.request(ORIGIN, "/x/").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 3000 });
  });

  it("reports an HTML error page as a server error and logs it", async () => {
    const { core, logger } = setup(
      async () =>
        new Response("<!DOCTYPE html><html>Bad gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
        }),
    );

    const error = await core.request(ORIGIN, "/x/").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiServerError);
    expect((error as Error).message).toBe(
      "Server error: Received HTML instead of JSON (502 Bad Gateway). This may indicate an invalid URL or server issue.",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Received HTML error page instead of JSON",
      expect.objectContaining({
        status: 502,
        host: "us.sentry.io",
        path: "/x/",
      }),
    );
  });

  it("falls back to the status text and body for an unreadable error", async () => {
    const { core, logger } = setup(
      async () =>
        new Response("upstream timed out", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    );

    const error = await core.request(ORIGIN, "/x/").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiServerError);
    expect((error as Error).message).toBe(
      "API request failed: Service Unavailable\nupstream timed out",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to parse JSON error response",
      expect.objectContaining({ bodyPreview: "upstream timed out" }),
    );
  });

  it("logs a JSON error body with no string detail", async () => {
    const { core, logger } = setup(async () =>
      jsonResponse({ detail: { code: "x" } }, { status: 400 }),
    );

    await expect(core.request(ORIGIN, "/x/")).rejects.toThrow(
      "API request failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to parse validated API error response",
      expect.objectContaining({
        validationErrorMessage: "Error response has no string detail",
      }),
    );
  });

  it("reports an unreachable host as a configuration error", async () => {
    const { core } = setup(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND us.sentry.io"),
      });
    });

    const error = await core.request(ORIGIN, "/x/").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toBe(
      "Unable to connect to https://us.sentry.io/api/0/x/ - Hostname not found. Verify the URL is correct.",
    );
  });

  it("names the URL for other network failures", async () => {
    const { core } = setup(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("read ECONNRESET"),
      });
    });

    const error = await core.request(ORIGIN, "/x/").catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toBe(
      "Unable to connect to https://us.sentry.io/api/0/x/ - Connection reset. Try again in a moment.",
    );
  });

  it("rethrows the caller's abort unchanged", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stopped", "AbortError");
    const { core } = setup(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(
      core.request(ORIGIN, "/x/", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe("createApiClientCore requestJson", () => {
  it("returns the parsed body", async () => {
    const { core } = setup(async () => jsonResponse([{ slug: "acme" }]));

    expect(await core.requestJson(ORIGIN, "/organizations/")).toEqual([
      { slug: "acme" },
    ]);
  });

  it("rejects a successful response that is not JSON", async () => {
    const { core } = setup(
      async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(core.requestJson(ORIGIN, "/organizations/")).rejects.toThrow(
      "Expected JSON response but received HTML",
    );
  });
});
