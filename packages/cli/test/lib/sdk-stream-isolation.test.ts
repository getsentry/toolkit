/** Public SDK streaming lifecycle regressions with real commands and mocked HTTP. */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import createSentrySDK, {
  SentryError,
  type SentryOptions,
} from "../../src/index.js";
import type { TraceLog } from "../../src/types/sentry.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../helpers.js";

const HOST = "https://synthetic.example.invalid";
const ORG = "synthetic-org";
const TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ENDPOINT = `/organizations/${ORG}/projects/`;
const FIRST_TOKEN = "synthetic-stream-token-a";
const SECOND_TOKEN = "synthetic-stream-token-b";
const TRACE_LOG: TraceLog = {
  id: "log-1",
  "project.id": 1,
  trace: TRACE_ID,
  severity_number: 9,
  severity: "info",
  timestamp: "2025-01-30T14:32:15+00:00",
  timestamp_precise: 1_738_247_535_123_456_000,
  message: "Request received",
};

/** Allow a test to hold an HTTP response across an iterator return. */
function deferred() {
  let resolve = () => {
    // Replaced synchronously by the promise executor before this helper returns.
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SDK streaming invocation isolation", () => {
  const getConfigDir = useTestConfigDir("sdk-stream-isolation-", {
    isolateProjectRoot: true,
  });
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
    "SENTRY_CUSTOM_HEADERS",
    "SENTRY_NO_CACHE",
  ]);

  let originalFetch: typeof globalThis.fetch;
  let requests: Request[];
  let traceStatus: number;
  let traceResponses: number;
  let regionGate: ReturnType<typeof deferred> | undefined;
  let dashboardGate: ReturnType<typeof deferred> | undefined;
  let iterators: AsyncIterator<unknown>[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    traceStatus = 200;
    traceResponses = 0;
    regionGate = undefined;
    dashboardGate = undefined;
    iterators = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      let body: unknown;
      let status = 200;
      if (path === `/api/0/organizations/${ORG}/`) {
        await regionGate?.promise;
        body = { id: "1", slug: ORG, links: { regionUrl: HOST } };
      } else if (path === `/api/0/organizations/${ORG}/dashboards/1/`) {
        await dashboardGate?.promise;
        body = { id: "1", title: "Synthetic dashboard", widgets: [] };
      } else if (path === `/api/0/organizations/${ORG}/trace-logs/`) {
        traceResponses += 1;
        status = traceStatus;
        body =
          status === 200
            ? {
                data: [
                  {
                    ...TRACE_LOG,
                    id: `log-${traceResponses}`,
                    timestamp_precise:
                      (TRACE_LOG.timestamp_precise ?? 0) +
                      traceResponses * 1_000_000,
                  },
                ],
              }
            : { detail: "Invalid token" };
      } else if (path === `/api/0${ENDPOINT}`) {
        body = {
          owner:
            request.headers.get("Authorization") === `Bearer ${SECOND_TOKEN}`
              ? "second"
              : "first",
        };
      } else {
        status = 404;
        body = { detail: "Unexpected request" };
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    });
  });

  afterEach(async () => {
    regionGate?.resolve();
    dashboardGate?.resolve();
    for (const iterator of iterators) {
      await iterator.return?.();
    }
    globalThis.fetch = originalFetch;
  });

  /** Create a client without accessing the developer's project or credentials. */
  function client(token: string, options?: SentryOptions) {
    return createSentrySDK({
      cwd: getConfigDir(),
      url: HOST,
      token,
      ...options,
    });
  }

  /** Open the public typed or argument-based follow entry point. */
  function stream(
    sdk: ReturnType<typeof createSentrySDK>,
    entryPoint: "typed" | "run" = "typed"
  ): AsyncIterable<unknown> {
    const result =
      entryPoint === "typed"
        ? sdk.log.list({ follow: "1" }, `${ORG}/${TRACE_ID}`)
        : sdk.run("log", "list", `${ORG}/${TRACE_ID}`, "--follow", "1");
    const iterable = result as AsyncIterable<unknown>;
    iterators.push(iterable[Symbol.asyncIterator]());
    return iterable;
  }

  /** Exercise a new client immediately after streaming terminates. */
  function secondClientRequest() {
    return client(SECOND_TOKEN).api({ endpoint: ENDPOINT });
  }

  test.each([
    "typed",
    "run",
  ] as const)("%s consumer break finishes cleanup before the next call", async (entryPoint) => {
    const envBefore = { ...process.env };
    let received = false;
    for await (const item of stream(client(FIRST_TOKEN), entryPoint)) {
      expect(item).toMatchObject({ data: [{ id: "log-1" }] });
      received = true;
      break;
    }
    expect(received).toBe(true);
    expect(process.env).toEqual(envBefore);
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("AbortSignal completion leaves the next invocation usable", async () => {
    const controller = new AbortController();
    const iterator = stream(client(FIRST_TOKEN, { signal: controller.signal }))[
      Symbol.asyncIterator
    ]();
    expect((await iterator.next()).done).toBe(false);

    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("stream authentication errors finish cleanup before rejection", async () => {
    traceStatus = 401;
    const iterator = stream(client(FIRST_TOKEN))[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(SentryError);
    expect(traceResponses).toBe(1);
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("immediate iterator return stops before the producer starts", async () => {
    const iterator = stream(client(FIRST_TOKEN))[Symbol.asyncIterator]();
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(requests).toHaveLength(0);
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("return during region lookup waits for stream cleanup", async () => {
    regionGate = deferred();
    const iterator = stream(client(FIRST_TOKEN))[Symbol.asyncIterator]();
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    const returned = iterator.return?.();
    regionGate.resolve();
    await expect(returned).resolves.toMatchObject({ done: true });
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("dashboard abort during initial fetch stops before refresh starts", async () => {
    dashboardGate = deferred();
    const controller = new AbortController();
    const result = client(FIRST_TOKEN, {
      signal: controller.signal,
    }).dashboard.view({ refresh: "10" }, `${ORG}/`, "1");
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    iterators.push(iterator);
    await vi.waitFor(
      () => {
        expect(requests.at(-1)?.url).toContain("/dashboards/1/");
      },
      { timeout: 5000 }
    );

    controller.abort();
    dashboardGate.resolve();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });

  test("overlapping calls fail without altering the active stream", async () => {
    const iterator = stream(client(FIRST_TOKEN))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      data: [{ id: "log-1" }],
    });
    const second = client(SECOND_TOKEN);
    await expect(second.api({ endpoint: ENDPOINT })).rejects.toThrow(
      "Concurrent SDK calls are not supported"
    );
    const overlapping = stream(second)[Symbol.asyncIterator]();
    await expect(overlapping.next()).rejects.toThrow(
      "Concurrent SDK calls are not supported"
    );

    expect((await iterator.next()).value).toMatchObject({ id: "log-2" });
    expect(
      requests.map((request) => request.headers.get("Authorization"))
    ).toEqual(requests.map(() => `Bearer ${FIRST_TOKEN}`));
    await iterator.return?.();
    await expect(secondClientRequest()).resolves.toMatchObject({
      body: { owner: "second" },
    });
  });
});
