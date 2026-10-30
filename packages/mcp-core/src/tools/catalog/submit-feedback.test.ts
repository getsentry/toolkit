import { captureFeedback } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import submitFeedback from "./submit-feedback.js";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return { ...actual, captureFeedback: vi.fn(() => "event-id") };
});

describe("submit_feedback", () => {
  it("sends scrubbed feedback to Sentry", async () => {
    const result = await submitFeedback.handler(
      {
        task: "find slow endpoints",
        kind: "missing",
        impact: "blocked",
        description: "No tool returns p95 latency. Contact jane@example.com.",
        toolName: "search_traces",
      },
      createTestContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "feedbackId": "event-id",
      }
    `);
    expect(vi.mocked(captureFeedback).mock.calls[0]?.[0])
      .toMatchInlineSnapshot(`
      {
        "message": "Task: find slow endpoints
      Tool: search_traces

      No tool returns p95 latency. Contact [REDACTED_EMAIL].",
        "source": "mcp_agent",
        "tags": {
          "feedback.impact": "blocked",
          "feedback.kind": "missing",
          "feedback.tool": "search_traces",
        },
      }
    `);
  });
});
