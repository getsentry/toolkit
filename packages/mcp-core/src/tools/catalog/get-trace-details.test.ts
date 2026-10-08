import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  mswServer,
  traceMetaFixture,
  traceMetaWithNullsFixture,
  traceFixture,
  traceMixedFixture,
} from "@sentry/mcp-server-mocks";
import { getTextContent } from "../../test-utils/structured-content";
import getTraceDetails from "./get-trace-details.js";

const originalOpenAIApiKey = process.env.OPENAI_API_KEY;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalEmbeddedAgentProvider = process.env.EMBEDDED_AGENT_PROVIDER;

/** Register the same handler on sentry.io and us.sentry.io (org fixture resolves region). */
function httpGetRegional(
  sentryIoUrl: string,
  resolver: Parameters<typeof http.get>[1],
  options?: Parameters<typeof http.get>[2],
) {
  const usUrl = sentryIoUrl.replace(
    /^https:\/\/sentry\.io\b/,
    "https://us.sentry.io",
  );
  return [
    http.get(sentryIoUrl, resolver, options),
    http.get(usUrl, resolver, options),
  ];
}

function buildTraceSpan({
  description = "Synthetic span",
  eventId,
  spanId,
}: {
  description?: string;
  eventId: string;
  spanId: string;
}) {
  return {
    children: [],
    description,
    duration: 25,
    event_id: eventId,
    op: "task",
    project_slug: "mcp-server",
    span_id: spanId,
  };
}

function buildTraceSpanNode({
  children = [],
  data = {},
  duration,
  eventId,
  name,
  op,
  parentSpanId,
  spanId,
  tags = {},
}: {
  children?: Array<Record<string, unknown>>;
  data?: Record<string, unknown>;
  duration: number;
  eventId: string;
  name?: string | null;
  op: string;
  parentSpanId: string | null;
  spanId: string;
  tags?: Record<string, unknown>;
}) {
  return {
    additional_attributes: data,
    children,
    data: {},
    description: null,
    duration,
    end_timestamp: 1713805460 + duration / 1000,
    errors: [],
    event_id: eventId,
    hash: `hash-${spanId}`,
    is_segment: true,
    name,
    occurrences: [],
    op,
    organization: null,
    parent_span_id: parentSpanId,
    profile_id: "",
    profiler_id: "",
    project_id: 4509109107622913,
    project_slug: "mcp-server",
    same_process_as_parent: true,
    sdk_name: "sentry.javascript.node",
    span_id: spanId,
    start_timestamp: 1713805460,
    status: "ok",
    tags,
    timestamp: 1713805460 + duration / 1000,
    trace: "e4d1aae7216b47ff8117cf4e09ce9d0e",
    transaction_id: eventId,
  };
}

