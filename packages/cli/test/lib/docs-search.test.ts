import { describe, expect, test } from "vitest";
import { searchDocs } from "../../src/lib/docs-search.js";
import { fixtureDocsIndex } from "../fixtures/docs/index.js";

const index = fixtureDocsIndex();

const ORIGIN = "https://docs.sentry.io";

function urls(query: string, patterns?: string[], limit = 8): string[] {
  return searchDocs(index, { query, patterns, limit }).results.map((result) =>
    result.url.slice(ORIGIN.length),
  );
}

describe("searchDocs", () => {
  test("returns Markdown URLs, titles, and breadcrumbs", () => {
    const [first] = searchDocs(index, {
      query: "nextjs tracing",
      limit: 1,
    }).results;
    expect(first).toEqual({
      title: "Set Up Tracing",
      description: expect.stringContaining("Next.js"),
      url: `${ORIGIN}/platforms/javascript/guides/nextjs/tracing.md`,
      breadcrumbs: ["Platforms", "Browser JavaScript", "Guides", "Next.js"],
    });
  });

  test.each([
    "nextjs tracing",
    "next.js tracing",
    "next js tracing",
    "'nextjs tracing'",
    '"nextjs tracing"',
    "\u201cnextjs tracing\u201d",
    '"nextjs tracing',
    "How do I set up tracing in Next.js?",
    "add tracing to my next.js app",
  ])("finds the same page for %s", (query) => {
    expect(urls(query)[0]).toBe(
      "/platforms/javascript/guides/nextjs/tracing.md",
    );
  });

  test("ranks pages that match more of the words first", () => {
    expect(urls("tracing cloudflare tanstack start").slice(0, 2)).toEqual([
      "/platforms/javascript/guides/cloudflare/frameworks/tanstack-start.md",
      "/platforms/javascript/guides/tanstackstart-react/tracing.md",
    ]);
  });

  test("prefers a whole path segment over part of one", () => {
    expect(urls("react tracing")[0]).toBe(
      "/platforms/javascript/guides/react/tracing.md",
    );
    expect(urls("react native tracing")[0]).toBe(
      "/platforms/react-native/tracing.md",
    );
  });

  test("corrects a typo and says so", () => {
    const outcome = searchDocs(index, { query: "djnago", limit: 3 });
    expect(outcome.results[0]?.title).toBe("Django");
    expect(outcome.warnings).toEqual(['Searched "django" for "djnago".']);
  });

  test("collapses a page that repeats under every guide", () => {
    const results = urls("vite source maps");
    expect(results[0]).toBe(
      "/platforms/javascript/sourcemaps/uploading/vite.md",
    );
    expect(results.filter((url) => url.endsWith("/vite.md"))).toHaveLength(1);
    expect(urls("vite source maps nextjs")[0]).toBe(
      "/platforms/javascript/guides/nextjs/sourcemaps/uploading/vite.md",
    );
  });

  test("skips hidden and old versioned pages", () => {
    expect(urls("django internal")).toEqual([
      "/platforms/python/integrations/django.md",
    ]);
  });

  test("returns a pasted docs URL as that page", () => {
    expect(urls(`${ORIGIN}/platforms/python/integrations/celery/`)).toEqual([
      "/platforms/python/integrations/celery.md",
    ]);
    expect(urls("/platforms/python/integrations/celery.md")).toEqual([
      "/platforms/python/integrations/celery.md",
    ]);
  });

  test("returns the home page for its own Markdown URL", () => {
    expect(urls(`${ORIGIN}/index.md`)).toEqual(["/index.md"]);
  });

  test("returns nothing for a query with only filler words", () => {
    const outcome = searchDocs(index, { query: "how do I", limit: 8 });
    expect(outcome.results).toEqual([]);
    expect(outcome.warnings).toHaveLength(1);
  });

  test("keeps old `docs list` and `docs query` invocations working", () => {
    expect(urls("list nextjs tracing")[0]).toBe(
      "/platforms/javascript/guides/nextjs/tracing.md",
    );
  });

  test("searches words that are Object.prototype keys in a cached index", () => {
    // A cached index is plain parsed JSON, so it inherits Object.prototype.
    const cached = JSON.parse(JSON.stringify(index));
    expect(() =>
      searchDocs(cached, { query: "constructor tostring celery", limit: 1 }),
    ).not.toThrow();
    expect(
      searchDocs(cached, { query: "constructor celery", limit: 1 }).results[0]
        ?.title,
    ).toBe("Celery");
  });

  test("respects the limit", () => {
    expect(urls("tracing", undefined, 2)).toHaveLength(2);
  });
});

describe("searchDocs patterns", () => {
  test("filters by URL path, case-insensitively", () => {
    expect(urls("", ["(Cloudflare|tanstackstart[^/]*)/tracing$"])).toEqual([
      "/platforms/javascript/guides/cloudflare/tracing.md",
      "/platforms/javascript/guides/tanstackstart-react/tracing.md",
    ]);
  });

  test("ORs several patterns", () => {
    expect(urls("", ["integrations/django$", "integrations/celery$"])).toEqual([
      "/platforms/python/integrations/celery.md",
      "/platforms/python/integrations/django.md",
    ]);
  });

  test("matches titles too", () => {
    expect(urls("", ["^fastapi$"])).toEqual([
      "/platforms/python/integrations/fastapi.md",
    ]);
  });

  test("ranks pattern matches by the words", () => {
    expect(urls("celery", ["/python/"])[0]).toBe(
      "/platforms/python/integrations/celery.md",
    );
  });

  test("keeps the last segment of a path pattern", () => {
    expect(urls("", ["/python/integrations/django"])).toEqual([
      "/platforms/python/integrations/django.md",
    ]);
    expect(urls("", ["/guides/nextjs"])).toContain(
      "/platforms/javascript/guides/nextjs.md",
    );
    expect(urls("", ["/guides/nextjs"])).not.toContain(
      "/platforms/javascript/guides/react.md",
    );
  });

  test.each([
    "'/python/integrations/django$/'",
    "/\\/python\\/integrations\\/django$/i",
    `${ORIGIN}/platforms/python/integrations/django.md`,
  ])("accepts the pattern %s", (pattern) => {
    expect(urls("", [pattern])).toEqual([
      "/platforms/python/integrations/django.md",
    ]);
  });

  test("searches an invalid pattern as words", () => {
    const outcome = searchDocs(index, {
      query: "",
      patterns: ["guides/(nextjs/manual-setup"],
      limit: 1,
    });
    expect(outcome.results[0]?.url).toBe(
      `${ORIGIN}/platforms/javascript/guides/nextjs/manual-setup.md`,
    );
    expect(outcome.warnings[0]).toContain("is not a valid regular expression");
  });
});
