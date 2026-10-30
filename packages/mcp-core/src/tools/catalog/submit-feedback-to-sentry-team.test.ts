import { captureFeedback } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import submitFeedbackToSentryTeam from "./submit-feedback-to-sentry-team.js";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return { ...actual, captureFeedback: vi.fn(() => "event-id") };
});

describe("submit_feedback_to_sentry_team", () => {
  it("sends scrubbed feedback to Sentry", async () => {
    const result = await submitFeedbackToSentryTeam.handler(
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

  it("truncates messages to Sentry's feedback length limit", async () => {
    await submitFeedbackToSentryTeam.handler(
      {
        task: "find slow endpoints",
        kind: "broken",
        impact: "friction",
        description: "x".repeat(4096),
        toolName: "search_traces",
      },
      createTestContext(),
    );

    const message = vi.mocked(captureFeedback).mock.calls.at(-1)?.[0].message;
    expect(message?.startsWith("Task: find slow endpoints\n")).toBe(true);
    expect(message).toHaveLength(4096);
  });
});
