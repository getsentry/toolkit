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

  it("lists the dataset's attributes when there's a query because searching is not supported yet", async () => {
    expect(
      await search({ dataset: "spans", query: "endpoint status response" }),
    ).toMatchInlineSnapshot(`
      "Matching by \`query\` is not available yet. Here are all of the dataset's attributes instead.
      # Span Attributes in **sentry-mcp-evals** (last 14d)

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`browser.name\` | string |  | yes |  |  |
      | \`custom.count\` | number |  |  |  |  |
      | \`custom.db.pool_size\` | number |  |  |  |  |
      | \`custom.feature_flag\` | string |  |  |  |  |
      | \`custom.latency_ms\` | number |  |  |  |  |
      | \`custom.score\` | number |  |  |  |  |
      | \`custom.tier\` | string |  |  |  |  |
      | \`device\` | string |  | yes |  |  |
      | \`device.memory\` | number | The estimated total memory capacity of the device. | yes |  |  |
      | \`deviceMemory\` | number |  | yes |  |  |
      | \`environment\` | string | The sentry environment. | yes | yes | sentry.environment |
      | \`geo.city\` | string | The city of the user's location. | yes |  |  |
      | \`geo.country_code\` | string | The country code of the user's location. | yes |  |  |
      | \`geo.region\` | string | The region of the user's location. | yes | yes | user.geo.region |
      | \`http.method\` | string | The HTTP method used. | yes | yes | http.request.method |
      | \`http.request.method\` | string | The HTTP method used. | yes |  |  |
      | \`http.status_code\` | number | The status code of the HTTP response. | yes | yes | http.response.status_code |
      | \`http.url\` | string | The URL of the resource that was fetched. | yes | yes | url.full |
      | \`kiosk.firmware\` | string | The firmware revision currently installed and running on the kiosk. | yes |  |  |
      | \`kiosk.firmware_revision\` | string | The firmware revision downloaded and staged for the kiosk's next update. It is not installed until the kiosk restarts. | yes |  |  |
      | \`os.name\` | string | Human readable operating system name. | yes |  |  |
      | \`platform\` | string | The sdk platform that generated the event. | yes |  |  |
      | \`project\` | string | The name of the project. In some pages of sentry.io, you can also filter on project using a dropdown. | yes |  |  |
      | \`release\` | string | The sentry release. | yes | yes | sentry.release |
      | \`sdk.name\` | string | The sentry sdk name. | yes |  |  |
      | \`sdk.version\` | string | The sentry sdk version. | yes |  |  |
      | \`span.description\` | string | Description of the span's operation. | yes |  |  |
      | \`span.duration\` | number | The total time taken by the span. | yes |  |  |
      | \`span.op\` | string | The operation of a span. | yes |  |  |
      | \`span.status\` | string | The span's status (either "ok" or "error"). Older SDKs may set this to a more specific error, but this behaviour is dep… | yes |  |  |
      | \`transaction\` | string | The sentry transaction (segment name). | yes | yes | sentry.segment.name |
      | \`transaction.duration\` | number |  | yes |  |  |
      | \`transaction.op\` | string | Operation of the containing transaction. | yes |  |  |
      | \`transaction.status\` | string |  | yes |  |  |
      | \`user.email\` | string |  | yes |  |  |
      | \`user.id\` | string |  | yes |  |  |
      | \`user.username\` | string |  | yes |  |  |

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);

    expect(mockGenerateText).not.toHaveBeenCalled();
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

    expect(output).toMatch(
      /^Matching by `query` needs an AI provider, so these are the dataset's attributes instead./,
    );
    expect(output).toContain("# Span Attributes in **sentry-mcp-evals**");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  // This isn't quite a case yet but i'm leaving it here so we don't forget about this case
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

    expect(output).toMatch(
      /^Matching by `query` is not available yet. Here are all of the dataset's attributes instead./,
    );
    expect(output).toContain("# Span Attributes in **sentry-mcp-evals**");
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
