import { flamegraphFixture, mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, it, expect } from "vitest";
import { getProfileOutputSchema } from "../support/profile/flamegraph-output";
import getProfile from "./get-profile";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "analysis": {
            "estimatedTotalMs": 160,
            "frames": [
              {
                "file": "main.py",
                "insights": [],
                "isApplication": true,
                "line": 10,
                "name": "handle_request",
                "occurrences": 80,
                "p75Ms": 50,
                "p95Ms": 80,
                "p99Ms": 120,
              },
              {
                "file": "utils.py",
                "insights": [],
                "isApplication": true,
                "line": 25,
                "name": "fetch_data",
                "occurrences": 80,
                "p75Ms": 40,
                "p95Ms": 70,
                "p99Ms": 100,
              },
              {
                "file": "psycopg2/pool.py",
                "insights": [
                  "high_variance",
                ],
                "isApplication": false,
                "line": 100,
                "name": "execute",
                "occurrences": 50,
                "p75Ms": 50,
                "p95Ms": 90,
                "p99Ms": 200,
              },
            ],
            "hotPaths": [
              {
                "leaf": 2,
                "percentOfSamples": 62.5,
                "sampleCount": 50,
                "stack": [
                  0,
                  1,
                ],
              },
              {
                "leaf": 1,
                "percentOfSamples": 37.5,
                "sampleCount": 30,
                "stack": [
                  0,
                  1,
                ],
              },
            ],
            "libraryMs": 100,
            "platform": "python",
            "profileCount": 1,
            "sampleCount": 80,
            "topFunctions": [
              0,
              1,
            ],
            "userCodeMs": 60,
            "userCodePercent": 37.5,
          },
          "baselinePeriod": null,
          "comparison": null,
          "focusOnUserCode": true,
          "hasBaselineData": null,
          "hasCurrentData": true,
          "period": "7d",
          "projectId": "4509109104082945",
          "transactionName": "/api/users",
        }
      `);
    });

    it("returns no analysis for an unknown transaction", async () => {
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "analysis": null,
          "baselinePeriod": null,
          "comparison": null,
          "focusOnUserCode": true,
          "hasBaselineData": null,
          "hasCurrentData": false,
          "period": "7d",
          "projectId": "4509109104082945",
          "transactionName": "/api/nonexistent",
        }
      `);
    });

    it("returns no analysis when Sentry returns a sparse empty flamegraph", async () => {
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchObject({
        transactionName: "/api/sparse",
        hasCurrentData: false,
        analysis: null,
      });
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.projectId).toBe("4509062593708032");
      expect(result.structuredContent.analysis?.hotPaths).toHaveLength(2);
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "analysis": null,
          "baselinePeriod": "14d",
          "comparison": {
            "changes": [
              {
                "baselineMs": 160,
                "changeType": "no_change",
                "currentMs": 160,
                "file": "main.py",
                "isApplication": true,
                "line": 10,
                "name": "handle_request",
                "percentChange": 0,
              },
              {
                "baselineMs": 160,
                "changeType": "no_change",
                "currentMs": 160,
                "file": "utils.py",
                "isApplication": true,
                "line": 25,
                "name": "fetch_data",
                "percentChange": 0,
              },
            ],
            "status": "no_change",
          },
          "focusOnUserCode": true,
          "hasBaselineData": true,
          "hasCurrentData": true,
          "period": "7d",
          "projectId": "4509109104082945",
          "transactionName": "/api/users",
        }
      `);
    });

    it("returns no comparison when both periods have no data", async () => {
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "analysis": null,
          "baselinePeriod": "14d",
          "comparison": null,
          "focusOnUserCode": true,
          "hasBaselineData": false,
          "hasCurrentData": false,
          "period": "7d",
          "projectId": "4509109104082945",
          "transactionName": "/api/nonexistent",
        }
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

      getProfileOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "analysis": null,
          "baselinePeriod": "7d",
          "comparison": {
            "changes": [
              {
                "baselineMs": 160,
                "changeType": "no_change",
                "currentMs": 160,
                "file": "main.py",
                "isApplication": true,
                "line": 10,
                "name": "handle_request",
                "percentChange": 0,
              },
              {
                "baselineMs": 160,
                "changeType": "no_change",
                "currentMs": 160,
                "file": "utils.py",
                "isApplication": true,
                "line": 25,
                "name": "fetch_data",
                "percentChange": 0,
              },
              {
                "baselineMs": 100,
                "changeType": "no_change",
                "currentMs": 100,
                "file": "psycopg2/pool.py",
                "isApplication": false,
                "line": 100,
                "name": "execute",
                "percentChange": 0,
              },
            ],
            "status": "no_change",
          },
          "focusOnUserCode": false,
          "hasBaselineData": true,
          "hasCurrentData": true,
          "period": "7d",
          "projectId": "4509109104082945",
          "transactionName": "/api/users",
        }
      `);
    });
  });

  it("maps flamegraph fields without leaking raw API data", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/profiling/flamegraph/",
        () =>
          HttpResponse.json({
            ...flamegraphFixture,
            backendOnly: "must-not-leak-root",
            shared: {
              ...flamegraphFixture.shared,
              frames: flamegraphFixture.shared.frames.map(
                (frame: Record<string, unknown>) => ({
                  ...frame,
                  image: "must-not-leak-image",
                  internalFrameId: "must-not-leak-frame",
                }),
              ),
            },
          }),
        { once: true },
      ),
    );

    const result = await getProfile.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlugOrId: "cloudflare-mcp",
        transactionName: "/api/users",
        period: "7d",
        focusOnUserCode: false,
        maxHotPaths: 5,
        regionUrl: null,
      },
      context,
    );

    getProfileOutputSchema.parse(result.structuredContent);
    const serialized = JSON.stringify(result.structuredContent);
    for (const key of [
      "backendOnly",
      "image",
      "internalFrameId",
      "fingerprint",
      "is_application",
      "frame_infos",
      "profile_id",
      "sumSelfTime",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("profile-abc123");
  });

  it("reports which comparison period is missing data", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/profiling/flamegraph/",
        ({ request }) => {
          const statsPeriod = new URL(request.url).searchParams.get(
            "statsPeriod",
          );
          return HttpResponse.json(
            statsPeriod === "14d"
              ? { ...flamegraphFixture, profiles: [] }
              : flamegraphFixture,
          );
        },
      ),
    );

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
      context,
    );

    getProfileOutputSchema.parse(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      baselinePeriod: "14d",
      hasCurrentData: true,
      hasBaselineData: false,
      analysis: null,
      comparison: null,
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
