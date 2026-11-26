import { mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText } from "ai";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
import * as logging from "../../telem/logging";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { SearchAttributesOutput } from "../support/search-attributes/format";
import searchAttributes from "./search-attributes.js";
import { KEY_CAP_NOTE } from "../support/search-attributes/format";

vi.mock("@ai-sdk/openai", () => {
  const mockModel = vi.fn(() => "mocked-model");
  return {
    openai: mockModel,
    createOpenAI: vi.fn(() => mockModel),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    Output: { object: vi.fn(() => ({})) },
  };
});

const ATTRIBUTES_URL =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-items/attributes/";

const mockGenerateText = vi.mocked(generateText);

function mockAgentResponse(
  output: { best: string | null; candidates: string[] } | { hints: string[] },
) {
  return {
    text: JSON.stringify(output),
    experimental_output: output,
    finishReason: "stop" as const,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    warnings: [] as const,
  } as any;
}

/** A reply with no structured output, which the agent reports as a UserInputError. */
function noOutputResponse() {
  return {
    ...mockAgentResponse({ hints: [] }),
    experimental_output: undefined,
  };
}

function providerError() {
  return new APICallError({
    message: "Workspace budget exceeded",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 402,
    isRetryable: false,
  });
}

type AttributeFixture = Record<string, unknown>;

function userAttribute(
  key: string,
  attributeType: "string" | "number" = "string",
): AttributeFixture {
  return {
    key,
    name: key,
    attributeType,
    attributeSource: { source_type: "user" },
  };
}

/** `count` keys of one type, named so they sort before `payment.*`. */
function manyAttributes(
  count: number,
  attributeType: "string" | "number" = "string",
) {
  return Array.from({ length: count }, (_, i) =>
    userAttribute(
      `app.${attributeType}_${String(i).padStart(4, "0")}`,
      attributeType,
    ),
  );
}

/** A full page of string keys, so the list looks cut off. */
const FULL_PAGE = manyAttributes(1000);

/**
 * One attribute for each kind of detail the output shows: aliases and
 * examples, a deprecation with its replacement, and a custom key with none.
 */
const HTTP_ATTRIBUTES: AttributeFixture[] = [
  {
    key: "http.request.method",
    name: "http.request.method",
    attributeType: "string",
    attributeSource: { source_type: "sentry" },
    secondaryAliases: ["method"],
    context: { brief: "The HTTP request method.", examples: ["GET", "POST"] },
  },
  {
    key: "http.method",
    name: "http.method",
    attributeType: "string",
    attributeSource: { source_type: "sentry" },
    context: {
      brief: "The HTTP method used.",
      isDeprecated: true,
      replacementAttribute: "http.request.method",
    },
  },
  userAttribute("app.tier"),
];

function keys(attributes: { key: string }[]): string[] {
  return attributes.map(({ key }) => key);
}

/** Serve attributes per `substringMatch` and record each one requested. */
function serveAttributes(
  respond: (substring: string | null) => AttributeFixture[] | Response,
) {
  const substrings: (string | null)[] = [];
  mswServer.use(
    http.get(ATTRIBUTES_URL, ({ request }) => {
      const substring = new URL(request.url).searchParams.get("substringMatch");
      substrings.push(substring);
      const body = respond(substring);
      return body instanceof Response ? body : HttpResponse.json(body);
    }),
  );
  return substrings;
}

async function search(params: Record<string, unknown>) {
  const result = await searchAttributes.handler(
    z.object(searchAttributes.inputSchema).parse({
      organizationSlug: "sentry-mcp-evals",
      ...params,
    }),
    getServerContext(),
  );
  assertStructuredOnlyResult(result);
  return getStructuredContent<SearchAttributesOutput>(result);
}

