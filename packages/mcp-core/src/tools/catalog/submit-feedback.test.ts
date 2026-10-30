import { captureFeedback, getClient } from "@sentry/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import submitFeedback from "./submit-feedback.js";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return {
    ...actual,
    captureFeedback: vi.fn(() => "event-id"),
    getClient: vi.fn(),
  };
});

const params = {
  task: "find slow endpoints",
  kind: "missing" as const,
  impact: "blocked" as const,
  description: "No tool returns p95 latency. Contact jane@example.com.",
  toolName: "search_traces",
};

describe("submit_feedback", () => {
  beforeEach(() => {
    vi.mocked(captureFeedback).mockClear();
    vi.mocked(getClient).mockReturnValue({
      getDsn: () => ({ host: "o1.ingest.sentry.io" }),
    } as unknown as ReturnType<typeof getClient>);
  });

  it("sends scrubbed feedback to Sentry", async () => {
    const result = await submitFeedback.handler(params, createTestContext());

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "submitted": true,
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

  it("does not send feedback when Sentry is not configured", async () => {
    vi.mocked(getClient).mockReturnValue(undefined);

    const result = await submitFeedback.handler(params, createTestContext());

    expect(getStructuredContent(result)).toEqual({ submitted: false });
    expect(captureFeedback).not.toHaveBeenCalled();
  });
});
