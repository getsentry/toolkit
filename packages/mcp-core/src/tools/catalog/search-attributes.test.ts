import { mswServer } from "@sentry/mcp-server-mocks";
import { APICallError, generateText } from "ai";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
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

function mockAgentResponse(output: {
  best: string | null;
  candidates: string[];
}) {
  return {
    text: JSON.stringify(output),
    experimental_output: output,
    finishReason: "stop" as const,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    warnings: [] as const,
  } as any;
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
    // Pin the provider so the local .env can't change which path runs.
    vi.stubEnv("EMBEDDED_AGENT_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mswServer.resetHandlers();
  });

  it("asks for a dataset when none is given", async () => {
    await expect(search({})).rejects.toThrowErrorMatchingInlineSnapshot(
      `[UserInputError: Choose a dataset: \`spans\` (requests, latency, database and AI calls), \`logs\` (log lines), or \`metrics\` (counters, gauges, distributions).]`,
    );
  });

  it("shows the agent's best match and drops keys that weren't fetched", async () => {
    mockGenerateText.mockResolvedValue(
      mockAgentResponse({
        best: "http.status_code",
        candidates: ["span.status", "http.statuscode"],
      }),
    );

    expect(await search({ query: "HTTP status code", dataset: "spans" }))
      .toMatchInlineSnapshot(`
      "# Span Attributes Matching "HTTP status code" in **sentry-mcp-evals** (last 14d)

      ## Best Match: \`http.status_code\`

      **Type**: number
      **Added by Sentry**: yes
      **Description**: The status code of the HTTP response.
      **Examples**: 404
      **Deprecated**: use \`http.response.status_code\` instead

      ## Other Candidates

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`span.status\` | string | The span's status (either "ok" or "error"). Older SDKs may set this to a more specific error, but this behaviour is dep… | yes |  |  |

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.tools).toEqual({});
    expect(call.prompt).toContain("Question: HTTP status code");
    expect(call.prompt).toContain("- http.status_code (number):");
  });

  it("lists the dataset's attributes when there's no query", async () => {
    expect(await search({ dataset: "metrics" })).toMatchInlineSnapshot(`
      "# Metric Attributes in **sentry-mcp-evals** (last 14d)

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`environment\` | string | The sentry environment. | yes | yes | sentry.environment |
      | \`fleet.deployment_region\` | string | The region the server is scheduled to move to in the next fleet deployment. It is not where the server runs now. | yes |  |  |
      | \`fleet.region\` | string | The region the server is currently running in. | yes |  |  |
      | \`http.method\` | string | The HTTP method used. | yes | yes | http.request.method |
      | \`metric.name\` | string | The name of the metric. | yes |  |  |
      | \`metric.type\` | string | The type of the metric (counter, gauge, distribution). | yes |  |  |
      | \`metric.unit\` | string | The unit of the metric value. | yes |  |  |
      | \`observed_timestamp\` | number | When Sentry received the metric sample. | yes |  |  |
      | \`payload_size\` | number |  | yes |  |  |
      | \`project\` | string | The name of the project. In some pages of sentry.io, you can also filter on project using a dropdown. | yes |  |  |
      | \`timestamp_precise\` | number | When the metric sample was recorded, with nanosecond precision. | yes |  |  |
      | \`transaction\` | string | The sentry transaction (segment name). | yes | yes | sentry.segment.name |
      | \`value\` | number | The recorded value of the metric sample. | yes |  |  |

      ## Response Notes

      - Use a key with \`search_metrics\` to query its values."
    `);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("says how many are shown when the list is cut off", async () => {
    const output = await search({ dataset: "spans", limit: 5 });

    expect(output).toContain(
      "- Showing 5 of 37. Pass a `query` to find specific attributes.",
    );
  });

  it("treats a blank query as no query", async () => {
    const output = await search({ query: "   ", dataset: "logs" });

    expect(output).toMatch(/^# Log Attributes in \*\*sentry-mcp-evals\*\*/);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("lists attributes with a note when no AI provider is set up", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");

    const output = await search({
      query: "HTTP status code",
      dataset: "spans",
    });

    expect(output).toMatch(/^# Span Attributes in \*\*sentry-mcp-evals\*\*/);
    expect(output).toContain(
      "- Matching by `query` needs an AI provider, so these are the dataset's attributes instead.",
    );
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("lists attributes with a note when the AI provider fails", async () => {
    mockGenerateText.mockRejectedValue(
      new APICallError({
        message: "Workspace budget exceeded",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 402,
        isRetryable: false,
      }),
    );

    const output = await search({
      query: "HTTP status code",
      dataset: "spans",
    });

    expect(output).toMatch(/^# Span Attributes in \*\*sentry-mcp-evals\*\*/);
    expect(output).toContain(
      "- The AI provider couldn't match `query` right now, so these are the dataset's attributes instead.",
    );
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
    expect(output).toContain("No metric attributes were seen in the last 7d.");
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

  it("rejects datasets other than spans, logs, and metrics", () => {
    expect(() =>
      z
        .object(searchAttributes.inputSchema)
        .parse({ organizationSlug: "sentry-mcp-evals", dataset: "errors" }),
    ).toThrow();
  });
});
