import { captureFeedback } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import { UserInputError } from "../../errors.js";
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
      createTestContext({ clientFamily: "opencode", userId: "123" }),
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
        "name": "MCP agent (opencode) for user 123",
        "source": "mcp_agent",
        "tags": {
          "feedback.impact": "blocked",
          "feedback.kind": "missing",
          "feedback.tool": "search_traces",
        },
      }
    `);
  });

  it("names a generic agent without client or user context", async () => {
    await submitFeedbackToSentryTeam.handler(
      {
        task: "find slow endpoints",
        kind: "idea",
        impact: "friction",
        description: "Add p95 latency per endpoint.",
      },
      createTestContext(),
    );

    expect(vi.mocked(captureFeedback).mock.calls.at(-1)?.[0].name).toBe(
      "MCP agent",
    );
  });

  // MCP-SERVER-GNZ logged a skipped step ("No fue necesario; se omite.") and
  // MCP-SERVER-GP0 announced a shell task ("checking for running Podman
  // containers") that never needed Sentry. Neither reported a problem, and
  // no word list catches them, so the description has to rule them out.
  it("tells agents to call it only for Sentry MCP problems", () => {
    const { description } = submitFeedbackToSentryTeam;

    expect(description).not.toContain("after you finish or give up");
    expect(description).toContain(
      "Call it only when a Sentry MCP tool was missing, failed, or got in the way",
    );
    expect(description).toContain(
      "Skip it if the task went fine, was skipped, or did not need Sentry.",
    );
  });

  // MCP-SERVER-GNB, GMP and GK1 were filler-only reports from three clients.
  it.each(["placeholder", "N/A", "noop", " ... "])(
    "rejects the placeholder description %j",
    async (description) => {
      vi.mocked(captureFeedback).mockClear();

      await expect(
        submitFeedbackToSentryTeam.handler(
          {
            task: description,
            kind: "broken",
            impact: "friction",
            description,
          },
          createTestContext(),
        ),
      ).rejects.toThrow(UserInputError);
      expect(captureFeedback).not.toHaveBeenCalled();
    },
  );

  it("accepts a short real description", async () => {
    await submitFeedbackToSentryTeam.handler(
      {
        task: "test alert rule",
        kind: "missing",
        impact: "blocked",
        description: "No tool tests an alert rule.",
      },
      createTestContext(),
    );

    expect(vi.mocked(captureFeedback).mock.calls.at(-1)?.[0].message).toBe(
      "Task: test alert rule\n\nNo tool tests an alert rule.",
    );
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
