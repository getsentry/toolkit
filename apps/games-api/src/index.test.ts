import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "./index";
import type { Env } from "./leaderboard";

const INGEST_HOST = "o0.ingest.sentry.io";

describe("worker Sentry reporting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports upstream failures without request secrets", async () => {
    const envelopes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).host === INGEST_HOST) {
          envelopes.push(await new Response(init?.body).text());
          return new Response("{}");
        }
        return new Response("upstream down", { status: 500 });
      }),
    );
    vi.stubGlobal("caches", {
      default: { match: async () => undefined, put: async () => undefined },
    });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const env = {
      SENTRY_DSN: `https://public@${INGEST_HOST}/1`,
      SENTRY_GAMES_READ_TOKEN: "sntrys_test_token_value",
    } as unknown as Env;

    const res = await worker.fetch(
      new Request(
        "https://games.sentry.new/v1/snake/leaderboard?ip=192.0.2.9",
        {
          headers: {
            "CF-Connecting-IP": "192.0.2.1",
            Cookie: "session=synthetic-secret",
          },
        },
      ) as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    await Promise.all(pending);

    expect(res.status).toBe(502);
    const sent = envelopes.join("\n");
    expect(sent).toContain("UpstreamError");
    expect(sent).not.toContain("synthetic-secret");
    expect(sent).not.toContain("192.0.2.1");
    expect(sent).not.toContain("192.0.2.9");
    expect(sent).not.toContain("sntrys_test_token_value");
  });
});
