import { describe, expect, test } from "vitest";
import { MAX_SEARCH_TERMS, searchDocTree } from "../sentry-docs/doctree";

describe("searchDocTree", () => {
  test("bounds token scoring for long natural-language questions", () => {
    expect(MAX_SEARCH_TERMS).toBeLessThanOrEqual(24);
  });

  test("ranks matching visible pages and returns canonical docs URLs", () => {
    const results = searchDocTree(
      {
        children: [
          {
            frontmatter: {
              description: "Set up Sentry for Next.js applications.",
              title: "Next.js",
            },
            path: "/platforms/javascript/guides/nextjs/",
          },
          {
            frontmatter: {
              description: "Configure Next.js tracing.",
              title: "Tracing",
            },
            path: "/platforms/javascript/guides/nextjs/tracing/",
          },
          {
            frontmatter: { sidebar_hidden: true, title: "Hidden" },
            path: "/internal/nextjs/",
          },
        ],
        path: "/",
      },
      "nextjs",
      1,
    );

    expect(results).toEqual([
      {
        description: "Set up Sentry for Next.js applications.",
        title: "Next.js",
        url: "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
      },
    ]);
  });

  test("breaks equal-score ties by path", () => {
    const results = searchDocTree(
      {
        children: [
          { frontmatter: { title: "Tracing" }, path: "/z/tracing/" },
          { frontmatter: { title: "Tracing" }, path: "/a/tracing/" },
        ],
        path: "/",
      },
      "tracing",
      2,
    );

    expect(results.map((result) => result.url)).toEqual([
      "https://docs.sentry.io/a/tracing/",
      "https://docs.sentry.io/z/tracing/",
    ]);
  });

  test("finds relevant pages for a natural-language docs question", () => {
    const results = searchDocTree(
      {
        children: [
          {
            frontmatter: {
              description: "Set up Sentry for Next.js applications.",
              title: "Next.js",
            },
            path: "/platforms/javascript/guides/nextjs/",
          },
          {
            frontmatter: {
              description: "Configure tracing in your Next.js app.",
              title: "Tracing",
            },
            path: "/platforms/javascript/guides/nextjs/tracing/",
          },
        ],
        path: "/",
      },
      "How do I configure Next.js tracing?",
      1,
    );

    expect(results).toEqual([
      {
        description: "Configure tracing in your Next.js app.",
        title: "Tracing",
        url: "https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/",
      },
    ]);
  });
});
