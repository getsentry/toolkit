/**
 * Seer Formatter Tests
 *
 * Tests for formatting functions in src/lib/formatters/seer.ts
 */

import { describe, expect, test } from "vitest";
import { SeerError } from "../../../src/lib/errors.js";
import {
  createSeerError,
  formatAutofixError,
  formatIssueExplain,
  formatProgressLine,
  formatRootCauseList,
  formatSolution,
  getProgressMessage,
  getSpinnerFrame,
  handleSeerApiError,
  jsonTransformIssueExplain,
  truncateProgressMessage,
} from "../../../src/lib/formatters/seer.js";
import type {
  AutofixState,
  RootCause,
  SolutionArtifact,
} from "../../../src/types/seer.js";

/** Strip ANSI escape codes */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("getSpinnerFrame", () => {
  test("returns a spinner character", () => {
    const frame = getSpinnerFrame(0);
    expect(typeof frame).toBe("string");
    expect(frame.length).toBeGreaterThan(0);
  });

  test("cycles through frames", () => {
    const frame0 = getSpinnerFrame(0);
    const frame1 = getSpinnerFrame(1);
    const frame10 = getSpinnerFrame(10);

    // Frame 0 and 10 should be the same (assuming 10 frames in the cycle)
    expect(frame0).toBe(frame10);
    expect(frame0).not.toBe(frame1);
  });
});

describe("formatProgressLine", () => {
  test("includes message and spinner", () => {
    const line = formatProgressLine("Processing...", 0);
    expect(line).toContain("Processing...");
    // Should have some character before the message (spinner)
    expect(line.length).toBeGreaterThan("Processing...".length);
  });

  test("changes with different tick values", () => {
    const line0 = formatProgressLine("Test", 0);
    const line1 = formatProgressLine("Test", 1);
    expect(line0).not.toBe(line1);
  });
});

describe("truncateProgressMessage", () => {
  test("returns short message unchanged", () => {
    const message = "Analyzing issue...";
    expect(truncateProgressMessage(message)).toBe(message);
  });

  test("returns message at exactly max length unchanged", () => {
    const message = "x".repeat(300);
    expect(truncateProgressMessage(message)).toBe(message);
  });

  test("truncates message exceeding max length", () => {
    const message = "x".repeat(350);
    const result = truncateProgressMessage(message);
    expect(result.length).toBe(300);
    expect(result.endsWith("...")).toBe(true);
  });

  test("preserves content before truncation point", () => {
    const message = `Important prefix ${"x".repeat(350)}`;
    const result = truncateProgressMessage(message);
    expect(result.startsWith("Important prefix")).toBe(true);
  });
});

describe("getProgressMessage", () => {
  test("returns progress message from steps", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "PROCESSING",
      steps: [
        {
          id: "step-1",
          key: "analysis",
          status: "PROCESSING",
          title: "Analyzing",
          progress: [
            {
              message: "Figuring out the root cause...",
              timestamp: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ],
    };

    expect(getProgressMessage(state)).toBe("Figuring out the root cause...");
  });

  test("returns default message when no steps", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "PROCESSING",
    };

    const message = getProgressMessage(state);
    expect(message).toBeTruthy();
    expect(typeof message).toBe("string");
  });

  test("returns appropriate message based on status", () => {
    // Need empty steps array to trigger status-based fallback
    const completedState: AutofixState = {
      run_id: 123,
      status: "COMPLETED",
      steps: [],
    };

    const errorState: AutofixState = {
      run_id: 123,
      status: "ERROR",
      steps: [],
    };

    expect(getProgressMessage(completedState)).toContain("complete");
    expect(getProgressMessage(errorState)).toContain("fail");
  });

  test("ignores stale progress from earlier completed steps", () => {
    // Reproduces #950: RCA step is COMPLETED with progress, solution step
    // has no progress yet — should NOT show stale RCA messages.
    const state: AutofixState = {
      run_id: 456,
      status: "PROCESSING",
      steps: [
        {
          id: "step-rca",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause Analysis",
          progress: [
            {
              message: "Looking at `src/mdx.ts` in `getsentry/sentry-docs`...",
              timestamp: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "step-solution",
          key: "solution",
          status: "PROCESSING",
          title: "Solution Planning",
          progress: [],
        },
      ],
    };

    const message = getProgressMessage(state);
    // Should NOT return the stale RCA message
    expect(message).not.toContain("Looking at");
    // Should return a status-based fallback
    expect(message).toBe("Analyzing issue...");
  });

  test("returns progress from the current (last) step", () => {
    const state: AutofixState = {
      run_id: 789,
      status: "PROCESSING",
      steps: [
        {
          id: "step-rca",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause Analysis",
          progress: [
            {
              message: "Stale RCA message",
              timestamp: "2025-01-01T00:00:00Z",
            },
          ],
        },
        {
          id: "step-solution",
          key: "solution",
          status: "PROCESSING",
          title: "Solution Planning",
          progress: [
            {
              message: "Generating solution plan...",
              timestamp: "2025-01-01T00:01:00Z",
            },
          ],
        },
      ],
    };

    expect(getProgressMessage(state)).toBe("Generating solution plan...");
  });
});

describe("formatRootCauseList", () => {
  test("formats a basic root cause", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description:
          "Database connection timeout due to missing pool configuration",
      },
    ];

    const output = stripAnsi(formatRootCauseList(causes));
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("Database connection timeout");
  });

  test("includes relevant repos when present", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "Test cause",
        relevant_repos: ["org/repo1", "org/repo2"],
      },
    ];

    const output = stripAnsi(formatRootCauseList(causes));
    expect(output).toContain("org/repo1");
  });

  test("includes reproduction steps when present", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "Test cause",
        root_cause_reproduction: [
          {
            title: "Step 1",
            code_snippet_and_analysis: "User makes API request",
          },
          {
            title: "Step 2",
            code_snippet_and_analysis: "Database query times out",
          },
        ],
      },
    ];

    const output = stripAnsi(formatRootCauseList(causes));
    expect(output).toContain("Step 1");
    expect(output).toContain("User makes API request");
  });

  test("formats single cause", () => {
    const causes: RootCause[] = [{ id: 0, description: "Single root cause" }];

    const output = stripAnsi(formatRootCauseList(causes));
    expect(output).toContain("Single root cause");
  });

  test("formats multiple causes", () => {
    const causes: RootCause[] = [
      { id: 0, description: "First cause" },
      { id: 1, description: "Second cause" },
    ];

    const output = stripAnsi(formatRootCauseList(causes));
    expect(output).toContain("First cause");
    expect(output).toContain("Second cause");
  });

  test("handles empty causes array", () => {
    const output = stripAnsi(formatRootCauseList([]));
    expect(output).toContain("No root causes");
  });
});

