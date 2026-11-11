import { describe, it, expect } from "vitest";
import {
  isTerminalStatus,
  isHumanInterventionStatus,
  getStatusDisplayName,
  getHumanInterventionGuidance,
  isSeerSupportedIssue,
  getSeerUnsupportedIssueMessage,
  getOutputForAutofixRun,
  getAutofixArtifactSummaries,
} from "./seer";
import type { AutofixRun } from "../../api-client/types";

const singleRun = {
  run_id: 1,
  status: "completed",
  blocks: [
    {
      artifacts: [
        {
          key: "root_cause",
          data: {
            headline: "Regex rejects ids",
            cause: "The regex is too strict.",
          },
          reason: "",
        },
      ],
    },
  ],
  repo_pr_states: {},
} as unknown as AutofixRun;

describe("single-run root cause", () => {
  it("renders the headline and cause", () => {
    const output = getOutputForAutofixRun(singleRun, {
      includeProvenanceTags: false,
    });
    expect(output).toContain(
      "## Root Cause Analysis\n\nRegex rejects ids\n\nThe regex is too strict.",
    );
  });

  it("summarizes with the headline", () => {
    expect(getAutofixArtifactSummaries(singleRun).rootCause).toBe(
      "Regex rejects ids",
    );
  });
});

describe("seer-utils", () => {
  describe("isTerminalStatus", () => {
    it("returns true for terminal statuses", () => {
      expect(isTerminalStatus("completed")).toBe(true);
      expect(isTerminalStatus("error")).toBe(true);
      expect(isTerminalStatus("awaiting_user_input")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(isTerminalStatus("processing")).toBe(false);
    });
  });

  describe("isHumanInterventionStatus", () => {
    it("returns true for human intervention statuses", () => {
      expect(isHumanInterventionStatus("awaiting_user_input")).toBe(true);
    });

    it("returns false for other statuses", () => {
      expect(isHumanInterventionStatus("completed")).toBe(false);
      expect(isHumanInterventionStatus("processing")).toBe(false);
      expect(isHumanInterventionStatus("error")).toBe(false);
    });
  });

  describe("getStatusDisplayName", () => {
    it("returns friendly names for known statuses", () => {
      expect(getStatusDisplayName("completed")).toBe("Complete");
      expect(getStatusDisplayName("error")).toBe("Failed");
      expect(getStatusDisplayName("awaiting_user_input")).toBe(
        "Waiting for Response",
      );
      expect(getStatusDisplayName("processing")).toBe("Processing");
    });

    it("returns status as-is for unknown statuses", () => {
      expect(getStatusDisplayName("unknown_status")).toBe("unknown_status");
    });
  });

  describe("getHumanInterventionGuidance", () => {
    it("returns guidance for awaiting_user_input", () => {
      const guidance = getHumanInterventionGuidance("awaiting_user_input");
      expect(guidance).toContain("Seer is waiting for your response");
    });

    it("returns empty string for other statuses", () => {
      expect(getHumanInterventionGuidance("completed")).toBe("");
      expect(getHumanInterventionGuidance("processing")).toBe("");
    });
  });

  describe("isSeerSupportedIssue", () => {
    it("rejects metric category issues", () => {
      expect(
        isSeerSupportedIssue({
          issueCategory: "metric",
          issueType: "performance_p95_endpoint_regression",
        }),
      ).toBe(false);
    });

    it("rejects metric_issue type", () => {
      expect(
        isSeerSupportedIssue({
          issueCategory: "error",
          issueType: "metric_issue",
        }),
      ).toBe(false);
    });

    it("accepts standard error issues", () => {
      expect(
        isSeerSupportedIssue({
          issueCategory: "error",
          issueType: "error",
        }),
      ).toBe(true);
    });
  });

  describe("getSeerUnsupportedIssueMessage", () => {
    it("returns actionable guidance for metric issues", () => {
      const message = getSeerUnsupportedIssueMessage({
        shortId: "MCP-SERVER-EQE",
        issueCategory: "metric",
        issueType: "performance_p95_endpoint_regression",
      });

      expect(message).toContain("Seer Analysis Not Available");
      expect(message).toContain("MCP-SERVER-EQE");
      expect(message).toContain("search_metrics");
      expect(message).not.toContain("Starting new analysis");
    });
  });
});
