import {
  autofixStateFixture,
  createRegressedIssue,
  createUnsupportedIssue,
  mswServer,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorForUser } from "../../internal/error-handling.js";
import analyzeIssueWithSeer from "./analyze-issue-with-seer.js";

describe("analyze_issue_with_seer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/",
        ({ params }) =>
          HttpResponse.json(
            createUnsupportedIssue({
              shortId: String(params.issueId),
            }),
          ),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("handles combined workflow", async () => {
    // This test validates the tool works correctly
    // In a real scenario, it would poll multiple times, but for testing
    // we'll validate the key outputs are present
    const result = await analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-45",
        issueUrl: undefined,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("# Seer Analysis for Issue CLOUDFLARE-MCP-45");
    expect(result).toContain("Found existing analysis (Run ID: 13)");
    expect(result).toContain("## Analysis Complete");
    expect(result).toContain('<seer_analysis run_id="13" step="root_cause">');
    expect(result).toContain("The analysis has completed successfully.");
  });

  it("wraps completed Seer-authored sections with provenance tags", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-TAGS/autofix/",
        () =>
          HttpResponse.json({
            autofix: {
              run_id: 4242,
              status: "completed",
              updated_at: "2025-04-09T22:39:50.778146",
              blocks: [
                {
                  id: "block-1",
                  artifacts: [
                    {
                      key: "root_cause",
                      reason: "Root cause analysis completed",
                      data: {
                        one_line_description:
                          "The request used the wrong bottle ID.",
                        five_whys: [
                          "The bottle lookup threw after receiving ID 3216.",
                        ],
                        reproduction_steps: [],
                      },
                    },
                  ],
                },
                {
                  id: "block-2",
                  artifacts: [
                    {
                      key: "solution",
                      reason: "Solution plan completed",
                      data: {
                        one_line_summary:
                          "Use the canonical bottle ID for both batched calls.",
                        steps: [
                          {
                            title: "Share canonical ID",
                            description: "Pass the same ID to both procedures.",
                          },
                          {
                            title: "Add regression coverage",
                            description:
                              "Test the batched request with mismatched IDs.",
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          }),
      ),
    );

    const result = await analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-TAGS",
        issueUrl: undefined,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(typeof result).toBe("string");
    if (typeof result !== "string") {
      throw new Error("Expected analyze_issue_with_seer to return text output");
    }

    expect(result.trim()).toMatchInlineSnapshot(`
      "# Seer Analysis for Issue CLOUDFLARE-MCP-TAGS

      Found existing analysis (Run ID: 4242)

      ## Analysis Complete

      <seer_analysis run_id="4242" step="root_cause">
      ## Root Cause Analysis

      The request used the wrong bottle ID.

      1. The bottle lookup threw after receiving ID 3216.
      </seer_analysis>

      <seer_analysis run_id="4242" step="solution">
      ## Proposed Solution

      Use the canonical bottle ID for both batched calls.

      - **Share canonical ID**: Pass the same ID to both procedures.
      - **Add regression coverage**: Test the batched request with mismatched IDs.
      </seer_analysis>"
    `);
    expect(result).not.toContain("null");
  });

  it("handles network errors with retry", async () => {
    let attempts = 0;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-99/autofix/",
        () => {
          attempts++;
          if (attempts < 3) {
            // Simulate network error for first 2 attempts
            return HttpResponse.error();
          }
          // Success on third attempt
          return HttpResponse.json(autofixStateFixture);
        },
      ),
    );

    const promise = analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-99",
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Fast-forward through retries
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(attempts).toBe(3);
    expect(result).toContain("# Seer Analysis for Issue CLOUDFLARE-MCP-99");
    expect(result).toContain("Found existing analysis");
  });

  it("handles 500 errors with retry", async () => {
    let attempts = 0;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-500/autofix/",
        () => {
          attempts++;
          if (attempts < 2) {
            // Simulate server error for first attempt
            return HttpResponse.json(
              { detail: "Internal Server Error" },
              { status: 500 },
            );
          }
          // Success on second attempt
          return HttpResponse.json(autofixStateFixture);
        },
      ),
    );

    const promise = analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-500",
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Fast-forward through retries
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(attempts).toBe(2);
    expect(result).toContain("# Seer Analysis for Issue CLOUDFLARE-MCP-500");
  });

  it.skip("handles polling with transient errors", async () => {
    // This test is skipped because it's difficult to reliably trigger the error message
    // The functionality is covered by the error recovery logic in the retry tests
  });

  it("handles polling timeout", async () => {
    const inProgressState = {
      ...autofixStateFixture,
      autofix: {
        ...autofixStateFixture.autofix,
        status: "processing",
        blocks: [
          {
            id: "block-1",
            artifacts: [],
            todos: [{ content: "Analyzing the issue", status: "in_progress" }],
          },
        ],
      },
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-TIMEOUT/autofix/",
        () => {
          // Always return in progress
          return HttpResponse.json(inProgressState);
        },
      ),
    );

    const promise = analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-TIMEOUT",
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Fast-forward past timeout
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // 6 minutes

    const result = await promise;

    expect(result).toContain("## Analysis Timed Out");
    expect(result).toContain(
      "The analysis is taking longer than expected (>300s)",
    );
    expect(result).toContain("Processing: Analyzing the issue...");
  });

  it("handles consecutive polling errors", async () => {
    let pollAttempts = 0;
    const inProgressState = {
      ...autofixStateFixture,
      autofix: {
        ...autofixStateFixture.autofix,
        status: "processing",
      },
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-ERRORS/autofix/",
        () => {
          pollAttempts++;
          if (pollAttempts === 1) {
            // First call returns in progress
            return HttpResponse.json(inProgressState);
          }
          // All subsequent calls fail
          return HttpResponse.error();
        },
      ),
    );

    const promise = analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        instruction: undefined,
        issueId: "CLOUDFLARE-MCP-ERRORS",
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Fast-forward through polling intervals
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    const result = await promise;

    expect(result).toContain("## Error During Analysis");
    expect(result).toContain(
      "Unable to retrieve analysis status after multiple attempts",
    );
    expect(result).toContain(
      "You can check the status later by running the same command again",
    );
  });

  async function startNewAnalysis(instruction: string | undefined) {
    let getCallCount = 0;
    let requestBody: unknown;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-NEW/autofix/",
        () => {
          getCallCount++;
          if (getCallCount === 1) {
            // First call - no existing autofix
            return HttpResponse.json({ autofix: null });
          }
          // Subsequent calls - return completed state
          return HttpResponse.json(autofixStateFixture);
        },
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-NEW/autofix/",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            run_id: 123,
          });
        },
      ),
    );

    const promise = analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-NEW",
        instruction,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Fast-forward through initial delay and polling
    await vi.runAllTimersAsync();

    const result = await promise;
    return { result, requestBody };
  }

  it("sends the instruction to Seer as user_context", async () => {
    const { result, requestBody } = await startNewAnalysis(
      "Focus on memory leaks",
    );

    expect(requestBody).toEqual({ user_context: "Focus on memory leaks" });
    expect(result).toContain("Starting new analysis...");
    expect(result).toContain("Analysis started with Run ID: 123");
    expect(result).toContain("## Analysis Complete");
  });

  it.each([undefined, ""])(
    "omits user_context when the instruction is %j",
    async (instruction) => {
      const { requestBody } = await startNewAnalysis(instruction);

      expect(requestBody).toEqual({});
    },
  );

  it.each([
    [
      "out of credits",
      {
        detail:
          "Your organization does not have enough credits to start an Autofix run.",
        code: "seer_out_of_credits",
      },
      "Your organization does not have enough credits to start an Autofix run. Someone with billing access can adjust Seer spend and auto-reload in Sentry.",
    ],
    [
      "out of quota",
      { detail: "No budget for Seer Autofix.", code: "seer_out_of_quota" },
      "Your organization does not have enough Seer quota to start an Autofix run.",
    ],
    [
      "out of quota, older Sentry without a code",
      "No budget for Seer Autofix.",
      "Your organization does not have enough Seer quota to start an Autofix run.",
    ],
  ])(
    "explains why the run did not start when Sentry answers 402 (%s)",
    async (_label, body, expected) => {
      let getCallCount = 0;

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-402/autofix/",
          () => {
            getCallCount++;
            return HttpResponse.json({ autofix: null });
          },
        ),
        http.post(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-402/autofix/",
          () => HttpResponse.json(body, { status: 402 }),
        ),
      );

      const result = await analyzeIssueWithSeer.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-402",
          instruction: undefined,
        },
        {
          constraints: { organizationSlug: undefined },
          accessToken: "access-token",
          userId: "1",
        },
      );

      expect(result).toBe(
        `# Seer Analysis for Issue CLOUDFLARE-MCP-402\n\n## Analysis Not Started\n\n${expected}\n`,
      );
      // No polling after a refused start.
      expect(getCallCount).toBe(1);
    },
  );

  it("names the accepted scopes when Sentry refuses the start for a missing scope", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-403/autofix/",
        () => HttpResponse.json({ autofix: null }),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-403/autofix/",
        () =>
          HttpResponse.json(
            { detail: "You do not have permission to perform this action." },
            {
              status: 403,
              headers: {
                "WWW-Authenticate":
                  'Bearer error="insufficient_scope", scope="event:admin event:write seer:write"',
              },
            },
          ),
      ),
    );

    const error = await analyzeIssueWithSeer
      .handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-403",
          instruction: undefined,
        },
        {
          constraints: { organizationSlug: undefined },
          accessToken: "access-token",
          userId: "1",
        },
      )
      .catch((e: unknown) => e);

    expect(await formatErrorForUser(error, { transport: "http" })).toBe(
      [
        "**Missing Permission**",
        "API error (403): You do not have permission to perform this action. The access token is missing the scope this endpoint requires; it needs one of: event:admin, event:write, seer:write. Retrying with the same token will not help.",
        "Reconnect Sentry with a token or authorization that includes one of these scopes, then try again.",
      ].join("\n\n"),
    );
  });

  it("explains a run that stopped because the org ran out of credits", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-CREDITS/autofix/",
        () =>
          HttpResponse.json({
            autofix: {
              run_id: 456,
              status: "error",
              failure_reason: "out_of_credits",
              blocks: [],
            },
          }),
      ),
    );

    const result = await analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-CREDITS",
        instruction: undefined,
      },
      {
        constraints: { organizationSlug: undefined },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(result).toContain("## Analysis Failed");
    expect(result).toContain(
      "Your organization does not have enough credits to continue your Autofix run. Someone with billing access can adjust Seer spend and auto-reload in Sentry.",
    );
  });

  it("returns unsupported message for metric issues without calling Seer", async () => {
    let autofixRequests = 0;

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/MCP-SERVER-EQE/",
        () => HttpResponse.json(createRegressedIssue()),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/MCP-SERVER-EQE/autofix/",
        () => {
          autofixRequests++;
          return HttpResponse.json({ autofix: null });
        },
      ),
    );

    const result = await analyzeIssueWithSeer.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "MCP-SERVER-EQE",
        instruction: undefined,
      },
      {
        constraints: {
          organizationSlug: undefined,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(autofixRequests).toBe(0);
    expect(result).toContain("Seer Analysis Not Available");
    expect(result).toContain("metric");
    expect(result).toContain("search_metrics");
  });

  it("rejects issues outside the active project constraint", async () => {
    await expect(
      analyzeIssueWithSeer.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-41",
          instruction: undefined,
        },
        {
          constraints: {
            organizationSlug: undefined,
            projectSlug: "frontend",
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow(
      'Issue is outside the active project constraint. Expected project "frontend".',
    );
  });
});