describe("issue explain batch formatting", () => {
  const data = {
    results: [
      {
        issue: "IOS-1",
        org: "test-org",
        issueId: "1",
        rootCauses: [{ id: 0, description: "First cause" }],
      },
      {
        issue: "IOS-2",
        org: "test-org",
        issueId: "2",
        rootCauses: [{ id: 0, description: "Second cause" }],
      },
    ],
    requestedCount: 2,
  };

  test("labels each issue in human output", () => {
    const output = stripAnsi(formatIssueExplain(data));
    expect(output).toContain("IOS-1");
    expect(output).toContain("First cause");
    expect(output).toContain("─");
    expect(output).toContain("IOS-2");
    expect(output).toContain("Second cause");
  });

  test("returns labeled envelopes in multi-issue JSON", () => {
    expect(jsonTransformIssueExplain(data)).toEqual([
      expect.objectContaining({
        issue: "IOS-1",
        rootCauses: [expect.objectContaining({ description: "First cause" })],
      }),
      expect.objectContaining({
        issue: "IOS-2",
        rootCauses: [expect.objectContaining({ description: "Second cause" })],
      }),
    ]);
  });

  test("preserves the root-cause array for single-issue JSON", () => {
    expect(
      jsonTransformIssueExplain({
        results: data.results.slice(0, 1),
        requestedCount: 1,
      })
    ).toEqual([expect.objectContaining({ description: "First cause" })]);
  });

  test("filters root-cause fields without dropping issue labels", () => {
    expect(jsonTransformIssueExplain(data, ["description"])).toEqual([
      {
        issue: "IOS-1",
        org: "test-org",
        issueId: "1",
        rootCauses: [{ description: "First cause" }],
      },
      {
        issue: "IOS-2",
        org: "test-org",
        issueId: "2",
        rootCauses: [{ description: "Second cause" }],
      },
    ]);
  });
});

describe("formatAutofixError", () => {
  // Note: 402 and 403 errors are handled by SeerError via createSeerError()
  // formatAutofixError only handles non-Seer errors

  test("formats 404 Not Found", () => {
    const message = formatAutofixError(404);
    expect(message.toLowerCase()).toContain("not found");
  });

  test("returns detail message for unknown errors", () => {
    const message = formatAutofixError(500, "Internal server error");
    expect(message).toBe("Internal server error");
  });

  test("returns generic message when no detail", () => {
    const message = formatAutofixError(500);
    expect(message).toBeTruthy();
  });
});

