import { traceMixedFixture } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "@sentry/mcp-server-mocks";
import getSpanDetails from "./get-span-details.js";

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

describe("get_span_details", () => {
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

    const result = await getSpanDetails.handler(
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
