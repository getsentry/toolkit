import { captureFeedback, getClient } from "@sentry/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../errors.js";
import { createTestContext } from "../../test-utils/context.js";
import reportSentryProblem from "./report-sentry-problem.js";

vi.mock("@sentry/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/core")>()),
  captureFeedback: vi.fn(() => "feedback-event-id"),
  getClient: vi.fn(),
}));

describe("report_sentry_problem", () => {
  beforeEach(() => {
    vi.mocked(captureFeedback).mockClear();
    vi.mocked(getClient).mockReturnValue(
      {} as unknown as ReturnType<typeof getClient>,
    );
  });

  it("sends the report as user feedback", async () => {
    const result = await reportSentryProblem.handler(
      {
        surface: "mcp",
        target: "search_issues",
        expected: "Unresolved issues",
        actual: "Schema validation error",
        reference: "trace-123",
      },
      createTestContext({ clientFamily: "claude-code" }),
    );

    expect(result).toMatchInlineSnapshot(`
      "# Problem Reported

      Sent a report about **Sentry MCP** (\`search_issues\`) to the Sentry team.

      **Report ID**: feedback-event-id

      ## Response Notes

      - Tell the user the report was sent and share the report ID."
    `);
    expect(captureFeedback).toHaveBeenCalledWith({
      message: [
        "[Sentry MCP] search_issues",
        "",
        "Expected: Unresolved issues",
        "Actual: Schema validation error",
        "Reference: trace-123",
      ].join("\n"),
      source: "mcp_agent_report",
      tags: {
        "agent_report.surface": "mcp",
        "agent_report.target": "search_issues",
        "agent_report.client_family": "claude-code",
      },
    });
  });

  it("omits the reference and truncates long target tags", async () => {
    const target = `https://docs.sentry.io/${"a".repeat(300)}`;

    await reportSentryProblem.handler(
      {
        surface: "docs",
        target,
        expected: "Current setup steps",
        actual: "Page references a removed option",
        reference: null,
      },
      createTestContext(),
    );

    const params = vi.mocked(captureFeedback).mock.calls[0]?.[0];
    expect(params?.message).not.toContain("Reference:");
    expect(params?.message).toContain(target);
    expect(params?.tags?.["agent_report.target"]).toHaveLength(200);
    expect(params?.tags?.["agent_report.client_family"]).toBe("unknown");
  });

  it("fails when Sentry telemetry is not configured", async () => {
    vi.mocked(getClient).mockReturnValue(undefined);

    await expect(
      reportSentryProblem.handler(
        {
          surface: "api",
          target: "GET /api/0/organizations/{org}/issues/",
          expected: "Paginated issues",
          actual: "500 error",
          reference: null,
        },
        createTestContext(),
      ),
    ).rejects.toThrow(ConfigurationError);
    expect(captureFeedback).not.toHaveBeenCalled();
  });
});
