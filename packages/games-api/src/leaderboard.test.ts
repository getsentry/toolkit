import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import app from "./index";
import type { Env } from "./leaderboard";

const TOKEN = "sntrys_test_token_value";
const SCORE_FIELD = "max(value,snake.score,distribution,-)";
const HANDLE_FIELD = "tags[handle,string]";

const CACHE_URL = "https://games.sentry.new/__cache/snake/leaderboard/v1";

function cacheResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    SENTRY_GAMES_READ_TOKEN: TOKEN,
    ...overrides,
  } as unknown as Env;
}

function upstreamBody(rows: Array<[unknown, unknown]>) {
  return {
    data: rows.map(([handle, score]) => ({
      [HANDLE_FIELD]: handle,
      [SCORE_FIELD]: score,
    })),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PATH = "/v1/snake/leaderboard";
const REQ = { headers: { "CF-Connecting-IP": "192.0.2.1" } };

describe("games leaderboard route", () => {
  const fetchMock = vi.fn();
  const cacheMatch = vi.fn();
  const cachePut = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    cacheMatch.mockReset().mockResolvedValue(undefined);
    cachePut.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cached data without calling upstream", async () => {
    const cached = {
      period: "30d",
      entries: [{ rank: 1, handle: "brave-otter-4242", score: 57 }],
    };
    cacheMatch.mockResolvedValue(cacheResponse(cached));
    const res = await app.request(PATH, REQ, makeEnv());
    expect(cacheMatch).toHaveBeenCalledWith(CACHE_URL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(cached);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an invalid cached value as a miss", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(upstreamBody([["brave-otter-4242", 57]])),
    );
    cacheMatch.mockResolvedValue(cacheResponse({ bogus: true }));
    const res = await app.request(PATH, REQ, makeEnv());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches upstream on a miss and writes the cache", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(upstreamBody([["brave-otter-4242", 57]])),
    );
    const res = await app.request(PATH, REQ, makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({
      period: "30d",
      entries: [{ rank: 1, handle: "brave-otter-4242", score: 57 }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://us.sentry.io/api/0/organizations/sentry/events/",
    );
    expect(parsed.searchParams.get("dataset")).toBe("tracemetrics");
    expect(parsed.searchParams.get("project")).toBe("4510776311808000");
    expect(parsed.searchParams.getAll("field")).toEqual([
      HANDLE_FIELD,
      SCORE_FIELD,
    ]);
    expect(parsed.searchParams.get("query")).toBe(
      "metric.name:snake.score metric.type:distribution value:<=10000",
    );
    expect(parsed.searchParams.get("statsPeriod")).toBe("30d");
    expect(parsed.searchParams.get("sort")).toBe(`-${SCORE_FIELD}`);
    expect(parsed.searchParams.get("per_page")).toBe("50");
    expect((init as RequestInit).headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });

    expect(cachePut).toHaveBeenCalledTimes(1);
    const [key, cachedResponse] = cachePut.mock.calls[0];
    expect(key).toBe(CACHE_URL);
    expect((cachedResponse as Response).headers.get("Cache-Control")).toBe(
      "max-age=300",
    );
    expect(await (cachedResponse as Response).json()).toEqual({
      period: "30d",
      entries: [{ rank: 1, handle: "brave-otter-4242", score: 57 }],
    });
  });

  it("filters invalid rows, dedupes, caps at 10 and assigns ranks", async () => {
    const rows: Array<[unknown, unknown]> = [
      ["Bad-Handle-0101", 900],
      ["no-digits-xx", 800],
      ["old-format-42", 850],
      ["too-high-0101", 10001],
      ["zero-score-0101", 0],
      ["float-score-0101", 700.9],
      ["float-score-0101", 600],
      ["string-score-0101", "500"],
      [42, 400],
    ];
    const names = [
      "aa",
      "bb",
      "cc",
      "dd",
      "ee",
      "ff",
      "gg",
      "hh",
      "ii",
      "jj",
      "kk",
      "ll",
    ];
    names.forEach((n, i) => rows.push([`${n}-${n}-100${i % 10}`, 300 - i]));
    fetchMock.mockResolvedValue(jsonResponse(upstreamBody(rows)));

    const res = await app.request(PATH, REQ, makeEnv());
    const body = (await res.json()) as {
      entries: Array<{ rank: number; handle: string; score: number }>;
    };
    expect(body.entries).toHaveLength(10);
    expect(body.entries[0]).toEqual({
      rank: 1,
      handle: "float-score-0101",
      score: 700,
    });
    expect(body.entries.map((e) => e.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(body.entries.map((e) => e.handle)).not.toContain("Bad-Handle-0101");
    expect(body.entries.map((e) => e.handle)).not.toContain("old-format-42");
  });

  it("returns 502 without leaking upstream details or the token", async () => {
    fetchMock.mockResolvedValue(
      new Response(`secret-upstream-detail ${TOKEN}`, { status: 500 }),
    );
    const res = await app.request(PATH, REQ, makeEnv());
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: "Leaderboard unavailable" });
    expect(text).not.toContain("secret-upstream-detail");
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
  });

  it("returns 502 for invalid JSON and schema mismatch", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect((await app.request(PATH, REQ, makeEnv())).status).toBe(502);
    fetchMock.mockResolvedValueOnce(jsonResponse({ nope: [] }));
    expect((await app.request(PATH, REQ, makeEnv())).status).toBe(502);
  });

  it("returns 502 when fetch throws or times out", async () => {
    fetchMock.mockRejectedValue(
      new DOMException(`secret-upstream-detail ${TOKEN}`, "TimeoutError"),
    );
    const res = await app.request(PATH, REQ, makeEnv());
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain("secret-upstream-detail");
    expect(text).not.toContain(TOKEN);
  });

  it("returns 503 when the token is not configured", async () => {
    const res = await app.request(
      PATH,
      REQ,
      makeEnv({ SENTRY_GAMES_READ_TOKEN: undefined }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Leaderboard unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited and skips upstream", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const res = await app.request(
      PATH,
      REQ,
      makeEnv({ GAMES_RATE_LIMITER: { limit } }),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a hashed IP rate limit key", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    await app.request(PATH, REQ, makeEnv({ GAMES_RATE_LIMITER: { limit } }));
    expect(limit.mock.calls[0][0].key).toMatch(/^games:ip:[a-f0-9]{16}$/);
    expect(limit.mock.calls[0][0].key).not.toContain("192.0.2.1");
  });

  it("fails open when the cache throws", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(upstreamBody([["brave-otter-4242", 57]])),
    );
    cacheMatch.mockRejectedValue(new Error("cache down"));
    cachePut.mockRejectedValue(new Error("cache down"));
    const res = await app.request(PATH, REQ, makeEnv());
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await app.request("/nope", REQ, makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
