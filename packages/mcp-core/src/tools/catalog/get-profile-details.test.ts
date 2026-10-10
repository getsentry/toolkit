import {
  mswServer,
  profileChunkFixture,
  transactionProfileV1MissingFunctionFixture,
  transactionProfileV1Fixture,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import getProfileDetails from "./get-profile-details";

const baseContext = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

describe("get_profile_details", () => {
  describe("handler", () => {
    it("fetches and formats a transaction profile from profileUrl", async () => {
      const result = await getProfileDetails.handler(
        {
          profileUrl: `https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      expect(result).toMatchInlineSnapshot(`
        "# Profile cfe78a5c892d4a64a962d837673398d2

        ## Summary
        - **Profile URL**: https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/
        - **Project**: backend
        - **Profile ID**: cfe78a5c892d4a64a962d837673398d2
        - **Transaction**: /api/users
        - **Trace ID**: a4d1aae7216b47ff8117cf4e09ce9d0a
        - **Trace URL**: https://sentry-mcp-evals.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a
        - **Duration**: 120ms
        - **Platform**: python
        - **Release**: backend@1.2.3
        - **Environment**: production
        - **Device**: MacBook Pro · high · arm64
        - **OS**: macOS 14.4
        - **SDK**: sentry.python 2.24.1
        - **Active Thread**: 1

        ## Sample Summary
        - **Total Frames**: 3
        - **Total Samples**: 3
        - **Total Stacks**: 2
        - **Threads**: 1

        ## Thread Information

        - **Thread 1**: MainThread (3 samples)

        ## Top Frames by Occurrence

        | Function | File:Line | Count | Type |
        |----------|-----------|-------|------|
        | \`handle_request\` | main.py:42 | 3 | User Code |
        | \`execute_query\` | db.py:118 | 2 | User Code |

        ## Next Steps

        - Open the profile URL above in Sentry for the full flamegraph
        - Open the related trace URL to inspect the end-to-end request
        - Use \`search_profiles\` to find similar profiles"
      `);
    });

    it("fetches a transaction profile from direct parameters", async () => {
      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "backend",
          profileId: transactionProfileV1Fixture.profile_id,
          regionUrl: null,
          focusOnUserCode: false,
        },
        baseContext,
      );

      expect(result).toContain(
        `# Profile ${transactionProfileV1Fixture.profile_id}`,
      );
      expect(result).toContain("**Project**: backend");
      expect(result).toContain("cursor.execute");
    });

    it("formats transaction profiles even when frames omit function names", async () => {
      mswServer.use(
        http.get(
          `https://sentry.io/api/0/projects/sentry-mcp-evals/backend/profiling/profiles/${transactionProfileV1Fixture.profile_id}/`,
          () => HttpResponse.json(transactionProfileV1MissingFunctionFixture),
          { once: true },
        ),
        http.get(
          `https://us.sentry.io/api/0/projects/sentry-mcp-evals/backend/profiling/profiles/${transactionProfileV1Fixture.profile_id}/`,
          () => HttpResponse.json(transactionProfileV1MissingFunctionFixture),
          { once: true },
        ),
      );

      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "backend",
          profileId: transactionProfileV1Fixture.profile_id,
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      expect(result).toContain("## Top Frames by Occurrence");
      expect(result).toContain("| `unknown` | main.py:42 | 3 | User Code |");
    });

    it("fetches a transaction profile from a numeric project ID", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/projects/sentry-mcp-evals/12345/",
          () =>
            HttpResponse.json({ id: 12345, slug: "backend", name: "Backend" }),
          { once: true },
        ),
        http.get(
          "https://us.sentry.io/api/0/projects/sentry-mcp-evals/12345/",
          () =>
            HttpResponse.json({ id: 12345, slug: "backend", name: "Backend" }),
          { once: true },
        ),
      );

      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: 12345,
          profileId: transactionProfileV1Fixture.profile_id,
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      expect(result).toContain(
        `# Profile ${transactionProfileV1Fixture.profile_id}`,
      );
      expect(result).toContain("**Project**: backend");
      expect(result).toContain(
        `https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
      );
    });

    it("fetches and formats a continuous profile chunk", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/projects/sentry-mcp-evals/backend/",
          () =>
            HttpResponse.json({ id: 12345, slug: "backend", name: "Backend" }),
          { once: true },
        ),
      );

      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "backend",
          profilerId: "041bde57b9844e36b8b7e5734efae5f7",
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-01T01:00:00Z",
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      expect(result).toContain(
        "# Continuous Profile 041bde57b9844e36b8b7e5734efae5f7",
      );
      expect(result).toContain("## Summary");
      expect(result).toContain("## Raw Sample Analysis");
      expect(result).toContain("## Top Frames by Occurrence");
    });

    it("copies profilerId from the request when the chunk payload omits it", async () => {
      const chunk = {
        ...structuredClone(profileChunkFixture.chunk),
        profiler_id: undefined,
      };

      mswServer.use(
        http.get(
          "https://sentry.io/api/0/projects/sentry-mcp-evals/backend/",
          () =>
            HttpResponse.json({ id: 12345, slug: "backend", name: "Backend" }),
          { once: true },
        ),
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/profiling/chunks/",
          () => HttpResponse.json({ chunk }),
          { once: true },
        ),
      );

      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "backend",
          profilerId: "041bde57b9844e36b8b7e5734efae5f7",
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-01T01:00:00Z",
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      expect(result).toContain(
        "- **Profiler ID**: 041bde57b9844e36b8b7e5734efae5f7",
      );
    });

    it("rejects incomplete continuous profile URLs", async () => {
      await expect(
        getProfileDetails.handler(
          {
            profileUrl:
              "https://my-org.sentry.io/profiling/profile/backend/flamegraph/?profilerId=041bde57b9844e36b8b7e5734efae5f7",
            regionUrl: null,
            focusOnUserCode: true,
          },
          baseContext,
        ),
      ).rejects.toThrow(
        "Continuous profile URLs must include `profilerId`, `start`, and `end` query parameters.",
      );
    });

    it("rejects profile URLs outside the active organization constraint", async () => {
      await expect(
        getProfileDetails.handler(
          {
            profileUrl: `https://other-org.sentry.io/explore/profiling/profile/backend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "backend",
            regionUrl: null,
            focusOnUserCode: true,
          },
          baseContext,
        ),
      ).rejects.toThrow(
        'Profile URL is outside the active organization constraint. Expected organization "sentry-mcp-evals" but got "other-org".',
      );
    });

    it("rejects profile URLs outside the active project constraint", async () => {
      await expect(
        getProfileDetails.handler(
          {
            profileUrl: `https://sentry-mcp-evals.sentry.io/explore/profiling/profile/frontend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "backend",
            regionUrl: null,
            focusOnUserCode: true,
          },
          baseContext,
        ),
      ).rejects.toThrow(
        'Profile URL is outside the active project constraint. Expected project "backend" but got "frontend".',
      );
    });
  });

  describe("tool definition", () => {
    it("has read-only annotation", () => {
      expect(getProfileDetails.annotations.readOnlyHint).toBe(true);
    });

    it("belongs to inspect skill", () => {
      expect(getProfileDetails.skills).toContain("inspect");
    });

    it("requires profiles capability", () => {
      expect(getProfileDetails.requiredCapabilities).toContain("profiles");
    });

    it("has expected params", () => {
      const schemaKeys = Object.keys(getProfileDetails.inputSchema);
      expect(schemaKeys).toEqual([
        "profileUrl",
        "organizationSlug",
        "regionUrl",
        "projectSlugOrId",
        "profileId",
        "profilerId",
        "start",
        "end",
        "focusOnUserCode",
      ]);
    });
  });
});
