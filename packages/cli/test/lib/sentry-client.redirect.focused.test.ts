import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { HostScopeError } from "../../src/lib/errors.js";
import {
  disableResponseCache,
  resetCacheState,
} from "../../src/lib/response-cache.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("redirect-focused-");
const originalFetch = globalThis.fetch;

describe("authenticated discovery redirects", () => {
  beforeEach(() => {
    disableResponseCache();
    resetAuthenticatedFetch();
    setAuthToken("redirect-token", undefined, undefined, {
      host: "https://sentry.io",
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCacheState();
    resetAuthenticatedFetch();
  });

  test("validates and follows a trusted hop with the pinned bearer", async () => {
    const requests: Request[] = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return requests.length === 1
          ? Response.redirect("https://de.sentry.io/api/0/organizations/", 307)
          : Response.json([]);
      },
    );
    const response = await getSdkConfig("https://sentry.io", {
      validatedRedirects: true,
    }).fetch("https://sentry.io/api/0/organizations/");
    expect(response.status).toBe(200);
    expect(requests.map((request) => request.url)).toEqual([
      "https://sentry.io/api/0/organizations/",
      "https://de.sentry.io/api/0/organizations/",
    ]);
    expect(
      requests.every(
        (request) =>
          request.redirect === "manual" &&
          request.headers.get("authorization") === "Bearer redirect-token",
      ),
    ).toBe(true);
  });

  test("rejects an untrusted hop before sending credentials", async () => {
    setAuthToken("self-hosted-token", undefined, undefined, {
      host: "https://control.example.com",
    });
    const destinations: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        destinations.push(new Request(input, init).url);
        return Response.redirect("https://evil.example.net/steal", 302);
      },
    );
    await expect(
      getSdkConfig("https://control.example.com", {
        validatedRedirects: true,
      }).fetch("https://control.example.com/api/0/organizations/"),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(destinations).toEqual([
      "https://control.example.com/api/0/organizations/",
    ]);
  });

  test("restarts a retry from the original request after a redirect", async () => {
    const destinations: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        destinations.push(new Request(input, init).url);
        if (destinations.length === 1 || destinations.length === 3) {
          return Response.redirect(
            "https://de.sentry.io/api/0/organizations/",
            307,
          );
        }
        return destinations.length === 2
          ? new Response("retry", { status: 503 })
          : Response.json([]);
      },
    );
    const response = await getSdkConfig("https://sentry.io", {
      validatedRedirects: true,
    }).fetch("https://sentry.io/api/0/organizations/");
    expect(response.status).toBe(200);
    expect(destinations).toEqual([
      "https://sentry.io/api/0/organizations/",
      "https://de.sentry.io/api/0/organizations/",
      "https://sentry.io/api/0/organizations/",
      "https://de.sentry.io/api/0/organizations/",
    ]);
  });

  test("rejects a redirect loop before repeating the request", async () => {
    const destinations: string[] = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        destinations.push(request.url);
        return Response.redirect(request.url, 307);
      },
    );
    await expect(
      getSdkConfig("https://sentry.io", { validatedRedirects: true }).fetch(
        "https://sentry.io/api/0/organizations/",
      ),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(destinations).toEqual(["https://sentry.io/api/0/organizations/"]);
  });

  test.each([
    { status: 303, expectedMethod: "GET", expectedBody: "" },
    { status: 307, expectedMethod: "POST", expectedBody: "payload" },
  ])(
    "preserves fetch redirect semantics for $status",
    async ({ status, expectedMethod, expectedBody }) => {
      const requests: Array<{
        method: string;
        body: string;
        contentType: string | null;
      }> = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const request = new Request(input);
        requests.push({
          method: request.method,
          body: request.body ? await request.text() : "",
          contentType: request.headers.get("content-type"),
        });
        return requests.length === 1
          ? Response.redirect("https://sentry.io/api/0/redirected/", status)
          : Response.json({ ok: true });
      });

      const response = await getSdkConfig("https://sentry.io", {
        validatedRedirects: true,
      }).fetch("https://sentry.io/api/0/organizations/", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "payload",
      });

      expect(response.status).toBe(200);
      expect(requests[1]).toEqual({
        method: expectedMethod,
        body: expectedBody,
        contentType: status === 303 ? null : "text/plain",
      });
    },
  );

  test("cancels an untrusted redirect body without masking the trust error", async () => {
    setAuthToken("self-hosted-token", undefined, undefined, {
      host: "https://control.example.com",
    });
    const cancellation = { observed: false };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancellation.observed = true;
            },
          }),
          {
            status: 302,
            headers: { Location: "https://evil.example.net/steal" },
          },
        ),
    );

    await expect(
      getSdkConfig("https://control.example.com", {
        validatedRedirects: true,
      }).fetch("https://control.example.com/api/0/organizations/"),
    ).rejects.toBeInstanceOf(HostScopeError);
    expect(cancellation.observed).toBe(true);
  });
});
