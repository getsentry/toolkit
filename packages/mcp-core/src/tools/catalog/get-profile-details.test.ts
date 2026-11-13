import {
  mswServer,
  profileChunkFixture,
  transactionProfileV1MissingFunctionFixture,
  transactionProfileV1Fixture,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getProfileDetailsOutputSchema } from "../support/profile/details-output";
import getProfileDetails from "./get-profile-details";

const baseContext = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const LEGACY_PROFILE_ID = "ae9108da5e274c6684f9c4e727cd18a3";

function legacyProfileBody() {
  return {
    activeProfileIndex: 0,
    durationNS: 1500000000,
    metadata: {
      deviceManufacturer: "samsung",
      deviceModel: "SM-S918N",
      deviceOSName: "android",
      deviceOSVersion: "14",
      environment: "production",
      traceID: "18cd3a3d8eae46e5be7337e1e1845d62",
      transactionName: "MainActivity",
      version: "1",
    },
    platform: "android",
    profileID: LEGACY_PROFILE_ID,
    profiles: [{ type: "evented", events: [] }],
    projectID: 1,
    shared: { frames: [] },
    transactionName: "MainActivity",
    metrics: null,
  };
}

function mockLegacyProfile(body: Record<string, unknown>) {
  for (const host of ["sentry.io", "us.sentry.io"]) {
    mswServer.use(
      http.get(
        `https://${host}/api/0/projects/sentry-mcp-evals/backend/profiling/profiles/${LEGACY_PROFILE_ID}/`,
        () => HttpResponse.json(body),
        { once: true },
      ),
    );
  }
}

const legacyProfileParams = {
  organizationSlug: "sentry-mcp-evals",
  projectSlugOrId: "backend",
  profileId: LEGACY_PROFILE_ID,
  regionUrl: null,
  focusOnUserCode: true,
};