describe("createSeerError", () => {
  test("returns SeerError for 402 status", () => {
    const error = createSeerError(402, undefined, "my-org");
    expect(error).toBeInstanceOf(SeerError);
    expect(error?.reason).toBe("no_budget");
    expect(error?.orgSlug).toBe("my-org");
  });

  test("returns SeerError for 403 with 'not enabled' detail", () => {
    const error = createSeerError(403, "Seer is not enabled", "my-org");
    expect(error).toBeInstanceOf(SeerError);
    expect(error?.reason).toBe("not_enabled");
  });

  test("returns SeerError for 403 with 'AI features' detail", () => {
    const error = createSeerError(403, "AI features are disabled", "my-org");
    expect(error).toBeInstanceOf(SeerError);
    expect(error?.reason).toBe("ai_disabled");
  });

  test("returns null for unrecognized 403 errors", () => {
    // Unrecognized 403 errors should return null to preserve original error detail
    // (could be permission denied, rate limiting, etc.)
    const error = createSeerError(403, "Some other message", "my-org");
    expect(error).toBeNull();
  });

  test("returns null for other status codes", () => {
    expect(createSeerError(404)).toBeNull();
    expect(createSeerError(500)).toBeNull();
    expect(createSeerError(200)).toBeNull();
  });
});

describe("handleSeerApiError", () => {
  test("returns SeerError for Seer-specific status codes", () => {
    const error = handleSeerApiError(402, undefined, "my-org");
    expect(error).toBeInstanceOf(SeerError);
  });

  test("returns generic Error for non-Seer status codes", () => {
    const error = handleSeerApiError(404);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SeerError);
  });

  test("includes detail in generic error message", () => {
    const error = handleSeerApiError(500, "Server exploded");
    expect(error.message).toBe("Server exploded");
  });
});

describe("SeerError formatting", () => {
  test("format() includes message and URL for not_enabled", () => {
    const error = new SeerError("not_enabled", "my-org");
    const formatted = error.format();
    expect(formatted).toContain("Seer is not enabled");
    expect(formatted).toContain("https://my-org.sentry.io/settings/seer/");
  });

  test("format() includes message and billing URL for no_budget", () => {
    const error = new SeerError("no_budget", "my-org");
    const formatted = error.format();
    expect(formatted).toContain("Seer requires a paid plan");
    expect(formatted).toContain(
      "https://my-org.sentry.io/settings/billing/overview/?product=seer"
    );
  });

  test("format() includes message and URL for ai_disabled", () => {
    const error = new SeerError("ai_disabled", "my-org");
    const formatted = error.format();
    expect(formatted).toContain("AI features are disabled");
    expect(formatted).toContain(
      "https://my-org.sentry.io/settings/#hideAiFeatures"
    );
  });

  test("format() uses fallback text when no orgSlug", () => {
    const error = new SeerError("not_enabled");
    const formatted = error.format();
    expect(formatted).toContain("Seer is not enabled");
    expect(formatted).toContain("organization's Seer settings");
    // Should NOT contain broken URL patterns
    expect(formatted).not.toContain("undefined");
    expect(formatted).not.toContain("/seer/");
  });
});

describe("formatSolution", () => {
  function makeSolution(
    overrides: Partial<SolutionArtifact["data"]> = {}
  ): SolutionArtifact {
    return {
      key: "solution",
      data: {
        one_line_summary: "Add null check before accessing user.name",
        steps: [
          {
            title: "Update the handler function",
            description: "Check for null before accessing the property.",
          },
        ],
        ...overrides,
      },
    };
  }

  test("returns a string", () => {
    const result = formatSolution(makeSolution());
    expect(typeof result).toBe("string");
  });

  test("includes summary text", () => {
    const result = stripAnsi(formatSolution(makeSolution()));
    expect(result).toContain("Add null check before accessing user.name");
  });

  test("includes Solution heading", () => {
    const result = stripAnsi(formatSolution(makeSolution()));
    expect(result).toContain("Solution");
  });

  test("includes step titles", () => {
    const result = stripAnsi(
      formatSolution(
        makeSolution({
          steps: [
            { title: "Step One", description: "Do the first thing." },
            { title: "Step Two", description: "Do the second thing." },
          ],
        })
      )
    );
    expect(result).toContain("Step One");
    expect(result).toContain("Step Two");
    expect(result).toContain("Do the first thing");
    expect(result).toContain("Do the second thing");
  });

  test("handles empty steps array", () => {
    const result = stripAnsi(formatSolution(makeSolution({ steps: [] })));
    expect(result).toContain("Solution");
    expect(result).toContain("Add null check");
    expect(result).not.toContain("Steps to implement");
  });

  test("preserves markdown in step descriptions", () => {
    const result = stripAnsi(
      formatSolution(
        makeSolution({
          steps: [
            {
              title: "Fix code",
              description: "Change `foo()` to `bar()`\nThen redeploy.",
            },
          ],
        })
      )
    );
    expect(result).toContain("Fix code");
    expect(result).toContain("foo()");
  });
});
