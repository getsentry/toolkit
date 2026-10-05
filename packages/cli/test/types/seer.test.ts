/**
 * Seer Type Helper Tests
 *
 * Tests for pure functions in src/types/seer.ts
 */

import { describe, expect, test } from "vitest";
import {
  type AutofixState,
  extractExaminedFiles,
  extractNoSolutionReason,
  extractRootCauses,
  extractSolution,
  isTerminalStatus,
  type RootCause,
  requireAutofixRunId,
  TERMINAL_STATUSES,
} from "../../src/types/seer.js";

describe("isTerminalStatus", () => {
  test("returns true for COMPLETED status", () => {
    expect(isTerminalStatus("COMPLETED")).toBe(true);
  });

  test("returns true for ERROR status", () => {
    expect(isTerminalStatus("ERROR")).toBe(true);
  });

  test("returns true for CANCELLED status", () => {
    expect(isTerminalStatus("CANCELLED")).toBe(true);
  });

  test("returns false for PROCESSING status", () => {
    expect(isTerminalStatus("PROCESSING")).toBe(false);
  });

  test("returns false for WAITING_FOR_USER_RESPONSE status", () => {
    expect(isTerminalStatus("WAITING_FOR_USER_RESPONSE")).toBe(false);
  });

  test("returns false for unknown status", () => {
    expect(isTerminalStatus("UNKNOWN")).toBe(false);
  });

  test("TERMINAL_STATUSES contains expected values", () => {
    expect(TERMINAL_STATUSES).toContain("COMPLETED");
    expect(TERMINAL_STATUSES).toContain("ERROR");
    expect(TERMINAL_STATUSES).toContain("CANCELLED");
    expect(TERMINAL_STATUSES).not.toContain("PROCESSING");
  });
});

