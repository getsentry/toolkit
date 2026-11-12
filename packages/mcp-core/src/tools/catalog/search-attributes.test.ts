import { mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText } from "ai";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
import * as logging from "../../telem/logging";
import { getServerContext } from "../../test-setup.js";
import searchAttributes from "./search-attributes.js";

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

/** The keys in the output's attribute table, in order. */
function tableKeys(output: string): string[] {
  return [...output.matchAll(/^\| `([^`]+)` \|/gm)].map(([, key]) => key);
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

function search(params: Record<string, unknown>) {
  return searchAttributes.handler(
    z.object(searchAttributes.inputSchema).parse({
      organizationSlug: "sentry-mcp-evals",
      ...params,
    }),
    getServerContext(),
  );
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
    it("requires a spans, logs, or metrics dataset", async () => {
      await expect(search({})).rejects.toThrowErrorMatchingInlineSnapshot(
        `[UserInputError: Choose a dataset: \`spans\` (requests, latency, database and AI calls), \`logs\` (log lines), or \`metrics\` (counters, gauges, distributions).]`,
      );
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
      expect(output).toContain(
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
      expect(await search({ dataset: "metrics" })).toMatchInlineSnapshot(`
        "# Metric Attributes in **sentry-mcp-evals** (last 14d)

        **Suggested presentation:** A table works well here, with each attribute's type, description, deprecation status, replacement attributes, and whether it's added by Sentry.

        Please tell the user each attribute's type, description, examples, whether they were added by sentry, and which attributes are deprecated and what replaces them.

        | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
        | --- | --- | --- | --- | --- | --- |
        | \`environment\` | string | The sentry environment. EXAMPLE VALUES: production | yes | yes | sentry.environment |
        | \`metric.name\` | string | The name of the metric. EXAMPLE VALUES: http.request.duration | yes |  |  |
        | \`metric.type\` | string | The type of the metric (counter, gauge, distribution). EXAMPLE VALUES: distribution | yes |  |  |
        | \`metric.unit\` | string | The unit of the metric value. EXAMPLE VALUES: millisecond | yes |  |  |
        | \`observed_timestamp\` | number | When Sentry received the metric sample.  | yes |  |  |
        | \`project\` | string | The name of the project. In some pages of sentry.io, you can also filter on project using a dropdown.  | yes |  |  |
        | \`timestamp_precise\` | number | When the metric sample was recorded, with nanosecond precision.  | yes |  |  |
        | \`value\` | number | The recorded value of the metric sample.  | yes |  |  |
        | \`fleet.deployment_region\` | string | The region the server is scheduled to move to in the next fleet deployment. It is not where the server runs now. EXAMPLE VALUES: eu-west-1 | yes |  |  |
        | \`fleet.region\` | string | The region the server is currently running in. EXAMPLE VALUES: us-east-1 | yes |  |  |
        | \`http.method\` | string | The HTTP method used. EXAMPLE VALUES: GET | yes | yes | http.request.method |
        | \`payload_size\` | number |  | yes |  |  |
        | \`transaction\` | string | The sentry transaction (segment name). EXAMPLE VALUES: GET / | yes | yes | sentry.segment.name |

        ## Response Notes

        - There is no pagination. Input a \`query\` to narrow down your search.
        - Use a key with \`search_metrics\` to query its values."
      `);

      expect(mockGenerateText).not.toHaveBeenCalled();
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

      expect(tableKeys(output)).toEqual([
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

    it("says how many are shown when the limit cuts the list", async () => {
      const output = await search({ dataset: "spans", limit: 5 });

      expect(output).toContain("- Showing 5 of 37.");
    });

    it("treats a blank query as no query", async () => {
      const output = await search({ query: "   ", dataset: "logs" });

      expect(output).toMatch(/^# Log Attributes in \*\*sentry-mcp-evals\*\*/);
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

      expect(await search({ query: "HTTP status code", dataset: "spans" }))
        .toMatchInlineSnapshot(`
        "# Span Attributes Matching "HTTP status code" in **sentry-mcp-evals** (last 14d)

        ## Best Match: \`http.status_code\`

        **Type**: number
        **Added by Sentry**
        **Description**: The status code of the HTTP response.
        **Examples**: 404
        **Deprecated**: use \`http.response.status_code\` instead

        ## Other Candidates

        | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
        | --- | --- | --- | --- | --- | --- |
        | \`span.status\` | string | The span's status (either "ok" or "error"). Older SDKs may set this to a more specific error, but this behaviour is deprecated. EXAMPLE VALUES: ok | yes |  |  |
        | \`transaction.status\` | string |  | yes |  |  |

        ## Response Notes

        - Use a key with \`search_traces\` to query its values."
      `);
      // With a query, the limit defaults to 10.
      expect(mockGenerateText.mock.calls[0]?.[0].prompt).toContain(
        "Return at most 10 keys",
      );
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

      expect(output).toContain("## Possible Matches");
      expect(output).not.toContain("## Best Match");
      expect(tableKeys(output)).toEqual(["user.username", "user.id"]);
    });

    it("says so when nothing matches", async () => {
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({ best: null, candidates: [] }),
      );

      expect(await search({ query: "shopping cart size", dataset: "spans" }))
        .toMatchInlineSnapshot(`
        "# Span Attributes Matching "shopping cart size" in **sentry-mcp-evals** (last 14d)

        None of the 37 span attributes seen in the last 14d match this query.

        ## Response Notes

        - Try another \`query\`, or omit \`query\` to list every attribute."
      `);
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

        expect(output.split("\n")[0]).toBe(note);
        expect(output).toContain("# Span Attributes in **sentry-mcp-evals**");
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
      expect(output).toContain("## Best Match: `payment.processor`");
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
        expect(output).toContain("## Best Match: `app.string_0001`");
      },
    );

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

      expect(output).toContain("## Best Match: `payment.processor`");
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

    it("counts the cap per type, not across types", async () => {
      // 1200 keys in all, but neither type is near its 1000-key cap.
      const substrings = serveAttributes(() => [
        ...manyAttributes(600),
        ...manyAttributes(600, "number"),
      ]);
      mockGenerateText.mockResolvedValueOnce(
        mockAgentResponse({ best: null, candidates: [] }),
      );

      await search({ query: "payment provider", dataset: "spans" });

      expect(substrings).toEqual([null]);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it("doesn't make hints when listing", async () => {
      const substrings = serveAttributes(() => FULL_PAGE);

      await search({ dataset: "spans" });

      expect(substrings).toEqual([null]);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });
});