describe("search_attributes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop queued replies a failed test left behind, so one failure can't
    // break the tests after it.
    mockGenerateText.mockReset();
    // Pin the provider so the local .env can't change which path runs.
    vi.stubEnv("EMBEDDED_AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mswServer.resetHandlers();
  });

  describe("requests", () => {
    it("requires a spans, logs, or metrics dataset", () => {
      expect(() =>
        z
          .object(searchAttributes.inputSchema)
          .parse({ organizationSlug: "sentry-mcp-evals" }),
      ).toThrow();
      expect(() =>
        z
          .object(searchAttributes.inputSchema)
          .parse({ organizationSlug: "sentry-mcp-evals", dataset: "errors" }),
      ).toThrow();
    });

    it("passes the project ID, period, and context flag to the attributes API", async () => {
      let requestUrl: URL | undefined;
      mswServer.use(
        http.get(ATTRIBUTES_URL, ({ request }) => {
          requestUrl = new URL(request.url);
          return HttpResponse.json([]);
        }),
      );

      const output = await search({
        projectSlug: "cloudflare-mcp",
        query: "payment provider",
        dataset: "metrics",
        period: "7d",
      });

      expect(Object.fromEntries(requestUrl?.searchParams ?? [])).toEqual({
        itemType: "tracemetrics",
        project: "4509109104082945",
        statsPeriod: "7d",
        expand: "context",
      });
      expect(output.attributes).toEqual([]);
      expect(output.notes).toContain(
        "No metric attributes were seen in the last 7d.",
      );
      // Nothing to match, so the agent isn't called.
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("surfaces a 404 from the attributes API", async () => {
      mswServer.use(
        http.get(ATTRIBUTES_URL, () =>
          HttpResponse.json({ detail: "Not found" }, { status: 404 }),
        ),
      );

      await expect(search({ dataset: "spans" })).rejects.toThrow(
        ApiNotFoundError,
      );
    });
  });

  describe("without a query", () => {
    it("lists the dataset's attributes", async () => {
      const output = await search({ dataset: "metrics" });

      expect(output).toMatchObject({
        dataset: "metrics",
        period: "14d",
        query: null,
        resultType: "list",
        best: null,
        totalAttributes: 15,
        notes: [
          "There is no pagination. Input a `query` to narrow down your search.",
          "Use a key with `search_metrics` to query its values.",
        ],
      });
      expect(output.attributes).toHaveLength(15);
      // A deprecated attribute, with its replacement and examples.
      expect(
        output.attributes.find(({ key }) => key === "environment"),
      ).toMatchObject({
        type: "string",
        addedBySentry: true,
        description: "The sentry environment.",
        examples: ["production"],
        deprecated: true,
        replacementKey: "sentry.environment",
      });
      // One with no description or examples.
      expect(
        output.attributes.find(({ key }) => key === "retry.count"),
      ).toMatchObject({
        addedBySentry: true,
        aliases: [],
        deprecated: false,
        description: null,
        examples: [],
        key: "retry.count",
        replacementKey: null,
        type: "number",
      });

      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("returns the whole list as structured content", async () => {
      serveAttributes(() => HTTP_ATTRIBUTES);

      expect(await search({ dataset: "spans" })).toMatchInlineSnapshot(`
        {
          "attributes": [
            {
              "addedBySentry": true,
              "aliases": [],
              "deprecated": true,
              "description": "The HTTP method used.",
              "examples": [],
              "key": "http.method",
              "replacementKey": "http.request.method",
              "type": "string",
            },
            {
              "addedBySentry": false,
              "aliases": [],
              "deprecated": false,
              "description": null,
              "examples": [],
              "key": "app.tier",
              "replacementKey": null,
              "type": "string",
            },
            {
              "addedBySentry": true,
              "aliases": [
                "method",
              ],
              "deprecated": false,
              "description": "The HTTP request method.",
              "examples": [
                "GET",
                "POST",
              ],
              "key": "http.request.method",
              "replacementKey": null,
              "type": "string",
            },
          ],
          "best": null,
          "dataset": "spans",
          "notes": [
            "There is no pagination. Input a \`query\` to narrow down your search.",
            "Use a key with \`search_traces\` to query its values.",
          ],
          "period": "14d",
          "presentationHint": "A table works well here, with each attribute's type, description, examples, whether it's added by Sentry, and, for deprecated attributes, what replaces them.",
          "query": null,
          "resultType": "list",
          "totalAttributes": 3,
        }
      `);
    });

    it("lists recommended keys first", async () => {
      serveAttributes(() =>
        [
          "app.tier",
          "environment",
          "http.method",
          "span.op",
          "browser.name",
          "project",
        ].map((key) => userAttribute(key)),
      );

      const output = await search({ dataset: "spans" });

      expect(keys(output.attributes)).toEqual([
        // Search events' fields: environment is a common field, http.method a
        // span field, and project and span.op are recommended.
        "environment",
        "http.method",
        "project",
        "span.op",
        // Everything else
        "app.tier",
        "browser.name",
      ]);
    });

    it("says how many there are when the limit cuts the list", async () => {
      const output = await search({ dataset: "spans", limit: 5 });

      expect(output.attributes).toHaveLength(5);
      expect(output.totalAttributes).toBe(37);
    });

    it("treats a blank query as no query", async () => {
      const output = await search({ query: "   ", dataset: "logs" });

      expect(output).toMatchObject({ resultType: "list", query: null });
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  describe("with a query", () => {
    it("shows the best match and other candidates", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({
          best: "http.status_code",
          candidates: ["span.status", "transaction.status"],
        }),
      );

      const output = await search({
        query: "HTTP status code",
        dataset: "spans",
      });

      expect(output).toMatchObject({
        query: "HTTP status code",
        resultType: "matches",
        best: {
          key: "http.status_code",
          type: "number",
          addedBySentry: true,
          description: "The status code of the HTTP response.",
          examples: [404],
          deprecated: true,
          replacementKey: "http.response.status_code",
        },
        totalAttributes: 37,
        notes: ["Use a key with `search_traces` to query its values."],
      });
      expect(keys(output.attributes)).toEqual([
        "span.status",
        "transaction.status",
      ]);
      // With a query, the limit defaults to 10.
      expect(mockGenerateText.mock.calls[0]?.[0].prompt).toContain(
        "Return at most 10 keys",
      );
    });

    it("returns the whole shortlist as structured content", async () => {
      serveAttributes(() => HTTP_ATTRIBUTES);
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({
          best: "http.request.method",
          candidates: ["http.method"],
        }),
      );

      expect(await search({ query: "HTTP method", dataset: "spans" }))
        .toMatchInlineSnapshot(`
        {
          "attributes": [
            {
              "addedBySentry": true,
              "aliases": [],
              "deprecated": true,
              "description": "The HTTP method used.",
              "examples": [],
              "key": "http.method",
              "replacementKey": "http.request.method",
              "type": "string",
            },
          ],
          "best": {
            "addedBySentry": true,
            "aliases": [
              "method",
            ],
            "deprecated": false,
            "description": "The HTTP request method.",
            "examples": [
              "GET",
              "POST",
            ],
            "key": "http.request.method",
            "replacementKey": null,
            "type": "string",
          },
          "dataset": "spans",
          "notes": [
            "Use a key with \`search_traces\` to query its values.",
          ],
          "period": "14d",
          "presentationHint": "Separate the best result from the rest of the candidates for clarity.",
          "query": "HTTP method",
          "resultType": "matches",
          "totalAttributes": 3,
        }
      `);
    });

    it("lists possible matches in the agent's order, up to the limit", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({
          best: null,
          candidates: ["user.username", "user.id", "user.email"],
        }),
      );

      const output = await search({
        query: "which user",
        dataset: "spans",
        limit: 2,
      });

      expect(output.resultType).toBe("matches");
      expect(output.best).toBeNull();
      expect(keys(output.attributes)).toEqual(["user.username", "user.id"]);
    });

    it("says so when nothing matches", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({ best: null, candidates: [] }),
      );

      expect(
        await search({ query: "shopping cart size", dataset: "spans" }),
      ).toMatchObject({
        resultType: "matches",
        best: null,
        attributes: [],
        notes: [
          "None of the span attributes searched match this query.",
          "Try another `query`, or omit `query` to list every attribute.",
        ],
      });
    });

    it.each([
      {
        reason: "no AI provider is set up",
        setUp: () => vi.stubEnv("OPENAI_API_KEY", ""),
        note: "Matching by `query` needs an AI provider, so these are the dataset's attributes instead.",
      },
      {
        reason: "the AI provider fails",
        setUp: () => mockGenerateText.mockRejectedValueOnce(providerError()),
        note: "The AI provider couldn't match `query` right now, so these are the dataset's attributes instead.",
      },
      {
        reason: "the shortlist agent returns no output",
        setUp: () => mockGenerateText.mockResolvedValueOnce(noOutputResponse()),
        note: "The AI provider couldn't match `query` right now, so these are the dataset's attributes instead.",
      },
    ])(
      "lists the attributes with a note when $reason",
      async ({ setUp, note }) => {
        setUp();

        const output = await search({
          query: "HTTP status code",
          dataset: "spans",
        });

        expect(output.resultType).toBe("list");
        // Matching never ran, so nothing says the query matched nothing.
        expect(output.notes).toEqual([
          note,
          "Use a key with `search_traces` to query its values.",
        ]);
        expect(output.attributes.length).toBeGreaterThan(0);
      },
    );
  });

  describe("when the list may be cut off", () => {
    it("searches each key hint and finds keys past the cut", async () => {
      // payment.processor sorts after the cut, so only a hint search finds it.
      const substrings = serveAttributes((substring) =>
        substring === null ? FULL_PAGE : [userAttribute("payment.processor")],
      );
      mockGenerateText
        .mockResolvedValueOnce(
          mockAgentResponse({ hints: ["payment", "processor"] }),
        )
        .mockResolvedValueOnce(
          mockAgentResponse({ best: "payment.processor", candidates: [] }),
        );

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      // The hint agent sees only the dataset and the question.
      expect(mockGenerateText.mock.calls[0]?.[0].prompt).toBe(
        "Dataset: spans\nQuestion: payment provider",
      );
      // The plain call runs first, then one search per hint.
      expect(substrings[0]).toBeNull();
      expect(substrings.slice(1)).toHaveLength(2);
      expect(substrings.slice(1)).toEqual(
        expect.arrayContaining(["payment", "processor"]),
      );
      // Both hints found payment.processor, but the shortlist sees it once.
      const shortlistPrompt = mockGenerateText.mock.calls[1]?.[0]
        .prompt as string;
      expect(shortlistPrompt.match(/^- payment\.processor \(/gm)).toHaveLength(
        1,
      );
      expect(output.best?.key).toBe("payment.processor");
      // The hint searches looked through every key, so nothing is missing.
      expect(output.notes).not.toContain(KEY_CAP_NOTE);
    });

    it.each([
      {
        outcome: "returns no usable hints",
        hintAgent: () =>
          mockGenerateText.mockResolvedValueOnce(
            mockAgentResponse({ hints: ["id", "  "] }),
          ),
      },
      {
        outcome: "fails",
        hintAgent: () =>
          mockGenerateText.mockRejectedValueOnce(providerError()),
      },
      {
        outcome: "returns no output",
        hintAgent: () =>
          mockGenerateText.mockResolvedValueOnce(noOutputResponse()),
      },
    ])(
      "matches against the plain list when the hint agent $outcome",
      async ({ hintAgent }) => {
        const substrings = serveAttributes(() => FULL_PAGE);
        hintAgent();
        mockGenerateText.mockResolvedValueOnce(
          mockAgentResponse({ best: "app.string_0001", candidates: [] }),
        );

        const output = await search({ query: "app key", dataset: "spans" });

        expect(substrings).toEqual([null]);
        expect(output.best?.key).toBe("app.string_0001");
        // Only the cut-off list was searched.
        expect(output.notes).toContain(KEY_CAP_NOTE);
      },
    );

    it("keeps the note when every hint search fails", async () => {
      vi.spyOn(logging, "logIssue").mockReturnValue(undefined);
      // 501 isn't retried, which keeps the test fast.
      serveAttributes((substring) =>
        substring === null
          ? FULL_PAGE
          : HttpResponse.json({ detail: "Server error" }, { status: 501 }),
      );
      mockGenerateText
        .mockResolvedValueOnce(mockAgentResponse({ hints: ["payment"] }))
        .mockResolvedValueOnce(
          mockAgentResponse({ best: null, candidates: [] }),
        );

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      // Only the cut-off list was searched, so a miss may not be real.
      expect(output.notes).toContain(KEY_CAP_NOTE);
    });

    it("keeps the note when a hint search reaches the limit too", async () => {
      serveAttributes((substring) =>
        substring === null ? FULL_PAGE : manyAttributes(1000),
      );
      mockGenerateText
        .mockResolvedValueOnce(mockAgentResponse({ hints: ["app"] }))
        .mockResolvedValueOnce(
          mockAgentResponse({ best: null, candidates: [] }),
        );

      const output = await search({ query: "app setting", dataset: "spans" });

      expect(output.notes).toContain(KEY_CAP_NOTE);
    });

    it("leaves the note out when the hint searches find nothing", async () => {
      // The hint search looked through every key, so a miss is a real miss.
      const substrings = serveAttributes((substring) =>
        substring === null ? FULL_PAGE : [],
      );
      mockGenerateText
        .mockResolvedValueOnce(mockAgentResponse({ hints: ["payment"] }))
        .mockResolvedValueOnce(
          mockAgentResponse({ best: null, candidates: [] }),
        );

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      expect(substrings).toEqual([null, "payment"]);
      expect(output.resultType).toBe("matches");
      expect(output.notes).not.toContain(KEY_CAP_NOTE);
    });

    it("lists the narrowed attributes with a note when the shortlist agent fails", async () => {
      serveAttributes((substring) =>
        substring === null
          ? [...FULL_PAGE, userAttribute("span.op")]
          : [userAttribute("payment.processor")],
      );
      mockGenerateText
        .mockResolvedValueOnce(mockAgentResponse({ hints: ["payment"] }))
        .mockRejectedValueOnce(providerError());

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      expect(output.resultType).toBe("list");
      expect(output.notes[0]).toBe(
        "The AI provider couldn't match `query` right now, so these are the attributes with names related to it, plus Sentry's common search fields.",
      );
      // Only the recommended key and the hint match are left, recommended first.
      expect(keys(output.attributes)).toEqual(["span.op", "payment.processor"]);
      expect(output.notes).toContain(KEY_CAP_NOTE);
    });

    it("skips hint searches that fail and reports only server errors", async () => {
      const logIssue = vi.spyOn(logging, "logIssue").mockReturnValue(undefined);
      // 400 and 501 aren't retried, which keeps the test fast.
      serveAttributes((substring) => {
        if (substring === null) return FULL_PAGE;
        if (substring === "payment") {
          return HttpResponse.json({ detail: "Bad request" }, { status: 400 });
        }
        if (substring === "processor") {
          return HttpResponse.json({ detail: "Server error" }, { status: 501 });
        }
        return [userAttribute("payment.processor")];
      });
      mockGenerateText
        .mockResolvedValueOnce(
          mockAgentResponse({ hints: ["payment", "processor", "psp"] }),
        )
        .mockResolvedValueOnce(
          mockAgentResponse({ best: "payment.processor", candidates: [] }),
        );

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      expect(output.best?.key).toBe("payment.processor");
      expect(logIssue).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          loggerScope: ["tools", "search-attributes", "key-hint-search"],
          contexts: {
            request: expect.objectContaining({ substringMatch: "processor" }),
          },
        }),
      );
    });

    it("passes the call's cancel signal to both agents", async () => {
      const controller = new AbortController();
      serveAttributes((substring) =>
        substring === null ? FULL_PAGE : [userAttribute("payment.processor")],
      );
      mockGenerateText
        .mockResolvedValueOnce(mockAgentResponse({ hints: ["payment"] }))
        .mockResolvedValueOnce(
          mockAgentResponse({ best: "payment.processor", candidates: [] }),
        );

      await searchAttributes.handler(
        z.object(searchAttributes.inputSchema).parse({
          organizationSlug: "sentry-mcp-evals",
          query: "payment provider",
          dataset: "spans",
        }),
        { ...getServerContext(), signal: controller.signal },
      );

      expect(
        mockGenerateText.mock.calls.map(([options]) => options.abortSignal),
      ).toEqual([controller.signal, controller.signal]);
    });

    it("stops without reporting hint searches when the call is cancelled", async () => {
      const logIssue = vi.spyOn(logging, "logIssue").mockReturnValue(undefined);
      const controller = new AbortController();
      serveAttributes((substring) => {
        if (substring === null) return FULL_PAGE;
        // The client cancels while the hint search is in flight.
        controller.abort();
        return HttpResponse.json({ detail: "Server error" }, { status: 501 });
      });
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({ hints: ["payment"] }),
      );

      await expect(
        searchAttributes.handler(
          z.object(searchAttributes.inputSchema).parse({
            organizationSlug: "sentry-mcp-evals",
            query: "payment provider",
            dataset: "spans",
          }),
          { ...getServerContext(), signal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(logIssue).not.toHaveBeenCalled();
    });

    it("counts the cap per type, not across types", async () => {
      // 1200 keys in all, but neither type is near its 1000-key cap.
      const substrings = serveAttributes(() => [
        ...manyAttributes(600),
        ...manyAttributes(600, "number"),
      ]);
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({ best: null, candidates: [] }),
      );

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      expect(substrings).toEqual([null]);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(output.notes).not.toContain(KEY_CAP_NOTE);
    });

    it("doesn't make hints when listing", async () => {
      const substrings = serveAttributes(() => FULL_PAGE);

      await search({ dataset: "spans" });

      expect(substrings).toEqual([null]);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("says the list may be missing keys when a type reaches the cap", async () => {
      serveAttributes(() => FULL_PAGE);

      const output = await search({ dataset: "spans" });

      expect(output.notes).toEqual([
        "There is no pagination. Input a `query` to narrow down your search.",
        KEY_CAP_NOTE,
        "Use a key with `search_traces` to query its values.",
      ]);
    });

    it("says the fallback list may be missing keys when there's no AI provider", async () => {
      vi.stubEnv("OPENAI_API_KEY", "");
      serveAttributes(() => FULL_PAGE);

      const output = await search({
        query: "payment provider",
        dataset: "spans",
      });

      expect(output.resultType).toBe("list");
      expect(output.notes).toContain(KEY_CAP_NOTE);
    });
  });
});
