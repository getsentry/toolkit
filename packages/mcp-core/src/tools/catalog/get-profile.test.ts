import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, it, expect } from "vitest";
import getProfile from "./get-profile";

describe("get_profile", () => {
  it("marks profile analysis as open-world because it reads Sentry APIs", () => {
    expect(getProfile.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  describe("single period analysis", () => {
    it("analyzes a transaction profile", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "cloudflare-mcp",
          transactionName: "/api/users",
          period: "7d",
          focusOnUserCode: true,
          maxHotPaths: 5,
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
        "# Profile Analysis: /api/users

        ## Transaction Information
        - **Transaction**: /api/users
        - **Project ID**: 4509062593708032
        - **Platform**: python
        - **Total Profiles**: 1
        - **Total Samples**: 80
        - **Estimated Total Time**: 160ms

        ## Performance Summary

        ### Code Breakdown
        - **Total User Code Time**: 320ms (76.2%)
        - **Total Library Time**: 100ms (23.8%)

        ### Top Slow Functions

        | Function | File:Line | Samples | % Time | p75 | p95 | p99 | Insights |
        |----------|-----------|---------|--------|-----|-----|-----|----------|
        | \`handle_request\` | main.py:10 | 80 | 100.0% | 50ms | 80ms | 120ms |  |
        | \`fetch_data\` | utils.py:25 | 80 | 100.0% | 40ms | 70ms | 100ms |  |

        ## Top Hot Paths

        ### Path #1: 62.5% of execution time

        **50 samples** across 1 profiles

        \`\`\`
        main.py:handle_request:10 [YOUR CODE]
          utils.py:fetch_data:25 [YOUR CODE] ← PRIMARY BOTTLENECK
        \`\`\`

        **Performance Characteristics:**
        - **p75**: 50ms
        - **p95**: 90ms
        - **p99**: 200ms (⚠️ High variance - some calls are very slow)

        **💡 Recommendation:**
        This path accounts for 62.5% of CPU time. The high p99 indicates some operations are very slow.

        ---

        ### Path #2: 37.5% of execution time

        **30 samples** across 1 profiles

        \`\`\`
        main.py:handle_request:10 [YOUR CODE]
          utils.py:fetch_data:25 [YOUR CODE] ← PRIMARY BOTTLENECK
        \`\`\`

        **Performance Characteristics:**
        - **p75**: 40ms
        - **p95**: 70ms
        - **p99**: 100ms

        **💡 Recommendation:**
        This path accounts for 37.5% of CPU time.


        ## Actionable Next Steps

        ### Immediate Actions (High Impact)
        1. **Optimize \`fetch_data\` function** - Accounts for 62.5% of CPU time
        2. **Add caching layer** - Consider caching frequently accessed data
        3. **Review query patterns** - Look for N+1 queries or inefficient data access

        ### Investigation Actions
        1. **Compare with baseline**: Use get_profile with compareAgainstPeriod to check for regressions"
      `);
    });

    it("returns no data message for unknown transaction", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "cloudflare-mcp",
          transactionName: "/api/nonexistent",
          period: "7d",
          focusOnUserCode: true,
          maxHotPaths: 5,
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
        "# Profile Analysis: /api/nonexistent

        ## No Profile Data Found

        No profiling data found for transaction **/api/nonexistent** in the last 7d.

        **Possible reasons:**
        - Transaction name doesn't match exactly (names are case-sensitive)
        - No profiles collected for this transaction in the time period
        - Profiling may not be enabled for this project
        - Transaction may not have been executed recently

        **Suggestions:**
        - Verify the exact transaction name using search_traces
        - Try a longer time period (e.g., '30d')
        - Check if profiling is enabled for this project"
      `);
    });

    it("returns no data message when Sentry returns a sparse empty flamegraph", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/profiling/flamegraph/",
          () =>
            HttpResponse.json({
              metadata: {
                platform: "javascript",
                projectID: 4509062593708032,
                transactionName: "/api/sparse",
              },
            }),
          { once: true },
        ),
      );

      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: 4509062593708032,
          transactionName: "/api/sparse",
          period: "7d",
          focusOnUserCode: true,
          maxHotPaths: 5,
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

      expect(result).toContain("## No Profile Data Found");
      expect(result).toContain(
        "No profiling data found for transaction **/api/sparse** in the last 7d.",
      );
    });

    it("works with numeric project ID", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: 4509062593708032,
          transactionName: "/api/users",
          period: "7d",
          focusOnUserCode: true,
          maxHotPaths: 5,
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

      expect(result).toContain("# Profile Analysis: /api/users");
      expect(result).toContain("## Transaction Information");
    });
  });

  describe("comparison mode", () => {
    it("compares transaction profiles between periods", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "cloudflare-mcp",
          transactionName: "/api/users",
          period: "7d",
          compareAgainstPeriod: "14d",
          focusOnUserCode: true,
          maxHotPaths: 10,
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
        "# Profile Comparison: /api/users

        ## Summary
        - **Status**: ✅ No Significant Changes

        ## Key Changes

        | Function | File:Line | Baseline | Current | Change | Status |
        |----------|-----------|----------|---------|--------|--------|
        | \`handle_request\` | main.py:10 | 160ms | 160ms | 0.00% | ➖ |
        | \`fetch_data\` | utils.py:25 | 160ms | 160ms | 0.00% | ➖ |
        "
      `);
    });

    it("returns no data message when both periods have no data", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "cloudflare-mcp",
          transactionName: "/api/nonexistent",
          period: "7d",
          compareAgainstPeriod: "14d",
          focusOnUserCode: true,
          maxHotPaths: 10,
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
        "# Profile Comparison: /api/nonexistent

        ## No Profile Data Found

        No profiling data found for transaction **/api/nonexistent** in either time period.

        **Possible reasons:**
        - Transaction name doesn't match exactly (names are case-sensitive)
        - No profiles collected for this transaction
        - Profiling may not be enabled for this project

        **Suggestions:**
        - Verify the exact transaction name using search_traces
        - Check if profiling is enabled for this project"
      `);
    });

    it("includes library code when focusOnUserCode is false", async () => {
      const result = await getProfile.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "cloudflare-mcp",
          transactionName: "/api/users",
          period: "7d",
          compareAgainstPeriod: "7d",
          focusOnUserCode: false,
          maxHotPaths: 10,
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
        "# Profile Comparison: /api/users

        ## Summary
        - **Status**: ✅ No Significant Changes

        ## Key Changes

        | Function | File:Line | Baseline | Current | Change | Status |
        |----------|-----------|----------|---------|--------|--------|
        | \`handle_request\` | main.py:10 | 160ms | 160ms | 0.00% | ➖ |
        | \`fetch_data\` | utils.py:25 | 160ms | 160ms | 0.00% | ➖ |
        | \`execute\` | psycopg2/pool.py:100 | 100ms | 100ms | 0.00% | ➖ |
        "
      `);
    });
  });

  describe("parameter validation", () => {
    it("throws when organizationSlug is missing without profileUrl", async () => {
      await expect(
        getProfile.handler(
          {
            projectSlugOrId: "cloudflare-mcp",
            transactionName: "/api/users",
            period: "7d",
            focusOnUserCode: true,
            maxHotPaths: 5,
            regionUrl: null,
          },
          {
            constraints: {
              organizationSlug: null,
            },
            accessToken: "access-token",
            userId: "1",
          },
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[UserInputError: Organization slug is required. Provide either a profileUrl or organizationSlug parameter.]`,
      );
    });

    it("throws when transactionName is missing", async () => {
      await expect(
        getProfile.handler(
          {
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "cloudflare-mcp",
            period: "7d",
            focusOnUserCode: true,
            maxHotPaths: 5,
            regionUrl: null,
          },
          {
            constraints: {
              organizationSlug: null,
            },
            accessToken: "access-token",
            userId: "1",
          },
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[UserInputError: Transaction name is required for flamegraph analysis. Please provide a transactionName parameter.]`,
      );
    });

    it("throws when projectSlugOrId is missing", async () => {
      await expect(
        getProfile.handler(
          {
            organizationSlug: "sentry-mcp-evals",
            transactionName: "/api/users",
            period: "7d",
            focusOnUserCode: true,
            maxHotPaths: 5,
            regionUrl: null,
          },
          {
            constraints: {
              organizationSlug: null,
            },
            accessToken: "access-token",
            userId: "1",
          },
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[UserInputError: Project is required. Please provide a projectSlugOrId parameter or include it in the profile URL.]`,
      );
    });

    it("throws for invalid profile URL", async () => {
      await expect(
        getProfile.handler(
          {
            profileUrl: "https://sentry.io/issues/123",
            period: "7d",
            focusOnUserCode: true,
            maxHotPaths: 5,
            regionUrl: null,
          },
          {
            constraints: {
              organizationSlug: null,
            },
            accessToken: "access-token",
            userId: "1",
          },
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[UserInputError: Invalid profile URL. URL must be a Sentry profile URL (containing /profiling/profile/).]`,
      );
    });

    it("rejects profile URLs outside the active constrained session", async () => {
      await expect(
        getProfile.handler(
          {
            profileUrl:
              "https://other-org.sentry.io/explore/profiling/profile/frontend/flamegraph/?profilerId=abc123",
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "cloudflare-mcp",
            transactionName: "/api/users",
            period: "7d",
            focusOnUserCode: true,
            maxHotPaths: 5,
            regionUrl: null,
          },
          {
            constraints: {
              organizationSlug: null,
            },
            accessToken: "access-token",
            userId: "1",
          },
        ),
      ).rejects.toThrow(
        'Profile URL is outside the active organization constraint. Expected organization "sentry-mcp-evals" but got "other-org".',
      );
    });
  });
});
