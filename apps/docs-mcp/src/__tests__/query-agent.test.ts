import { describe, expect, test, vi } from "vitest";

const { fetchDocPage, searchPages } = vi.hoisted(() => ({
  fetchDocPage: vi.fn(),
  searchPages: vi.fn(),
}));

vi.mock("../sentry-docs/doctree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry-docs/doctree")>()),
  searchPages,
}));

vi.mock("../sentry-docs/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry-docs/fetcher")>()),
  fetchDocPage,
}));

import { buildDocsQueryCacheKey } from "../agent/cache";
import {
  finalizeCitedAttempts,
  finalizeDocsAnswer,
  QUERY_MODEL_SETTINGS,
  QUERY_SYSTEM_PROMPT,
  recoverQueryFallbackSources,
} from "../agent/query-agent";

describe("finalizeDocsAnswer", () => {
  test("keeps fetched inline citations and appends a deterministic sources section", () => {
    const result = finalizeDocsAnswer(
      "Configure tracing as described in [the guide](https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/).",
      [
        "https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/",
        "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
      ],
    );

    expect(result.sources).toEqual([
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/",
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
    ]);
    expect(result.answer).toContain(
      "[the guide](https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/)",
    );
    expect(
      result.answer.endsWith(
        "## Sources\n\n- <https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/>\n- <https://docs.sentry.io/platforms/javascript/guides/nextjs/>",
      ),
    ).toBe(true);
  });

  test("does not strip an answer heading that merely starts with Sources", () => {
    const url = "https://docs.sentry.io/platforms/javascript/";
    const answer = `## Sources of Error\n\nRead [the guide](${url}).`;

    expect(finalizeDocsAnswer(answer, [url]).answer).toContain(
      "## Sources of Error",
    );
  });

  test("replaces an exact model-provided Sources section", () => {
    const url = "https://docs.sentry.io/platforms/javascript/";

    expect(
      finalizeDocsAnswer(
        `Read [the guide](${url}).\n\n## Sources\n\n- <https://example.com/>`,
        [url],
      ).answer,
    ).toBe(`Read [the guide](${url}).\n\n## Sources\n\n- <${url}>`);
  });

  test("accepts bare fetched URLs followed by sentence punctuation", () => {
    const url =
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/";

    expect(
      finalizeDocsAnswer(
        `Read [Configure tracing](${url}) for setup details. The canonical URL is ${url}, then follow the guide.`,
        [url],
      ),
    ).toEqual({
      answer: `Read [Configure tracing](${url}) for setup details. The canonical URL is ${url}, then follow the guide.\n\n## Sources\n\n- <${url}>`,
      sources: [url],
    });
  });

  test("rejects a docs citation that was not fetched", () => {
    expect(() =>
      finalizeDocsAnswer(
        "See [the guide](https://docs.sentry.io/platforms/python/).",
        ["https://docs.sentry.io/platforms/javascript/"],
      ),
    ).toThrow("was not fetched");
  });

  test("rejects an external inline citation", () => {
    expect(() =>
      finalizeDocsAnswer("See [an external page](https://example.com/).", [
        "https://docs.sentry.io/platforms/javascript/",
      ]),
    ).toThrow("not an allowed Sentry docs URL");
  });

  test("rejects an unfetched URL even when it is not Markdown link syntax", () => {
    expect(() =>
      finalizeDocsAnswer(
        "See [the guide](https://docs.sentry.io/platforms/javascript/) and https://example.com/.",
        ["https://docs.sentry.io/platforms/javascript/"],
      ),
    ).toThrow("not an allowed Sentry docs URL");
  });

  test("ignores URL-like values in quoted code strings", () => {
    const docsUrl = "https://docs.sentry.io/platforms/javascript/";
    const answer = `Set \`dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0'\`, then follow [the guide](${docsUrl}).`;

    expect(finalizeDocsAnswer(answer, [docsUrl])).toEqual({
      answer: `${answer}\n\n## Sources\n\n- <${docsUrl}>`,
      sources: [docsUrl],
    });
  });

  test("rejects an answer without an inline fetched citation", () => {
    expect(() =>
      finalizeDocsAnswer("Configure the SDK.", [
        "https://docs.sentry.io/platforms/javascript/",
      ]),
    ).toThrow("inline citation");
  });
});