describe("get_profile_details", () => {
  describe("handler", () => {
    it("fetches a transaction profile from profileUrl", async () => {
      const result = await getProfileDetails.handler(
        {
          profileUrl: `https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "profile": {
            "activeThreadId": "1",
            "device": "MacBook Pro · high · arm64",
            "durationMs": 120,
            "environment": "production",
            "os": "macOS 14.4",
            "platform": "python",
            "profileId": "cfe78a5c892d4a64a962d837673398d2",
            "profileType": "transaction",
            "profileUrl": "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
            "project": "backend",
            "release": "backend@1.2.3",
            "sdk": "sentry.python 2.24.1",
            "traceId": "a4d1aae7216b47ff8117cf4e09ce9d0a",
            "traceUrl": "https://sentry-mcp-evals.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a",
            "transactionName": "/api/users",
          },
          "samples": {
            "frameCount": 3,
            "sampleCount": 3,
            "stackCount": 2,
            "threads": [
              {
                "id": "1",
                "name": "MainThread",
                "sampleCount": 3,
              },
            ],
            "topFrames": [
              {
                "count": 3,
                "function": "handle_request",
                "isApplication": true,
                "location": "main.py:42",
              },
              {
                "count": 2,
                "function": "execute_query",
                "isApplication": true,
                "location": "db.py:118",
              },
            ],
          },
          "suggestedActions": [],
        }
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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.profile).toMatchObject({
        profileType: "transaction",
        profileId: transactionProfileV1Fixture.profile_id,
        project: "backend",
      });
      expect(JSON.stringify(result.structuredContent)).toContain(
        "cursor.execute",
      );
    });

    it("maps transaction profiles even when frames omit function names", async () => {
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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchObject({
        samples: {
          topFrames: expect.arrayContaining([
            {
              function: null,
              location: "main.py:42",
              isApplication: true,
              count: 3,
            },
          ]),
        },
      });
    });

    it("summarizes legacy speedscope transaction profiles", async () => {
      mockLegacyProfile(legacyProfileBody());

      const result = await getProfileDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlugOrId: "backend",
          profileId: LEGACY_PROFILE_ID,
          regionUrl: null,
          focusOnUserCode: true,
        },
        baseContext,
      );

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "profile": {
            "device": "samsung SM-S918N",
            "durationMs": 1500,
            "environment": "production",
            "os": "android 14",
            "platform": "android",
            "profileId": "ae9108da5e274c6684f9c4e727cd18a3",
            "profileType": "legacy",
            "profileUrl": "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/ae9108da5e274c6684f9c4e727cd18a3/flamegraph/",
            "project": "backend",
            "traceId": "18cd3a3d8eae46e5be7337e1e1845d62",
            "traceUrl": "https://sentry-mcp-evals.sentry.io/explore/traces/trace/18cd3a3d8eae46e5be7337e1e1845d62",
            "transactionName": "MainActivity",
          },
          "samples": null,
          "suggestedActions": [
            {
              "arguments": {
                "organizationSlug": "sentry-mcp-evals",
                "projectSlugOrId": "backend",
                "regionUrl": "https://us.sentry.io",
                "transactionName": "MainActivity",
              },
              "reason": "Legacy profiles have no sample data; the aggregated transaction flamegraph shows hot paths.",
              "toolName": "get_profile",
              "type": "tool_call",
            },
          ],
        }
      `);
    });

    it("omits the get_profile suggestion when it is unavailable", async () => {
      mockLegacyProfile(legacyProfileBody());

      const result = await getProfileDetails.handler(legacyProfileParams, {
        ...baseContext,
        availableToolNames: new Set(["get_profile_details"]),
      });

      expect(result.structuredContent.suggestedActions).toEqual([]);
    });

    it("passes the resolved regionUrl to the get_profile suggestion", async () => {
      mockLegacyProfile(legacyProfileBody());

      // regionUrl is null in the params; the handler resolves it from the
      // organization, and get_profile only reads params.regionUrl.
      const result = await getProfileDetails.handler(
        legacyProfileParams,
        baseContext,
      );

      expect(result.structuredContent.suggestedActions).toEqual([
        expect.objectContaining({
          toolName: "get_profile",
          arguments: {
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "backend",
            transactionName: "MainActivity",
            regionUrl: "https://us.sentry.io",
          },
        }),
      ]);
    });

    it("wraps the get_profile suggestion when it is only in the catalog", async () => {
      mockLegacyProfile(legacyProfileBody());

      const result = await getProfileDetails.handler(legacyProfileParams, {
        ...baseContext,
        availableToolNames: new Set([
          "get_profile_details",
          "get_profile",
          "execute_sentry_tool",
        ]),
        directToolNames: new Set([
          "get_profile_details",
          "execute_sentry_tool",
        ]),
      });

      expect(result.structuredContent.suggestedActions).toEqual([
        {
          type: "tool_call",
          toolName: "execute_sentry_tool",
          arguments: {
            name: "get_profile",
            arguments: {
              organizationSlug: "sentry-mcp-evals",
              projectSlugOrId: "backend",
              transactionName: "MainActivity",
              regionUrl: "https://us.sentry.io",
            },
          },
          reason:
            "Legacy profiles have no sample data; the aggregated transaction flamegraph shows hot paths.",
        },
      ]);
    });

    it("omits the get_profile suggestion without a transaction name", async () => {
      const body = legacyProfileBody();
      mockLegacyProfile({
        ...body,
        transactionName: undefined,
        metadata: { ...body.metadata, transactionName: undefined },
      });

      const result = await getProfileDetails.handler(
        legacyProfileParams,
        baseContext,
      );

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.suggestedActions).toEqual([]);
    });

    it("maps legacy profile fields without leaking raw speedscope data", async () => {
      mockLegacyProfile({
        ...legacyProfileBody(),
        profiles: [
          {
            type: "evented",
            name: "must-not-leak-thread",
            events: [{ type: "O", frame: 0, at: 0 }],
          },
        ],
        shared: { frames: [{ name: "must-not-leak-frame" }] },
        activeProfileIndex: 7,
      });

      const result = await getProfileDetails.handler(
        legacyProfileParams,
        baseContext,
      );

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      const serialized = JSON.stringify(result.structuredContent);
      for (const key of [
        "profiles",
        "shared",
        "frames",
        "events",
        "activeProfileIndex",
        "durationNS",
        "metadata",
        "projectID",
        "deviceManufacturer",
      ]) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      expect(serialized).not.toContain("must-not-leak");
    });

    it("still rejects sample-format profiles without profile data", async () => {
      const malformedProfileId = "be9108da5e274c6684f9c4e727cd18a3";
      for (const host of ["sentry.io", "us.sentry.io"]) {
        mswServer.use(
          http.get(
            `https://${host}/api/0/projects/sentry-mcp-evals/backend/profiling/profiles/${malformedProfileId}/`,
            () =>
              HttpResponse.json({
                profile_id: malformedProfileId,
                platform: "python",
              }),
            { once: true },
          ),
        );
      }

      await expect(
        getProfileDetails.handler(
          {
            organizationSlug: "sentry-mcp-evals",
            projectSlugOrId: "backend",
            profileId: malformedProfileId,
            regionUrl: null,
            focusOnUserCode: true,
          },
          baseContext,
        ),
      ).rejects.toThrow("profile:");
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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.profile).toMatchObject({
        profileType: "transaction",
        project: "backend",
        profileUrl: `https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/${transactionProfileV1Fixture.profile_id}/flamegraph/`,
      });
    });

    it("fetches a continuous profile chunk", async () => {
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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "profile": {
            "chunkId": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
            "end": "2024-01-01T01:00:00Z",
            "environment": "production",
            "platform": "python",
            "profileType": "continuous",
            "profileUrl": "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/flamegraph/?profilerId=041bde57b9844e36b8b7e5734efae5f7&start=2024-01-01T00%3A00%3A00Z&end=2024-01-01T01%3A00%3A00Z",
            "profilerId": "041bde57b9844e36b8b7e5734efae5f7",
            "project": "backend",
            "release": "backend@1.2.3",
            "start": "2024-01-01T00:00:00Z",
          },
          "samples": {
            "frameCount": 6,
            "sampleCount": 8,
            "stackCount": 4,
            "threads": [
              {
                "id": "1",
                "name": "MainThread",
                "sampleCount": 7,
              },
              {
                "id": "2",
                "name": "BackgroundWorker",
                "sampleCount": 1,
              },
            ],
            "topFrames": [
              {
                "count": 8,
                "function": "handle_request",
                "isApplication": true,
                "location": "main.py:42",
              },
              {
                "count": 4,
                "function": "execute_query",
                "isApplication": true,
                "location": "db.py:118",
              },
              {
                "count": 2,
                "function": "serialize_response",
                "isApplication": true,
                "location": "serializers.py:55",
              },
            ],
          },
          "suggestedActions": [],
        }
      `);
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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.profile).toMatchObject({
        profileType: "continuous",
        profilerId: "041bde57b9844e36b8b7e5734efae5f7",
      });
    });

    it("maps transaction profile fields without leaking raw API data", async () => {
      const body = {
        ...structuredClone(transactionProfileV1Fixture),
        backendOnly: "must-not-leak-root",
      };
      body.profile.frames = body.profile.frames.map(
        (frame: Record<string, unknown>) => ({
          ...frame,
          instruction_addr: "0xmust-not-leak",
        }),
      );
      for (const host of ["sentry.io", "us.sentry.io"]) {
        mswServer.use(
          http.get(
            `https://${host}/api/0/projects/sentry-mcp-evals/backend/profiling/profiles/${transactionProfileV1Fixture.profile_id}/`,
            () => HttpResponse.json(body),
            { once: true },
          ),
        );
      }

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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      const serialized = JSON.stringify(result.structuredContent);
      for (const key of [
        "backendOnly",
        "instruction_addr",
        "abs_path",
        "in_app",
        "priority",
        "stack_id",
        "elapsed_since_start_ns",
        "relative_start_ns",
        "client_sdk",
      ]) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      expect(serialized).not.toContain("must-not-leak");
      // Raw transaction event ID and absolute frame paths are not mapped.
      expect(serialized).not.toContain("7ca573c0f4814912aaa9bdc77d1a7d51");
      expect(serialized).not.toContain("/app/src/main.py");
    });

    it("maps continuous profile fields without leaking raw chunk data", async () => {
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
          focusOnUserCode: false,
        },
        baseContext,
      );

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      const serialized = JSON.stringify(result.structuredContent);
      for (const key of ["event_id", "timestamp", "colno", "thread_metadata"]) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      expect(serialized).not.toContain(profileChunkFixture.chunk.event_id);
    });

    it("maps empty continuous release and environment to null", async () => {
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/projects/sentry-mcp-evals/backend/",
          () =>
            HttpResponse.json({ id: 12345, slug: "backend", name: "Backend" }),
          { once: true },
        ),
      );
      for (const host of ["sentry.io", "us.sentry.io"]) {
        mswServer.use(
          http.get(
            `https://${host}/api/0/organizations/sentry-mcp-evals/profiling/chunks/`,
            () =>
              HttpResponse.json({
                chunk: {
                  ...structuredClone(profileChunkFixture.chunk),
                  release: "",
                  environment: undefined,
                },
              }),
            { once: true },
          ),
        );
      }

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

      getProfileDetailsOutputSchema.parse(result.structuredContent);
      expect(result.structuredContent.profile).toMatchObject({
        profileType: "continuous",
        release: null,
        environment: null,
      });
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