describe("requireAutofixRunId", () => {
  test("prefers sentry_run_id over legacy run_id", () => {
    const state: AutofixState = {
      sentry_run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      run_id: 123,
      status: "COMPLETED",
    };
    expect(requireAutofixRunId(state)).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  test("falls back to legacy run_id when sentry_run_id is absent", () => {
    const state: AutofixState = { run_id: 123, status: "COMPLETED" };
    expect(requireAutofixRunId(state)).toBe(123);
  });

  test("throws when neither field is present", () => {
    const state: AutofixState = { status: "COMPLETED" };
    expect(() => requireAutofixRunId(state)).toThrow(/missing both/);
  });
});

describe("extractRootCauses", () => {
  test("extracts causes from root_cause_analysis step", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "COMPLETED",
      steps: [
        {
          id: "step-1",
          key: "root_cause_analysis_processing",
          status: "COMPLETED",
          title: "Analyzing",
        },
        {
          id: "step-2",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause Analysis",
          causes: [
            {
              id: 0,
              description: "Database connection timeout",
              relevant_repos: ["org/repo"],
            },
            {
              id: 1,
              description: "Missing index on query",
            },
          ],
        },
      ],
    };

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(2);
    expect(causes[0]?.description).toBe("Database connection timeout");
    expect(causes[1]?.description).toBe("Missing index on query");
  });

  test("returns empty array when no steps", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "PROCESSING",
    };

    expect(extractRootCauses(state)).toEqual([]);
  });

  test("returns empty array when steps is empty", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "PROCESSING",
      steps: [],
    };

    expect(extractRootCauses(state)).toEqual([]);
  });

  test("returns empty array when no root_cause_analysis step", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "PROCESSING",
      steps: [
        {
          id: "step-1",
          key: "other_step",
          status: "COMPLETED",
          title: "Other Step",
        },
      ],
    };

    expect(extractRootCauses(state)).toEqual([]);
  });

  test("returns empty array when root_cause_analysis has no causes", () => {
    const state: AutofixState = {
      run_id: 123,
      status: "COMPLETED",
      steps: [
        {
          id: "step-1",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause Analysis",
        },
      ],
    };

    expect(extractRootCauses(state)).toEqual([]);
  });

  test("extracts causes from root_cause_analysis in blocks", () => {
    const state = {
      run_id: 456,
      status: "COMPLETED",
      blocks: [
        {
          key: "other_block",
          status: "COMPLETED",
        },
        {
          key: "root_cause_analysis",
          status: "COMPLETED",
          causes: [
            {
              id: 0,
              description: "Null pointer in request handler",
              relevant_repos: ["org/backend"],
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.description).toBe("Null pointer in request handler");
  });

  test("prefers blocks over steps when both contain root causes", () => {
    const state = {
      run_id: 789,
      status: "COMPLETED",
      blocks: [
        {
          key: "root_cause_analysis",
          status: "COMPLETED",
          causes: [{ id: 0, description: "From blocks" }],
        },
      ],
      steps: [
        {
          id: "step-1",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause Analysis",
          causes: [{ id: 0, description: "From steps" }],
        },
      ],
    } as unknown as AutofixState;

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.description).toBe("From blocks");
  });

  test("extracts root cause from agent artifact format", () => {
    const state = {
      run_id: 100,
      status: "COMPLETED",
      blocks: [
        {
          id: "block-1",
          message: { role: "assistant", content: "Analyzing..." },
          timestamp: "2025-01-01T00:00:00Z",
          artifacts: [
            {
              key: "root_cause",
              data: {
                one_line_description: "Null pointer in request handler",
                five_whys: ["Missing null check", "No input validation"],
                reproduction_steps: ["Send request without auth"],
                relevant_repo: "org/backend",
              },
              reason: "",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.description).toBe("Null pointer in request handler");
    expect(causes[0]?.relevant_repos).toEqual(["org/backend"]);
  });

  test("extracts root cause from agent artifact without relevant_repo", () => {
    const state = {
      run_id: 101,
      status: "COMPLETED",
      blocks: [
        {
          id: "block-1",
          message: { role: "assistant", content: "Done" },
          timestamp: "2025-01-01T00:00:00Z",
          artifacts: [
            {
              key: "root_cause",
              data: {
                one_line_description: "Configuration error",
                five_whys: ["Wrong default value"],
              },
              reason: "",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.description).toBe("Configuration error");
    expect(causes[0]?.relevant_repos).toBeUndefined();
  });

  test("falls through to agent artifacts when legacy causes array is empty", () => {
    const state = {
      run_id: 789,
      status: "COMPLETED",
      blocks: [
        {
          key: "root_cause_analysis",
          status: "COMPLETED",
          causes: [],
          artifacts: [],
        },
        {
          id: "block-2",
          message: { role: "assistant", content: "Found it" },
          timestamp: "2025-01-01T00:00:00Z",
          artifacts: [
            {
              key: "root_cause",
              data: {
                one_line_description: "Race condition in auth middleware",
                five_whys: ["Token refresh not atomic"],
                relevant_repo: "org/api-server",
              },
              reason: "",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const causes = extractRootCauses(state);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.description).toBe("Race condition in auth middleware");
    expect(causes[0]?.relevant_repos).toEqual(["org/api-server"]);
  });
});

describe("extractNoSolutionReason", () => {
  test("extracts reason from solution artifact in steps", () => {
    const state = {
      run_id: 1,
      status: "COMPLETED",
      steps: [
        {
          id: "s1",
          key: "plan",
          status: "COMPLETED",
          title: "Plan",
          artifacts: [
            {
              key: "solution",
              data: null,
              reason:
                "Root cause is infrastructure-level, no code fix identified",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBe(
      "Root cause is infrastructure-level, no code fix identified"
    );
  });

  test("extracts reason from solution artifact in blocks", () => {
    const state = {
      run_id: 1,
      status: "COMPLETED",
      blocks: [
        {
          artifacts: [
            {
              key: "solution",
              data: null,
              reason: "No actionable code change found",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBe(
      "No actionable code change found"
    );
  });

  test("returns undefined when no solution artifact exists", () => {
    const state: AutofixState = {
      run_id: 1,
      status: "COMPLETED",
      steps: [
        {
          id: "s1",
          key: "plan",
          status: "COMPLETED",
          title: "Plan",
        },
      ],
    };

    expect(extractNoSolutionReason(state)).toBeUndefined();
  });

  test("returns undefined when solution artifact has no reason", () => {
    const state = {
      run_id: 1,
      status: "COMPLETED",
      steps: [
        {
          id: "s1",
          key: "plan",
          status: "COMPLETED",
          title: "Plan",
          artifacts: [{ key: "solution", data: null }],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBeUndefined();
  });

  test("returns undefined when no steps or blocks", () => {
    const state: AutofixState = { run_id: 1, status: "COMPLETED" };
    expect(extractNoSolutionReason(state)).toBeUndefined();
  });

  test("extracts reason from step-level description when solution is empty", () => {
    const state = {
      run_id: 1,
      status: "NEED_MORE_INFORMATION",
      blocks: [
        {
          key: "solution",
          description:
            "Cannot produce a fix: the issue is in a third-party library",
          solution: [],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBe(
      "Cannot produce a fix: the issue is in a third-party library"
    );
  });

  test("extracts reason from step-level when solution field is missing", () => {
    const state = {
      run_id: 1,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          key: "solution",
          description: "Infrastructure-level issue, no code change applicable",
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBe(
      "Infrastructure-level issue, no code change applicable"
    );
  });

  test("prefers step-level reason over artifact-level reason", () => {
    const state = {
      run_id: 1,
      status: "COMPLETED",
      blocks: [
        {
          key: "solution",
          description: "Step-level reason",
          solution: [],
          artifacts: [
            { key: "solution", data: null, reason: "Artifact-level reason" },
          ],
        },
      ],
    } as unknown as AutofixState;

    expect(extractNoSolutionReason(state)).toBe("Step-level reason");
  });
});

describe("extractSolution", () => {
  test("extracts solution from step-level data in steps", () => {
    const state = {
      run_id: 1,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          id: "s1",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause",
        },
        {
          id: "s2",
          key: "solution",
          type: "solution",
          status: "COMPLETED",
          title: "Solution",
          description: "Fix the null pointer dereference in handler",
          solution: [
            {
              title: "Add null check before accessing property",
              code_snippet_and_analysis:
                "Check if `request.user` is defined before accessing `.id`",
              relevant_code_file: {
                file_path: "src/handler.ts",
                repo_name: "org/repo",
              },
            },
            {
              title: "Add fallback error response",
              code_snippet_and_analysis:
                "Return 401 when user is not authenticated",
              relevant_code_file: {
                file_path: null,
                repo_name: "org/repo",
              },
            },
          ],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("solution");
    expect(result!.data.one_line_summary).toBe(
      "Fix the null pointer dereference in handler"
    );
    expect(result!.data.steps).toHaveLength(2);
    expect(result!.data.steps[0]?.title).toBe(
      "Add null check before accessing property"
    );
    expect(result!.data.steps[0]?.description).toBe(
      "Check if `request.user` is defined before accessing `.id`"
    );
    expect(result!.data.steps[1]?.title).toBe("Add fallback error response");
    expect(result!.data.steps[1]?.description).toBe(
      "Return 401 when user is not authenticated"
    );
  });

  test("extracts solution from step-level data in blocks", () => {
    const state = {
      run_id: 2,
      status: "NEED_MORE_INFORMATION",
      blocks: [
        {
          key: "solution",
          description: "Update the config parser",
          solution: [
            {
              title: "Handle missing fields gracefully",
              code_snippet_and_analysis:
                "Add default values for optional fields",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.one_line_summary).toBe("Update the config parser");
    expect(result!.data.steps).toHaveLength(1);
    expect(result!.data.steps[0]?.title).toBe(
      "Handle missing fields gracefully"
    );
  });

  test("falls back to artifact-level solution when no step-level data", () => {
    const state = {
      run_id: 3,
      status: "COMPLETED",
      steps: [
        {
          id: "s1",
          key: "plan",
          status: "COMPLETED",
          title: "Plan",
          artifacts: [
            {
              key: "solution",
              data: {
                one_line_summary: "Fix from artifact",
                steps: [{ title: "Step A", description: "Do A" }],
              },
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.one_line_summary).toBe("Fix from artifact");
    expect(result!.data.steps).toHaveLength(1);
  });

  test("prefers step-level data over artifact-level in same container list", () => {
    const state = {
      run_id: 4,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          id: "s1",
          key: "plan",
          status: "COMPLETED",
          title: "Plan",
          artifacts: [
            {
              key: "solution",
              data: {
                one_line_summary: "From artifact",
                steps: [{ title: "Artifact step", description: "..." }],
              },
            },
          ],
        },
        {
          id: "s2",
          key: "solution",
          status: "COMPLETED",
          title: "Solution",
          description: "From step-level",
          solution: [
            {
              title: "Step-level fix",
              code_snippet_and_analysis: "Do the fix",
            },
          ],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.one_line_summary).toBe("From step-level");
  });

  test("returns null when no solution data exists", () => {
    const state: AutofixState = {
      run_id: 5,
      status: "PROCESSING",
      steps: [
        {
          id: "s1",
          key: "root_cause_analysis",
          status: "COMPLETED",
          title: "Root Cause",
        },
      ],
    };

    expect(extractSolution(state)).toBeNull();
  });

  test("returns null when no steps or blocks", () => {
    const state: AutofixState = { run_id: 6, status: "PROCESSING" };
    expect(extractSolution(state)).toBeNull();
  });

  test("handles step-level solution with empty solution array", () => {
    const state = {
      run_id: 7,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          id: "s1",
          key: "solution",
          status: "COMPLETED",
          title: "Solution",
          description: "Summary",
          solution: [],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    // Empty solution array should not match — no actionable steps
    expect(extractSolution(state)).toBeNull();
  });

  test("handles step-level solution without description", () => {
    const state = {
      run_id: 8,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          id: "s1",
          key: "solution",
          status: "COMPLETED",
          title: "Solution",
          solution: [
            {
              title: "Quick fix",
              code_snippet_and_analysis: "Apply patch",
            },
          ],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.one_line_summary).toBe("");
    expect(result!.data.steps[0]?.title).toBe("Quick fix");
  });

  test("handles solution item without code_snippet_and_analysis", () => {
    const state = {
      run_id: 9,
      status: "NEED_MORE_INFORMATION",
      steps: [
        {
          id: "s1",
          key: "solution",
          status: "COMPLETED",
          title: "Solution",
          description: "Summary",
          solution: [{ title: "Title only" }],
          artifacts: [],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.steps[0]?.description).toBe("");
  });

  test("extracts solution from agent artifact format in blocks", () => {
    const state = {
      run_id: 10,
      status: "COMPLETED",
      blocks: [
        {
          id: "block-1",
          message: { role: "assistant", content: "Here is the solution" },
          timestamp: "2025-01-01T00:00:00Z",
          artifacts: [
            {
              key: "solution",
              data: {
                one_line_summary: "Add null check before property access",
                steps: [
                  {
                    title: "Add guard clause",
                    description: "Check if user is defined before accessing id",
                  },
                  {
                    title: "Add error response",
                    description: "Return 401 for unauthenticated requests",
                  },
                ],
              },
              reason: "",
            },
          ],
        },
      ],
    } as unknown as AutofixState;

    const result = extractSolution(state);
    expect(result).not.toBeNull();
    expect(result!.data.one_line_summary).toBe(
      "Add null check before property access"
    );
    expect(result!.data.steps).toHaveLength(2);
    expect(result!.data.steps[0]?.title).toBe("Add guard clause");
  });
});

describe("extractExaminedFiles", () => {
  test("extracts file paths from reproduction steps", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "HTTP/1.1 overhead",
        root_cause_reproduction: [
          {
            title: "Step 1",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "src/mdx.ts",
              repo_name: "org/repo",
            },
          },
          {
            title: "Step 2",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "app/layout.tsx",
              repo_name: "org/repo",
            },
          },
        ],
      },
    ];

    const files = extractExaminedFiles(causes);
    expect(files).toEqual(["src/mdx.ts", "app/layout.tsx"]);
  });

  test("deduplicates file paths", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "Bug",
        root_cause_reproduction: [
          {
            title: "Step 1",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "src/index.ts",
              repo_name: "org/repo",
            },
          },
          {
            title: "Step 2",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "src/index.ts",
              repo_name: "org/repo",
            },
          },
        ],
      },
    ];

    expect(extractExaminedFiles(causes)).toEqual(["src/index.ts"]);
  });

  test("returns empty array when no reproduction steps", () => {
    const causes: RootCause[] = [{ id: 0, description: "Bug" }];

    expect(extractExaminedFiles(causes)).toEqual([]);
  });

  test("returns empty array for empty causes", () => {
    expect(extractExaminedFiles([])).toEqual([]);
  });

  test("skips steps without relevant_code_file", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "Bug",
        root_cause_reproduction: [
          {
            title: "Step 1",
            code_snippet_and_analysis: "...",
          },
          {
            title: "Step 2",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "src/app.ts",
              repo_name: "org/repo",
            },
          },
        ],
      },
    ];

    expect(extractExaminedFiles(causes)).toEqual(["src/app.ts"]);
  });

  test("filters out N/A sentinel values from file paths", () => {
    const causes: RootCause[] = [
      {
        id: 0,
        description: "Infrastructure issue",
        root_cause_reproduction: [
          {
            title: "Code step",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "app/layout.tsx",
              repo_name: "getsentry/sentry-docs",
            },
          },
          {
            title: "External system step",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "N/A",
              repo_name: "N/A",
            },
          },
          {
            title: "Another external step",
            code_snippet_and_analysis: "...",
            relevant_code_file: {
              file_path: "N/A",
              repo_name: "N/A",
            },
          },
        ],
      },
    ];

    expect(extractExaminedFiles(causes)).toEqual(["app/layout.tsx"]);
  });
});