describe("get_trace_details", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    Reflect.deleteProperty(process.env, "EMBEDDED_AGENT_PROVIDER");
  });

  afterAll(() => {
    if (originalOpenAIApiKey === undefined) {
      Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIApiKey;
    }

    if (originalAnthropicApiKey === undefined) {
      Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }

    if (originalOpenRouterApiKey === undefined) {
      Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }

    if (originalEmbeddedAgentProvider === undefined) {
      Reflect.deleteProperty(process.env, "EMBEDDED_AGENT_PROVIDER");
    } else {
      process.env.EMBEDDED_AGENT_PROVIDER = originalEmbeddedAgentProvider;
    }
  });

  it("serializes with valid trace ID", async () => {
    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(result).toMatchInlineSnapshot(`
      "# Trace \`a4d1aae7216b47ff8117cf4e09ce9d0a\` in **sentry-mcp-evals**

      ## Summary

      **Total Spans**: 112
      **Errors**: 0
      **Performance Issues**: 0
      **Logs**: 0

      ## Operation Breakdown

      - **db**: 90 spans (avg: 16ms, p95: 13ms)
      - **feature.flagpole.batch_has**: 30 spans (avg: 18ms, p95: 32ms)
      - **function**: 14 spans (avg: 303ms, p95: 1208ms)
      - **http.client**: 2 spans (avg: 1223ms, p95: 1708ms)
      - **other**: 1 spans (avg: 6ms, p95: 6ms)

      ## Overview

      trace
         └─ tools/call search_events [5203ms · aa8e7f3343113fbf]
            ├─ GET https://us.sentry.io/api/0/projects/example-org/owner-web/ [http.client · 997ms · a408acaf23ce7d6e]
            │  └─ /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/ [http.server · 920ms · a6bfd174bb70af94]
            │     └─ getsentry.middleware.HealthCheck.__call__ [middleware.django · 919ms · bf0014be75618b6c]
            │        └─ csp.middleware.CSPMiddleware.__call__ [middleware.django · 919ms · 8c7084924ec3f3c1]
            │           └─ sentry.middleware.health.HealthCheck.__call__ [middleware.django · 919ms · b7566e36193ecf9e]
            │              └─ sentry.middleware.security.SecurityHeadersMiddleware.__call__ [middleware.django · 919ms · 81e527b7d864e37b]
            │                 └─ sentry.middleware.env.SentryEnvMiddleware.__call__ [middleware.django · 919ms · a98941945f541201]
            │                    └─ sentry.middleware.proxy.SetRemoteAddrFromForwardedFor.__call__ [middleware.django · 919ms · bb0856e3350b313c]
            ├─ GET https://us.sentry.io/api/0/organizations/example-org/events/ [http.client · 1482ms · b4abfe5ef52095e8]
            │  └─ /api/0/organizations/{organization_id_or_slug}/events/ [http.server · 1408ms · 99a97a1df1987523]
            │     └─ getsentry.middleware.HealthCheck.__call__ [middleware.django · 1407ms · 86817c3635c86c8e]
            │        └─ csp.middleware.CSPMiddleware.__call__ [middleware.django · 1407ms · 8d4162516307d639]
            │           └─ sentry.middleware.health.HealthCheck.__call__ [middleware.django · 1406ms · af51b6d301d9c9f0]
            │              └─ sentry.middleware.security.SecurityHeadersMiddleware.__call__ [middleware.django · 1405ms · b3c88b6c53cac551]
            │                 └─ sentry.middleware.env.SentryEnvMiddleware.__call__ [middleware.django · 1405ms · 978bf5fdd98c755c]
            │                    └─ sentry.middleware.proxy.SetRemoteAddrFromForwardedFor.__call__ [middleware.django · 1405ms · bef93ba934e4f8d4]
            ├─ POST https://api.openai.com/v1/chat/completions [http.client · 1708ms · ad0f7c486cc0c787]
            ├─ GET https://us.sentry.io/api/0/organizations/example-org/trace-items/attributes/ [http.client · 260ms · 9585e3d3a9fce842]
            │  └─ /api/0/organizations/{organization_id_or_slug}/trace-items/attributes/ [http.server · 197ms · bb1b31d075b1516a]
            │     └─ getsentry.middleware.HealthCheck.__call__ [middleware.django · 196ms · b36091b77cc4c239]
            │        └─ csp.middleware.CSPMiddleware.__call__ [middleware.django · 196ms · 9071e74052a55be3]
            │           └─ sentry.middleware.health.HealthCheck.__call__ [middleware.django · 195ms · b2d4f408e3df8fdb]
            │              └─ sentry.middleware.security.SecurityHeadersMiddleware.__call__ [middleware.django · 195ms · b2c5877805f24c1f]
            │                 └─ sentry.middleware.env.SentryEnvMiddleware.__call__ [middleware.django · 195ms · 9cf758523d03e53b]
            │                    └─ sentry.middleware.proxy.SetRemoteAddrFromForwardedFor.__call__ [middleware.django · 195ms · 96c0d21b6fb7c4e7]
            ├─ GET https://us.sentry.io/api/0/organizations/example-org/trace-items/attributes/ [http.client · 260ms · b666593301cd270e]
            │  └─ /api/0/organizations/{organization_id_or_slug}/trace-items/attributes/ [http.server · 190ms · 8347746717d2c5fe]
            │     └─ getsentry.middleware.HealthCheck.__call__ [middleware.django · 189ms · 93b01ee477203031]
            │        └─ csp.middleware.CSPMiddleware.__call__ [middleware.django · 189ms · 83e2bf98f188b076]
            │           └─ sentry.middleware.health.HealthCheck.__call__ [middleware.django · 189ms · 8dc6d54d661b2629]
            │              └─ sentry.middleware.security.SecurityHeadersMiddleware.__call__ [middleware.django · 188ms · bf7cae0e1b8cb89d]
            │                 └─ sentry.middleware.env.SentryEnvMiddleware.__call__ [middleware.django · 188ms · a4131a6a084b596d]
            │                    └─ sentry.middleware.proxy.SetRemoteAddrFromForwardedFor.__call__ [middleware.django · 188ms · 865694d596f40e86]
            └─ POST https://api.openai.com/v1/chat/completions [http.client · 738ms · b0794450510b8ecd]

      *Overview shows 35 of 112 spans.*

      ## View Full Trace

      **Sentry URL**: https://sentry-mcp-evals.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a

      ## Next Steps

      - **Search spans**: Use the Sentry tool \`search_traces\`
      - **Search errors**: Use the Sentry tool \`search_errors\`
      - **Search logs**: Use the Sentry tool \`search_logs\`"
    `);
  });

  it("serializes with fixed stats period", async () => {
    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(result).toContain(
      "Trace `a4d1aae7216b47ff8117cf4e09ce9d0a` in **sentry-mcp-evals**",
    );
    expect(result).toContain("**Total Spans**: 112");
    expect(result).toContain(
      "**Search spans**: Use the Sentry tool `search_traces`",
    );
  });

  it("falls back to direct search_traces guidance when agent search is unavailable", async () => {
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    Reflect.deleteProperty(process.env, "EMBEDDED_AGENT_PROVIDER");

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain(
      "**Search spans**: Use the Sentry tool `search_traces`",
    );
  });

  it("does not show trace next-step tool calls when search tools are unavailable", async () => {
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    Reflect.deleteProperty(process.env, "EMBEDDED_AGENT_PROVIDER");

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
        experimentalMode: true,
        availableToolNames: new Set(["get_trace_details"]),
        directToolNames: new Set(["get_trace_details"]),
      },
    );

    expect(result).toContain("**Search spans**: Span search is not available");
    expect(result).toContain(
      "**Search errors**: Error search is not available",
    );
    expect(result).toContain("**Search logs**: Log search is not available");
    expect(result).not.toContain("search_traces(");
    expect(result).not.toContain("search_events(");
  });

  it("handles trace not found error", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/trace-meta/nonexistent/",
        () => {
          return new HttpResponse(null, { status: 404 });
        },
      ),
    );

    await expect(
      getTraceDetails.handler(
        {
          organizationSlug: "sentry",
          traceId: "nonexistent",
          regionUrl: null,
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow();
  });

  it("validates trace ID format", async () => {
    await expect(
      getTraceDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          traceId: "invalid-trace-id", // Too short, not hex
          regionUrl: null,
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow("Trace ID must be a 32-character hexadecimal string");
  });

  it("returns trace details under an active project constraint", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/frontend/",
        () => {
          throw new Error("getProject should not be called for trace lookups");
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: "frontend",
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("**Total Spans**: 112");
    expect(result).not.toContain("**Scope**:");
  });

  it("handles empty trace response", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json({
            logs: 0,
            errors: 0,
            performance_issues: 0,
            span_count: 0,
            transaction_child_count_map: [],
            span_count_map: {},
          });
        },
      ),
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("**Total Spans**: 0");
    expect(result).toContain("**Errors**: 0");
    expect(result).toContain("## Summary");
    expect(result).not.toContain("## Operation Breakdown");
    expect(result).not.toContain("## Overview");
  });

  it("handles trace meta responses with missing count fields", async () => {
    const traceId = "c4d1aae7216b47ff8117cf4e09ce9d0c";

    mswServer.use(
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/${traceId}/`,
        () => {
          return HttpResponse.json({});
        },
      ),
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        () => {
          return HttpResponse.json([]);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("**Total Spans**: 0");
    expect(result).toContain("**Errors**: 0");
    expect(result).toContain("**Performance Issues**: 0");
    expect(result).toContain("**Logs**: 0");
  });

  it("handles API error gracefully", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return new HttpResponse(
            JSON.stringify({ detail: "Organization not found" }),
            { status: 404 },
          );
        },
      ),
    );

    await expect(
      getTraceDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
          regionUrl: null,
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow();
  });

  it("works with regional URL override", async () => {
    mswServer.use(
      http.get(
        "https://us.sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json(traceMetaFixture);
        },
      ),
      http.get(
        "https://us.sentry.io/api/0/organizations/sentry-mcp-evals/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json(traceFixture);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: "https://us.sentry.io",
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain(
      "Trace `a4d1aae7216b47ff8117cf4e09ce9d0a` in **sentry-mcp-evals**",
    );
    expect(result).toContain("**Total Spans**: 112");
  });

  it("handles trace meta with null transaction.event_id values", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json(traceMetaWithNullsFixture);
        },
      ),
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
        () => {
          return HttpResponse.json(traceFixture);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // The handler should successfully process the response with null values
    expect(result).toContain(
      "Trace `a4d1aae7216b47ff8117cf4e09ce9d0a` in **sentry-mcp-evals**",
    );
    expect(result).toContain("**Total Spans**: 85");
    expect(result).toContain("**Errors**: 2");
    // The null transaction.event_id entries should be handled gracefully
    // and the trace should still be processed successfully
    expect(result).not.toContain("null");
  });

  it("handles mixed span/issue arrays in trace responses", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/b4d1aae7216b47ff8117cf4e09ce9d0b/",
        () => {
          return HttpResponse.json({
            logs: 0,
            errors: 2,
            performance_issues: 0,
            span_count: 4,
            transaction_child_count_map: [],
            span_count_map: {},
          });
        },
      ),
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/b4d1aae7216b47ff8117cf4e09ce9d0b/",
        () => {
          return HttpResponse.json(traceMixedFixture);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "b4d1aae7216b47ff8117cf4e09ce9d0b",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toMatchInlineSnapshot(`
      "# Trace \`b4d1aae7216b47ff8117cf4e09ce9d0b\` in **sentry-mcp-evals**

      ## Summary

      **Total Spans**: 4
      **Errors**: 2
      **Performance Issues**: 0
      **Logs**: 0

      ## Operation Breakdown

      - **http.client**: 1 spans (avg: 1708ms, p95: 1708ms)
      - **http.server**: 1 spans (avg: 1408ms, p95: 1408ms)

      ## Overview

      trace
         ├─ tools/call search_events [function · 5203ms · aa8e7f3384ef4ff5]
         │  └─ POST https://api.openai.com/v1/chat/completions [http.client · 1708ms · ad0f7c48fb294de3]
         └─ GET https://us.sentry.io/api/0/organizations/example-org/events/ [http.client · 1482ms · b4abfe5ed7984c2b]
            └─ /api/0/organizations/{organization_id_or_slug}/events/ [http.server · 1408ms · 99a97a1d42c3489a]

      *Overview shows 4 of 4 spans.*

      ## View Full Trace

      **Sentry URL**: https://sentry-mcp-evals.sentry.io/explore/traces/trace/b4d1aae7216b47ff8117cf4e09ce9d0b

      ## Next Steps

      - **Search spans**: Use the Sentry tool \`search_traces\`
      - **Search errors**: Use the Sentry tool \`search_errors\`
      - **Search logs**: Use the Sentry tool \`search_logs\`"
    `);
  });

  it("snapshots agent conversations found in loaded trace spans", async () => {
    const traceId = "c4d1aae7216b47ff8117cf4e09ce9d0c";
    const rootSpan = buildTraceSpanNode({
      duration: 123,
      eventId: "c4d1aae7216b47ff8117cf4e09ce9d0c",
      name: "ai.generate",
      op: "gen_ai.invoke_agent",
      parentSpanId: null,
      spanId: "c4d1aae7216b47ff",
      data: {
        "gen_ai.conversation.id": "conv-trace-snapshot",
      },
    });

    mswServer.use(
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/${traceId}/`,
        () =>
          HttpResponse.json({
            logs: 0,
            errors: 0,
            performance_issues: 0,
            span_count: 1,
            transaction_child_count_map: [],
            span_count_map: {},
          }),
      ),
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        () => HttpResponse.json([rootSpan]),
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    const text = typeof result === "string" ? result : getTextContent(result);
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toBeUndefined();
    expect(text).toMatchInlineSnapshot(`
      "# Trace \`c4d1aae7216b47ff8117cf4e09ce9d0c\` in **sentry-mcp-evals**

      ## Summary

      **Total Spans**: 1
      **Errors**: 0
      **Performance Issues**: 0
      **Logs**: 0

      ## Operation Breakdown

      - **gen_ai.invoke_agent**: 1 spans (avg: 123ms, p95: 123ms)

      ## Overview

      trace
         └─ ai.generate [gen_ai.invoke_agent · 123ms · c4d1aae7216b47ff]

      *Overview shows 1 of 1 spans.*

      ## View Full Trace

      **Sentry URL**: https://sentry-mcp-evals.sentry.io/explore/traces/trace/c4d1aae7216b47ff8117cf4e09ce9d0c

      ## Agent Conversations

      **Conversation ID**: \`conv-trace-snapshot\`
      **Matching Span**: \`c4d1aae7216b47ff\`

      Use the Sentry tool \`execute_sentry_tool(name='get_agent_conversation_details', arguments={"organizationSlug":"sentry-mcp-evals","conversationId":"conv-trace-snapshot"})\` to fetch the full transcript.

      ## Next Steps

      - **Search spans**: Use the Sentry tool \`search_traces\`
      - **Search errors**: Use the Sentry tool \`search_errors\`
      - **Search logs**: Use the Sentry tool \`search_logs\`"
    `);
  });

  it("renders semantic labels for common OpenTelemetry span attributes", async () => {
    const traceId = "e4d1aae7216b47ff8117cf4e09ce9d0e";
    const processSpan = buildTraceSpanNode({
      duration: 4050,
      eventId: "55555555555555555555555555555555",
      name: "process.exec",
      op: "process.exec",
      parentSpanId: "4444444444444444",
      spanId: "5555555555555555",
      data: {
        "process.command": "git",
        "process.exit.code": 0,
      },
    });
    const toolSpan = buildTraceSpanNode({
      children: [processSpan],
      duration: 4107,
      eventId: "44444444444444444444444444444444",
      name: "execute_sentry_tool",
      op: "gen_ai.execute_tool",
      parentSpanId: "2222222222222222",
      spanId: "4444444444444444",
      data: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "search_events",
      },
    });
    const httpClientSpan = buildTraceSpanNode({
      duration: 21455,
      eventId: "33333333333333333333333333333333",
      name: "POST",
      op: "http.client",
      parentSpanId: "2222222222222222",
      spanId: "3333333333333333",
      data: {
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "url.full": "https://api.anthropic.com/v1/messages?api_key=filtered",
      },
    });
    const httpMethodOnlySpan = buildTraceSpanNode({
      duration: 16,
      eventId: "13131313131313131313131313131313",
      name: "post",
      op: "http.client",
      parentSpanId: "1111111111111111",
      spanId: "1313131313131313",
      data: {
        "http.request.method": "post",
        "http.response.status_code": 204,
      },
    });
    const httpExtensionMethodSpan = buildTraceSpanNode({
      duration: 15,
      eventId: "19191919191919191919191919191919",
      name: "propfind",
      op: "http.client",
      parentSpanId: "1111111111111111",
      spanId: "1919191919191919",
      data: {
        "http.request.method": "propfind",
        "http.response.status_code": 207,
      },
    });
    const httpServerTargetSpan = buildTraceSpanNode({
      duration: 17,
      eventId: "14141414141414141414141414141414",
      name: "GET",
      op: "http.client",
      parentSpanId: "1111111111111111",
      spanId: "1414141414141414",
      data: {
        "http.request.method": "GET",
        "server.address": "api.example.com",
        "server.port": 443,
      },
    });
    const httpVersionedPathSpan = buildTraceSpanNode({
      duration: 18,
      eventId: "16161616161616161616161616161616",
      name: "GET",
      op: "http.client",
      parentSpanId: "1111111111111111",
      spanId: "1616161616161616",
      data: {
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "url.path": "/api/v200/resources",
      },
    });
    const genAiSpan = buildTraceSpanNode({
      children: [httpClientSpan, toolSpan],
      duration: 123419,
      eventId: "22222222222222222222222222222222",
      name: "ai.generate_assistant_reply",
      op: "gen_ai.invoke_agent",
      parentSpanId: "1111111111111111",
      spanId: "2222222222222222",
      data: {
        "gen_ai.conversation.id": "conv-trace-123",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-haiku-unused",
      },
      tags: {
        "gen_ai.response.model": "claude-opus-4.6",
      },
    });
    const dbSpan = buildTraceSpanNode({
      duration: 44,
      eventId: "66666666666666666666666666666666",
      name: "db",
      op: "db.query",
      parentSpanId: "1111111111111111",
      spanId: "6666666666666666",
      data: {
        "db.collection.name": "issues",
        "db.operation.name": "SELECT",
        "db.response.status_code": "OK",
        "db.system.name": "postgresql",
      },
    });
    const dbServerTargetSpan = buildTraceSpanNode({
      duration: 41,
      eventId: "15151515151515151515151515151515",
      name: "db",
      op: "db.query",
      parentSpanId: "1111111111111111",
      spanId: "1515151515151515",
      data: {
        "db.operation.name": "SELECT",
        "db.system.name": "postgresql",
        "server.address": "db.internal",
      },
    });
    const rpcSpan = buildTraceSpanNode({
      duration: 65,
      eventId: "77777777777777777777777777777777",
      name: "grpc",
      op: "rpc.client",
      parentSpanId: "1111111111111111",
      spanId: "7777777777777777",
      data: {
        "rpc.method": "FetchTrace",
        "rpc.response.status_code": "OK",
        "rpc.service": "sentry.trace.v1.TraceService",
        "rpc.system.name": "grpc",
      },
    });
    const rpcSubstringStatusSpan = buildTraceSpanNode({
      duration: 24,
      eventId: "17171717171717171717171717171717",
      name: "workflow",
      op: "rpc.client",
      parentSpanId: "1111111111111111",
      spanId: "1717171717171717",
      data: {
        "rpc.method": "Run",
        "rpc.response.status_code": "OK",
        "rpc.service": "bookings_workflow",
        "rpc.system.name": "temporal",
      },
    });
    const messagingSpan = buildTraceSpanNode({
      duration: 37,
      eventId: "88888888888888888888888888888888",
      name: "publish",
      op: "messaging.publish",
      parentSpanId: "1111111111111111",
      spanId: "8888888888888888",
      data: {
        "messaging.destination.name": "trace-events",
        "messaging.operation.type": "publish",
        "messaging.system": "kafka",
      },
    });
    const mcpSpan = buildTraceSpanNode({
      duration: 28,
      eventId: "99999999999999999999999999999999",
      name: "mcp",
      op: "mcp.request",
      parentSpanId: "1111111111111111",
      spanId: "9999999999999999",
      data: {
        "gen_ai.tool.name": "search_events",
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "url.path": "/mcp",
        "mcp.method.name": "tools/call",
        "rpc.response.status_code": "OK",
      },
    });
    const graphqlSpan = buildTraceSpanNode({
      duration: 31,
      eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "GraphQL Operation",
      op: "graphql.execute",
      parentSpanId: "1111111111111111",
      spanId: "aaaaaaaaaaaaaaaa",
      data: {
        "graphql.operation.name": "TraceDetails",
        "graphql.operation.type": "query",
      },
    });
    const faasSpan = buildTraceSpanNode({
      duration: 52,
      eventId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "lambda",
      op: "faas.invoke",
      parentSpanId: "1111111111111111",
      spanId: "bbbbbbbbbbbbbbbb",
      data: {
        "faas.coldstart": true,
        "faas.invoked_name": "trace-worker",
        "faas.invoked_provider": "aws",
        "faas.invoked_region": "us-west-2",
        "faas.trigger": "timer",
      },
    });
    const objectStoreSpan = buildTraceSpanNode({
      duration: 73,
      eventId: "cccccccccccccccccccccccccccccccc",
      name: "S3.PutObject",
      op: "aws.s3",
      parentSpanId: "1111111111111111",
      spanId: "cccccccccccccccc",
      data: {
        "aws.s3.bucket": "trace-artifacts",
        "aws.s3.key": "runs/abc.json",
        "cloud.region": "us-west-2",
        "rpc.method": "PutObject",
      },
    });
    const cloudEventsSpan = buildTraceSpanNode({
      duration: 19,
      eventId: "dddddddddddddddddddddddddddddddd",
      name: "event",
      op: "event.process",
      parentSpanId: "1111111111111111",
      spanId: "dddddddddddddddd",
      data: {
        "cloudevents.event_spec_version": "1.0",
        "cloudevents.event_subject": "trace/e4d1",
        "cloudevents.event_type": "com.sentry.trace.created",
      },
    });
    const cicdSpan = buildTraceSpanNode({
      duration: 88,
      eventId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      name: "ci",
      op: "cicd.pipeline",
      parentSpanId: "1111111111111111",
      spanId: "eeeeeeeeeeeeeeee",
      data: {
        "cicd.pipeline.action.name": "BUILD",
        "cicd.pipeline.name": "mcp-core",
        "cicd.pipeline.result": "success",
      },
    });
    const featureFlagSpan = buildTraceSpanNode({
      duration: 12,
      eventId: "ffffffffffffffffffffffffffffffff",
      name: "flag",
      op: "feature_flag.evaluate",
      parentSpanId: "1111111111111111",
      spanId: "ffffffffffffffff",
      data: {
        "feature_flag.key": "semantic-trace-rendering",
        "feature_flag.provider.name": "flagsmith",
        "feature_flag.result.reason": "targeting_match",
        "feature_flag.result.variant": "on",
      },
    });
    const cloudProviderSpan = buildTraceSpanNode({
      duration: 21,
      eventId: "abababababababababababababababab",
      name: "AWS SDK",
      op: "aws.sdk",
      parentSpanId: "1111111111111111",
      spanId: "abababababababab",
      data: {
        "cloud.region": "us-east-1",
        "rpc.method": "DynamoDB.GetItem",
        "rpc.system.name": "aws-api",
      },
    });
    const exceptionSpan = buildTraceSpanNode({
      duration: 13,
      eventId: "acacacacacacacacacacacacacacacac",
      name: "job failed",
      op: "exception",
      parentSpanId: "1111111111111111",
      spanId: "acacacacacacacac",
      data: {
        "exception.type": "ValueError",
        "faas.coldstart": false,
      },
    });
    const unnamedExceptionSpan = buildTraceSpanNode({
      duration: 14,
      eventId: "18181818181818181818181818181818",
      name: null,
      op: "exception",
      parentSpanId: "1111111111111111",
      spanId: "1818181818181818",
      data: {
        "exception.type": "TypeError",
      },
    });
    const errorSpan = buildTraceSpanNode({
      duration: 11,
      eventId: "12121212121212121212121212121212",
      name: "background job",
      op: "internal",
      parentSpanId: "1111111111111111",
      spanId: "1212121212121212",
      data: {
        "error.type": "timeout",
      },
    });
    const rootSpan = buildTraceSpanNode({
      children: [
        genAiSpan,
        httpMethodOnlySpan,
        httpExtensionMethodSpan,
        httpServerTargetSpan,
        httpVersionedPathSpan,
        dbSpan,
        dbServerTargetSpan,
        rpcSpan,
        rpcSubstringStatusSpan,
        messagingSpan,
        mcpSpan,
        graphqlSpan,
        faasSpan,
        objectStoreSpan,
        cloudEventsSpan,
        cicdSpan,
        featureFlagSpan,
        cloudProviderSpan,
        exceptionSpan,
        unnamedExceptionSpan,
        errorSpan,
      ],
      duration: 3,
      eventId: "11111111111111111111111111111111",
      name: "POST",
      op: "http.server",
      parentSpanId: null,
      spanId: "1111111111111111",
      data: {
        "http.request.method": "POST",
        "http.response.status_code": 201,
        "http.route": "/api/internal/turn-resume",
      },
    });

    mswServer.use(
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/${traceId}/`,
        () =>
          HttpResponse.json({
            logs: 0,
            errors: 0,
            performance_issues: 0,
            span_count: 25,
            transaction_child_count_map: [],
            span_count_map: {},
          }),
      ),
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        () => HttpResponse.json([rootSpan]),
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    const text = typeof result === "string" ? result : getTextContent(result);
    expect(text).toContain(
      "POST /api/internal/turn-resume [http.server · 201 · 3ms · 1111111111111111]",
    );
    expect(text).toContain(
      "invoke_agent anthropic/claude-opus-4.6 [gen_ai.invoke_agent · 123419ms · 2222222222222222]",
    );
    expect(text).toContain("## Agent Conversations");
    expect(text).toContain("**Conversation ID**: `conv-trace-123`");
    expect(text).toContain("**Matching Span**: `2222222222222222`");
    expect(text).toContain(
      'Use the Sentry tool `execute_sentry_tool(name=\'get_agent_conversation_details\', arguments={"organizationSlug":"sentry-mcp-evals","conversationId":"conv-trace-123"})` to fetch the full transcript.',
    );
    expect(text).toContain(
      "POST api.anthropic.com/v1/messages [http.client · 200 · 21455ms · 3333333333333333]",
    );
    expect(text).toContain(
      "POST [http.client · 204 · 16ms · 1313131313131313]",
    );
    expect(text).toContain(
      "PROPFIND [http.client · 207 · 15ms · 1919191919191919]",
    );
    expect(text).toContain(
      "GET api.example.com:443 [http.client · 17ms · 1414141414141414]",
    );
    expect(text).toContain(
      "GET /api/v200/resources [http.client · 200 · 18ms · 1616161616161616]",
    );
    expect(text).toContain(
      "execute_tool search_events [gen_ai.execute_tool · 4107ms · 4444444444444444]",
    );
    expect(text).toContain(
      "git [process.exec · exit:0 · 4050ms · 5555555555555555]",
    );
    expect(text).toContain(
      "SELECT issues [db.query · postgresql · OK · 44ms · 6666666666666666]",
    );
    expect(text).toContain(
      "SELECT db.internal [db.query · postgresql · 41ms · 1515151515151515]",
    );
    expect(text).toContain(
      "sentry.trace.v1.TraceService/FetchTrace [rpc.client · grpc · OK · 65ms · 7777777777777777]",
    );
    expect(text).toContain(
      "bookings_workflow/Run [rpc.client · temporal · OK · 24ms · 1717171717171717]",
    );
    expect(text).toContain(
      "publish trace-events [messaging.publish · kafka · 37ms · 8888888888888888]",
    );
    expect(text).toContain(
      "tools/call search_events [mcp.request · OK · 28ms · 9999999999999999]",
    );
    expect(text).toContain(
      "query TraceDetails [graphql.execute · 31ms · aaaaaaaaaaaaaaaa]",
    );
    expect(text).toContain(
      "timer trace-worker [faas.invoke · aws · us-west-2 · coldstart · 52ms · bbbbbbbbbbbbbbbb]",
    );
    expect(text).toContain(
      "PutObject trace-artifacts/runs/abc.json [aws.s3 · us-west-2 · 73ms · cccccccccccccccc]",
    );
    expect(text).toContain(
      "com.sentry.trace.created trace/e4d1 [event.process · cloudevents:1.0 · 19ms · dddddddddddddddd]",
    );
    expect(text).toContain(
      "BUILD mcp-core [cicd.pipeline · success · 88ms · eeeeeeeeeeeeeeee]",
    );
    expect(text).toContain(
      "semantic-trace-rendering on [feature_flag.evaluate · flagsmith · targeting_match · 12ms · ffffffffffffffff]",
    );
    expect(text).toContain(
      "DynamoDB.GetItem [aws.sdk · aws-api · us-east-1 · 21ms · abababababababab]",
    );
    expect(text).toContain(
      "job failed [exception · ValueError · 13ms · acacacacacacacac]",
    );
    expect(text).toContain("TypeError [exception · 14ms · 1818181818181818]");
    expect(text).toContain(
      "background job [internal · timeout · 11ms · 1212121212121212]",
    );
  });

  it("fetches enough spans to resolve focused spans in large traces", async () => {
    const traceId = "c4d1aae7216b47ff8117cf4e09ce9d0c";
    const spanId = "00000000000007d0";

    mswServer.use(
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/${traceId}/`,
        () =>
          HttpResponse.json({
            logs: 0,
            errors: 0,
            performance_issues: 0,
            span_count: 2000,
            transaction_child_count_map: [],
            span_count_map: {},
          }),
      ),
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        ({ request }) => {
          const limit = Number(
            new URL(request.url).searchParams.get("limit") ?? "0",
          );

          if (limit < 2000) {
            return HttpResponse.json([]);
          }

          return HttpResponse.json([
            buildTraceSpan({
              eventId: "1".repeat(32),
              spanId,
              description: "Late span in a large trace",
            }),
          ]);
        },
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId,
        spanId,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain(`# Span \`${spanId}\` in Trace \`${traceId}\``);
    expect(result).toContain("Late span in a large trace");
    expect(result).toContain("**Trace Total Spans**: 2000");
  });

  it("reports a partial fetch when a focused span is missing from a large trace", async () => {
    const traceId = "d4d1aae7216b47ff8117cf4e09ce9d0d";
    const fetchedTrace = Array.from({ length: 10000 }, (_, index) =>
      buildTraceSpan({
        eventId: index.toString(16).padStart(32, "0"),
        spanId: index.toString(16).padStart(16, "0"),
      }),
    );

    mswServer.use(
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/${traceId}/`,
        () =>
          HttpResponse.json({
            logs: 0,
            errors: 0,
            performance_issues: 0,
            span_count: 20000,
            transaction_child_count_map: [],
            span_count_map: {},
          }),
      ),
      ...httpGetRegional(
        `https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/${traceId}/`,
        () => HttpResponse.json(fetchedTrace),
      ),
    );

    await expect(
      getTraceDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          traceId,
          spanId: "ffffffffffffffff",
          regionUrl: null,
        },
        {
          constraints: {
            organizationSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(
      /was not found in the fetched portion of trace .*Fetched 10000 of 20000 spans\./,
    );
  }, 60_000);

  it("renders a focused span with child snapshot and attributes", async () => {
    mswServer.use(
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace-meta/b4d1aae7216b47ff8117cf4e09ce9d0b/",
        () =>
          HttpResponse.json({
            logs: 0,
            errors: 2,
            performance_issues: 0,
            span_count: 4,
            transaction_child_count_map: [],
            span_count_map: {},
          }),
      ),
      ...httpGetRegional(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/trace/b4d1aae7216b47ff8117cf4e09ce9d0b/",
        () => HttpResponse.json(traceMixedFixture),
      ),
    );

    const result = await getTraceDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        traceId: "b4d1aae7216b47ff8117cf4e09ce9d0b",
        spanId: "aa8e7f3384ef4ff5",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toMatchInlineSnapshot(`
      "# Span \`aa8e7f3384ef4ff5\` in Trace \`b4d1aae7216b47ff8117cf4e09ce9d0b\` in **sentry-mcp-evals**

      ## Summary

      **Project**: mcp-server
      **Operation**: function
      **Description**: tools/call search_events
      **Duration**: 5203ms
      **Exclusive Time**: 3495ms
      **Status**: unknown
      **Parent Span ID**: None (root span)
      **Child Spans**: 1
      **Descendant Spans**: 1
      **Errors**: 0
      **Event Type**: span
      **SDK**: sentry.javascript.bun
      **Trace Total Spans**: 4

      ## Child Snapshot

      tools/call search_events [function · 5203ms · aa8e7f3384ef4ff5]
         └─ POST https://api.openai.com/v1/chat/completions [http.client · 1708ms · ad0f7c48fb294de3]

      *Child snapshot shows 1 of 1 descendant spans.*

      ## View Full Span

      **Sentry URL**: https://sentry-mcp-evals.sentry.io/explore/traces/trace/b4d1aae7216b47ff8117cf4e09ce9d0b?node=span-aa8e7f3384ef4ff5

      ## Attributes

      ### Core Fields

      \`\`\`json
      {
        "description": "tools/call search_events",
        "duration": 5203,
        "end_timestamp": 1713805463.608875,
        "event_id": "aa8e7f3384ef4ff5850ba966b29ed10d",
        "exclusive_time": 3495,
        "hash": "4ed30c7c-4fae-4c79-b2f1-be95c24e7b04",
        "is_segment": true,
        "op": "function",
        "organization": null,
        "parent_span_id": null,
        "profile_id": "",
        "profiler_id": "",
        "project_id": 4509109107622913,
        "project_slug": "mcp-server",
        "same_process_as_parent": true,
        "sdk_name": "sentry.javascript.bun",
        "span_id": "aa8e7f3384ef4ff5",
        "start_timestamp": 1713805458.405616,
        "status": null,
        "timestamp": 1713805463.608875,
        "trace": "b4d1aae7216b47ff8117cf4e09ce9d0b",
        "transaction_id": "aa8e7f3384ef4ff5850ba966b29ed10d"
      }
      \`\`\`

      ### Measurements

      \`\`\`json
      {}
      \`\`\`

      ### Tags

      \`\`\`json
      {
        "ai.input_messages": "1",
        "ai.model_id": "gpt-4o-2024-08-06",
        "ai.pipeline.name": "search_events",
        "ai.response.finish_reason": "stop",
        "ai.streaming": "false",
        "ai.total_tokens.used": "435",
        "server_name": "mcp-server"
      }
      \`\`\`

      ### Data

      \`\`\`json
      {}
      \`\`\`

      ### Additional Attributes

      \`\`\`json
      {}
      \`\`\`

      ### Errors

      \`\`\`json
      []
      \`\`\`

      ### Occurrences

      \`\`\`json
      []
      \`\`\`

      ## Next Steps

      - **Search spans**: Use the Sentry tool \`search_traces\`
      - **Search errors**: Use the Sentry tool \`search_errors\`
      - **Search logs**: Use the Sentry tool \`search_logs\`"
    `);
  });
});