describe("buildDocsQueryCacheKey", () => {
  test("normalizes a question and safe context without using raw project data", () => {
    expect(
      buildDocsQueryCacheKey(" How do I trace requests? ", {
        frameworks: ["Next.js", "react"],
        languages: ["TypeScript"],
        sentryConfigured: true,
      }),
    ).toBe(
      buildDocsQueryCacheKey("how  do\nI trace requests?", {
        frameworks: ["react", "next.js"],
        languages: ["typescript"],
        sentryConfigured: true,
      }),
    );
  });

  test("separates cached answers by the deployed docs version", () => {
    const context = { frameworks: ["nextjs"] };

    expect(
      buildDocsQueryCacheKey("How do I trace requests?", context, "version-a"),
    ).not.toBe(
      buildDocsQueryCacheKey("How do I trace requests?", context, "version-b"),
    );
  });
});

describe("query answer defaults", () => {
  test("instruct the model to produce a short answer within a bounded output budget", () => {
    expect(QUERY_MODEL_SETTINGS.maxOutputTokens).toBeLessThanOrEqual(700);
    expect(QUERY_SYSTEM_PROMPT).toContain("at most 6 short bullet points");
  });
});

describe("finalizeCitedAttempts", () => {
  test("requires a recovery attempt to cite only pages it fetched itself", async () => {
    const firstUrl = "https://docs.sentry.io/platforms/javascript/";
    const retryUrl =
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/";
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        fetchedUrls: [firstUrl],
        text: `See [the guide](${retryUrl}).`,
      })
      .mockResolvedValueOnce({
        fetchedUrls: [retryUrl],
        text: `See [the guide](${retryUrl}).`,
      });

    await expect(finalizeCitedAttempts(generateAttempt)).resolves.toEqual({
      cacheable: true,
      citationFallback: false,
      citationFallbackReason: null,
      citationRetries: 1,
      finalized: {
        answer: `See [the guide](${retryUrl}).\n\n## Sources\n\n- <${retryUrl}>`,
        sources: [retryUrl],
      },
    });
    expect(generateAttempt).toHaveBeenCalledTimes(2);
  });

  test("retries after an empty first draft", async () => {
    const retryUrl =
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/";
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({ fetchedUrls: [], text: "   " })
      .mockResolvedValueOnce({
        fetchedUrls: [retryUrl],
        text: `See [the guide](${retryUrl}).`,
      });

    await expect(finalizeCitedAttempts(generateAttempt)).resolves.toEqual({
      cacheable: true,
      citationFallback: false,
      citationFallbackReason: null,
      citationRetries: 1,
      finalized: {
        answer: `See [the guide](${retryUrl}).\n\n## Sources\n\n- <${retryUrl}>`,
        sources: [retryUrl],
      },
    });
  });

  test("falls back to retry-fetched docs after an empty retry draft", async () => {
    const firstUrl =
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/";
    const retryUrl =
      "https://docs.sentry.io/platforms/javascript/guides/astro/";
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        fetchedUrls: [firstUrl],
        text: `See [the guide](${retryUrl}).`,
      })
      .mockResolvedValueOnce({ fetchedUrls: [retryUrl], text: "   " });

    await expect(finalizeCitedAttempts(generateAttempt)).resolves.toEqual({
      cacheable: false,
      citationFallback: true,
      citationFallbackReason: "validation_failed",
      citationRetries: 1,
      finalized: {
        answer:
          "I couldn't produce a fully cited answer for that question. Please refer to [the Sentry documentation](https://docs.sentry.io/platforms/javascript/guides/astro/).\n\n## Sources\n\n- <https://docs.sentry.io/platforms/javascript/guides/astro/>",
        sources: [retryUrl],
      },
    });
  });

  test("recovers a grounded fallback when the retry fetched no docs", async () => {
    const recoveryUrl =
      "https://docs.sentry.io/platforms/javascript/guides/hono/";
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({ fetchedUrls: [], text: "   " })
      .mockResolvedValueOnce({ fetchedUrls: [], text: "   " });
    const resolveFallbackSources = vi.fn().mockResolvedValue([recoveryUrl]);

    await expect(
      finalizeCitedAttempts(generateAttempt, resolveFallbackSources),
    ).resolves.toEqual({
      cacheable: false,
      citationFallback: true,
      citationFallbackReason: "no_fetched_sources",
      citationRetries: 1,
      finalized: {
        answer:
          "I couldn't produce a fully cited answer for that question. Please refer to [the Sentry documentation](https://docs.sentry.io/platforms/javascript/guides/hono/).\n\n## Sources\n\n- <https://docs.sentry.io/platforms/javascript/guides/hono/>",
        sources: [recoveryUrl],
      },
    });
    expect(resolveFallbackSources).toHaveBeenCalledOnce();
  });

  test("preserves the verified failure when recovery cannot fetch a source", async () => {
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({ fetchedUrls: [], text: "   " })
      .mockResolvedValueOnce({ fetchedUrls: [], text: "   " });
    const resolveFallbackSources = vi.fn().mockResolvedValue([]);

    await expect(
      finalizeCitedAttempts(generateAttempt, resolveFallbackSources),
    ).rejects.toThrow("Docs query returned no fetched sources to cite.");
    expect(resolveFallbackSources).toHaveBeenCalledOnce();
  });

  test("returns a grounded fallback when both attempts cite an external signup URL", async () => {
    const firstUrl =
      "https://docs.sentry.io/platforms/javascript/guides/nextjs/";
    const astroUrl =
      "https://docs.sentry.io/platforms/javascript/guides/astro/";
    const generateAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        fetchedUrls: [firstUrl],
        text: "Create an account at [Sentry signup](https://sentry.io/signup/).",
      })
      .mockResolvedValueOnce({
        fetchedUrls: [astroUrl],
        text: "Start at [Sentry signup](https://sentry.io/signup/).",
      });

    await expect(finalizeCitedAttempts(generateAttempt)).resolves.toEqual({
      cacheable: false,
      citationFallback: true,
      citationFallbackReason: "external_host",
      citationRetries: 1,
      finalized: {
        answer:
          "I couldn't produce a fully cited answer for that question. Please refer to [the Sentry documentation](https://docs.sentry.io/platforms/javascript/guides/astro/).\n\n## Sources\n\n- <https://docs.sentry.io/platforms/javascript/guides/astro/>",
        sources: [astroUrl],
      },
    });
  });
});

describe("recoverQueryFallbackSources", () => {
  test("returns a source only after the matching docs page is fetched", async () => {
    const url = "https://docs.sentry.io/platforms/javascript/guides/hono/";
    searchPages.mockResolvedValue([{ title: "Hono", url }]);
    fetchDocPage.mockResolvedValue("# Hono");

    await expect(
      recoverQueryFallbackSources("How do I configure Hono tracing?"),
    ).resolves.toEqual([url]);

    expect(searchPages).toHaveBeenCalledWith(
      "How do I configure Hono tracing?",
      1,
    );
    expect(fetchDocPage).toHaveBeenCalledWith(
      "/platforms/javascript/guides/hono",
    );
  });

  test("does not return an unfetched search result", async () => {
    searchPages.mockResolvedValue([
      {
        title: "Hono",
        url: "https://docs.sentry.io/platforms/javascript/guides/hono/",
      },
    ]);
    fetchDocPage.mockRejectedValue(new Error("origin unavailable"));

    await expect(
      recoverQueryFallbackSources("How do I configure Hono tracing?"),
    ).resolves.toEqual([]);
  });
});
