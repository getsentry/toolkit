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

      **Suggested presentation:** A table works well here, with each attribute's type, description, deprecation status, replacement attributes, and whether it's added by Sentry.

      Please tell the user each attribute's type, description, examples, whether they were added by sentry, and which attributes are deprecated and what replaces them.

      | Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |
      | --- | --- | --- | --- | --- | --- |
      | \`environment\` | string | The sentry environment. EXAMPLE VALUES: production | yes | yes | sentry.environment |
      | \`http.method\` | string | The HTTP method used. EXAMPLE VALUES: GET | yes | yes | http.request.method |
      | \`http.status_code\` | number | The status code of the HTTP response. EXAMPLE VALUES: 404 | yes | yes | http.response.status_code |
      | \`http.url\` | string | The URL of the resource that was fetched. EXAMPLE VALUES: https://example.com/test?foo=bar#buzz | yes | yes | url.full |
      | \`platform\` | string | The sdk platform that generated the event. EXAMPLE VALUES: php | yes |  |  |
      | \`project\` | string | The name of the project. In some pages of sentry.io, you can also filter on project using a dropdown.  | yes |  |  |
      | \`release\` | string | The sentry release. EXAMPLE VALUES: production | yes | yes | sentry.release |
      | \`sdk.name\` | string | The sentry sdk name. EXAMPLE VALUES: @sentry/react | yes |  |  |
      | \`sdk.version\` | string | The sentry sdk version. EXAMPLE VALUES: 7.0.0 | yes |  |  |
      | \`span.description\` | string | Description of the span's operation.  | yes |  |  |
      | \`span.duration\` | number | The total time taken by the span.  | yes |  |  |
      | \`span.op\` | string | The operation of a span. EXAMPLE VALUES: http.client | yes |  |  |
      | \`span.status\` | string | The span's status (either "ok" or "error"). Older SDKs may set this to a more specific error, but this behaviour is deprecated. EXAMPLE VALUES: ok | yes |  |  |
      | \`transaction\` | string | The sentry transaction (segment name). EXAMPLE VALUES: GET / | yes | yes | sentry.segment.name |
      | \`transaction.duration\` | number |  | yes |  |  |
      | \`transaction.op\` | string | Operation of the containing transaction.  | yes |  |  |
      | \`transaction.status\` | string |  | yes |  |  |
      | \`user.email\` | string |  | yes |  |  |
      | \`user.id\` | string |  | yes |  |  |
      | \`browser.name\` | string |  | yes |  |  |
      | \`custom.count\` | number |  |  |  |  |
      | \`custom.db.pool_size\` | number |  |  |  |  |
      | \`custom.feature_flag\` | string |  |  |  |  |
      | \`custom.latency_ms\` | number |  |  |  |  |
      | \`custom.score\` | number |  |  |  |  |
      | \`custom.tier\` | string |  |  |  |  |
      | \`device\` | string |  | yes |  |  |
      | \`device.memory\` | number | The estimated total memory capacity of the device.  | yes |  |  |
      | \`deviceMemory\` | number |  | yes |  |  |
      | \`geo.city\` | string | The city of the user's location. EXAMPLE VALUES: Toronto | yes |  |  |
      | \`geo.country_code\` | string | The country code of the user's location. EXAMPLE VALUES: US | yes |  |  |
      | \`geo.region\` | string | The region of the user's location. EXAMPLE VALUES: Canada | yes | yes | user.geo.region |
      | \`http.request.method\` | string | The HTTP method used. EXAMPLE VALUES: GET | yes |  |  |
      | \`kiosk.firmware\` | string | The firmware revision currently installed and running on the kiosk. EXAMPLE VALUES: 4.1.3 | yes |  |  |
      | \`kiosk.firmware_revision\` | string | The firmware revision downloaded and staged for the kiosk's next update. It is not installed until the kiosk restarts. EXAMPLE VALUES: 4.2.0 | yes |  |  |
      | \`os.name\` | string | Human readable operating system name. EXAMPLE VALUES: Ubuntu | yes |  |  |
      | \`user.username\` | string |  | yes |  |  |

      ## Response Notes

      - Use a key with \`search_traces\` to query its values."
    `);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("lists the dataset's attributes when there's no query", async () => {
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

      - Use a key with \`search_metrics\` to query its values."
    `);

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("says how many are shown when the list is cut off", async () => {
    const output = await search({ dataset: "spans", limit: 5 });

    expect(output).toContain("- Showing 5 of 37.");
  });

  it("lists recommended keys first", async () => {
    const attribute = (key: string, source: "sentry" | "user" = "sentry") => ({
      key,
      name: key,
      attributeType: "string",
      attributeSource: { source_type: source },
    });
    mswServer.use(
      http.get(ATTRIBUTES_URL, () =>
        HttpResponse.json([
          attribute("app.tier", "user"),
          attribute("environment"),
          attribute("http.method"),
          attribute("span.op"),
          attribute("browser.name"),
          attribute("project"),
        ]),
      ),
    );

    const output = await search({ dataset: "spans" });
    const keys = [...output.matchAll(/^\| `([^`]+)` \|/gm)].map(
      ([, key]) => key,
    );

    expect(keys).toEqual([
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
