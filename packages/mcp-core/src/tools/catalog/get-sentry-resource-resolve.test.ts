import { describe, it, expect } from "vitest";
import {
  resolveResourceParams,
  type ResolvedResourceParams,
} from "./get-sentry-resource.js";

/**
 * Pure unit tests for resolveResourceParams.
 * No MSW mocks needed — this function only parses URLs and validates params.
 */
describe("resolveResourceParams", () => {
  // ─── URL mode: issue URLs ──────────────────────────────────────────────────
  describe("URL mode — issue URLs", () => {
    it("parses subdomain issue URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/PROJECT-123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("parses path-based org issue URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.io/my-org/issues/PROJECT-123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("parses /organizations/{org}/ issue URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.io/organizations/my-org/issues/PROJECT-123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("parses issue URL with trailing slash", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/PROJECT-123/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("parses numeric issue ID", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/12345",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "12345",
      });
    });

    it("parses self-hosted Sentry issue URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.mycompany.com/issues/789",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "sentry",
        issueId: "789",
      });
    });
  });

  // ─── URL mode: event URLs ─────────────────────────────────────────────────
  describe("URL mode — event URLs", () => {
    it("parses subdomain event URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/PROJECT-123/events/abc123def",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
        eventId: "abc123def",
      });
    });

    it("parses path-based org event URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.io/my-org/issues/PROJECT-123/events/abc123def",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
        eventId: "abc123def",
      });
    });

    it("parses /organizations/ event URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.io/organizations/my-org/issues/PROJECT-123/events/abc123def",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
        eventId: "abc123def",
      });
    });

    it("parses event URL with trailing slash", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/PROJECT-123/events/abc123def/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
        eventId: "abc123def",
      });
    });
  });

  // ─── URL mode: trace URLs ─────────────────────────────────────────────────
  describe("URL mode — trace URLs", () => {
    const traceId = "a4d1aae7216b47ff8117cf4e09ce9d0a";

    it("parses /explore/traces/trace/ URL", () => {
      expect(
        resolveResourceParams({
          url: `https://my-org.sentry.io/explore/traces/trace/${traceId}`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId,
      });
    });

    it("parses /performance/trace/ URL", () => {
      expect(
        resolveResourceParams({
          url: `https://my-org.sentry.io/performance/trace/${traceId}`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId,
      });
    });

    it("treats focused trace URLs as span resources", () => {
      expect(
        resolveResourceParams({
          url: `https://my-org.sentry.io/performance/trace/${traceId}?node=span-abc123`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "span",
        organizationSlug: "my-org",
        traceId,
        spanId: "abc123",
      });
    });

    it("ignores non-span node query param", () => {
      expect(
        resolveResourceParams({
          url: `https://my-org.sentry.io/performance/trace/${traceId}?node=txn-abc123`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId,
      });
    });

    it("parses /organizations/ trace URL", () => {
      expect(
        resolveResourceParams({
          url: `https://sentry.io/organizations/my-org/explore/traces/trace/${traceId}`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId,
      });
    });

    it("parses trace URL with trailing slash", () => {
      expect(
        resolveResourceParams({
          url: `https://my-org.sentry.io/explore/traces/trace/${traceId}/`,
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId,
      });
    });
  });

  // ─── URL mode: profile URLs ───────────────────────────────────────────────
  describe("URL mode — profile URLs", () => {
    it("parses continuous flamegraph URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/profiling/profile/my-project/flamegraph/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "my-org",
        projectSlugOrId: "my-project",
        profileId: undefined,
        profilerId: undefined,
        start: undefined,
        end: undefined,
      });
    });

    it("parses flamegraph URL with profilerId query param", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/profiling/profile/my-project/flamegraph/?profilerId=abc123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "my-org",
        projectSlugOrId: "my-project",
        profileId: undefined,
        profilerId: "abc123",
        start: undefined,
        end: undefined,
      });
    });

    it("parses transaction flamegraph URL with profile ID in path segment", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.sentry.io/explore/profiling/profile/sentry/cfe78a5c892d4a64/flamegraph/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "sentry",
        projectSlugOrId: "sentry",
        profileId: "cfe78a5c892d4a64",
        profilerId: undefined,
        start: undefined,
        end: undefined,
      });
    });

    it("parses continuous /profiling/profile/ URL (without /explore/)", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/profiling/profile/my-project/flamegraph/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "my-org",
        projectSlugOrId: "my-project",
        profileId: undefined,
        profilerId: undefined,
        start: undefined,
        end: undefined,
      });
    });

    it("parses /organizations/ profile URL", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.io/organizations/my-org/profiling/profile/my-project/flamegraph/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "my-org",
        projectSlugOrId: "my-project",
        profileId: undefined,
        profilerId: undefined,
        start: undefined,
        end: undefined,
      });
    });

    it("parses transaction flamegraph URL with extra query params", () => {
      expect(
        resolveResourceParams({
          url: "https://sentry.sentry.io/explore/profiling/profile/sentry/cfe78a5c/flamegraph/?colorCoding=by%20system%20vs%20application%20frame&frameName=SentryEnvMiddleware",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "profile",
        organizationSlug: "sentry",
        projectSlugOrId: "sentry",
        profileId: "cfe78a5c",
        profilerId: undefined,
        start: undefined,
        end: undefined,
      });
    });

    it("rejects profile URLs outside the active organization constraint", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/profiling/profile/my-project/flamegraph/",
          organizationSlug: "other-org",
        }),
      ).toThrow(
        'Sentry resource URL is outside the active organization constraint. Expected organization "other-org" but got "my-org".',
      );
    });

    it("rejects profile URLs outside the active project constraint", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/profiling/profile/my-project/flamegraph/",
          projectSlug: "other-project",
        }),
      ).toThrow(
        'Profile URL is outside the active project constraint. Expected project "other-project" but got "my-project".',
      );
    });
  });

  // ─── URL mode: recognized types (replay, monitor, release) ────────────────
  describe("URL mode — recognized types", () => {
    it.each([
      "https://my-org.sentry.io/projects/my-project/events/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4/",
      "https://sentry.io/organizations/my-org/projects/my-project/events/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4/",
    ])("parses project event URL %s", (url) => {
      expect(resolveResourceParams({ url })).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        eventId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        issueId: undefined,
      });
    });

    it("parses replay URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/replays/abc123def456/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "replay",
        organizationSlug: "my-org",
        replayId: "abc123def456",
      });
    });

    it("parses monitor URL (simple slug)", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/crons/daily-backup/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "monitor",
        organizationSlug: "my-org",
        monitorSlug: "daily-backup",
      });
    });

    it("parses monitor URL with project/slug path", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/crons/my-project/my-monitor/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "monitor",
        organizationSlug: "my-org",
        projectSlugOrId: "my-project",
        monitorSlug: "my-monitor",
      });
    });

    it("allows numeric project IDs in monitor URLs under a project constraint", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/crons/4509109104082945/my-monitor/",
          projectSlug: "backend",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "monitor",
        organizationSlug: "my-org",
        projectSlugOrId: "4509109104082945",
        monitorSlug: "my-monitor",
      });
    });

    it("parses release URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/releases/v1.2.3/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "release",
        organizationSlug: "my-org",
        releaseVersion: "v1.2.3",
      });
    });

    it("parses release URL with complex version", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/releases/backend@2024.01.15-abc123/",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "release",
        organizationSlug: "my-org",
        releaseVersion: "backend@2024.01.15-abc123",
      });
    });
  });

  // ─── URL mode: error cases ────────────────────────────────────────────────
  describe("URL mode — error cases", () => {
    it.each([
      [
        "https://my-org.sentry.io/issues/?query=is%3Aunresolved",
        "Use `search_issues` to list issues",
      ],
      [
        "https://my-org.sentry.io/alerts/rules/details/123/",
        "Use `find_alert_rules` to list alert rules",
      ],
      [
        "https://my-org.sentry.io/explore/logs/?project=1",
        "Use `search_logs` to query logs",
      ],
      [
        "https://my-org.sentry.io/explore/traces/",
        "Use `search_traces` to query traces",
      ],
      [
        "https://sentry.io/api/0/projects/my-org/my-project/events/abc123/",
        "This is a Sentry API URL",
      ],
    ])("explains unsupported URL %s", (url, message) => {
      expect(() => resolveResourceParams({ url })).toThrow(message);
    });

    it("throws for unknown URL path (settings)", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/settings/projects/",
        }),
      ).toThrow("Could not determine resource type from URL");
    });

    it("throws helpful error for performance summary URL", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/performance/summary/?transaction=/api/users",
        }),
      ).toThrow(
        'Detected a performance summary URL for transaction "/api/users"',
      );
    });

    it("throws for encoded transaction names in performance summary", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/performance/summary/?transaction=%2Fapi%2F0%2Forganizations",
        }),
      ).toThrow("Detected a performance summary URL for transaction");
    });

    it("throws for invalid URL (not http)", () => {
      expect(() =>
        resolveResourceParams({ url: "ftp://sentry.io/issues/123" }),
      ).toThrow("Invalid Sentry URL");
    });

    it("throws for malformed URL", () => {
      expect(() => resolveResourceParams({ url: "not-a-url" })).toThrow(
        "Invalid Sentry URL",
      );
    });
  });

  // ─── URL mode with resourceType override ──────────────────────────────────
  describe("URL mode with resourceType override", () => {
    it("passes through when override matches detected type", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/issues/PROJECT-123",
          resourceType: "issue",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("allows trace override on a focused span URL", () => {
      expect(
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/traces/trace/abc123?node=span-def456",
          resourceType: "trace",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId: "abc123",
      });
    });

    it("rejects non-breadcrumbs override on different type URL", () => {
      expect(() =>
        resolveResourceParams({
          url: "https://my-org.sentry.io/explore/traces/trace/abc123",
          resourceType: "issue",
        }),
      ).toThrow("Cannot override URL type with resourceType 'issue'");
    });
  });

  // ─── By type and ID ─────────────────────────────────────────────────────────
  describe("By type and ID", () => {
    it("resolves issue type", () => {
      expect(
        resolveResourceParams({
          resourceType: "issue",
          organizationSlug: "my-org",
          resourceId: "PROJECT-123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("uppercases issue resourceId", () => {
      expect(
        resolveResourceParams({
          resourceType: "issue",
          organizationSlug: "my-org",
          resourceId: "project-123",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "issue",
        organizationSlug: "my-org",
        issueId: "PROJECT-123",
      });
    });

    it("resolves event type", () => {
      expect(
        resolveResourceParams({
          resourceType: "event",
          organizationSlug: "my-org",
          resourceId: "7ca573c0f4814912aaa9bdc77d1a7d51",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "event",
        organizationSlug: "my-org",
        eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
      });
    });

    it("resolves trace type", () => {
      expect(
        resolveResourceParams({
          resourceType: "trace",
          organizationSlug: "my-org",
          resourceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "trace",
        organizationSlug: "my-org",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
      });
    });
  });

  // ─── By type and ID: validation errors ──────────────────────────────────────
  describe("By ID without resourceType", () => {
    it.each(["PROJECT-123", "MY-WEB-APP-2KD", "1234567890"])(
      "infers issue for %s",
      (resourceId) => {
        expect(
          resolveResourceParams({ organizationSlug: "my-org", resourceId }),
        ).toEqual<ResolvedResourceParams>({
          type: "issue",
          organizationSlug: "my-org",
          issueId: resourceId,
        });
      },
    );

    it.each(["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "my-cron-job"])(
      "still requires resourceType for %s",
      (resourceId) => {
        expect(() =>
          resolveResourceParams({ organizationSlug: "my-org", resourceId }),
        ).toThrow("Either `url` or `resourceType` must be provided");
      },
    );
  });

  describe("By type and ID — validation errors", () => {
    it("throws when neither url nor resourceType provided", () => {
      expect(() => resolveResourceParams({})).toThrow(
        "Either `url` or `resourceType` must be provided",
      );
    });

    it("throws when only organizationSlug provided", () => {
      expect(() =>
        resolveResourceParams({ organizationSlug: "my-org" }),
      ).toThrow("Either `url` or `resourceType` must be provided");
    });

    it("throws when organizationSlug missing", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "issue",
          resourceId: "PROJECT-123",
        }),
      ).toThrow("`organizationSlug` is required when not using a URL");
    });

    it("throws when resourceId missing", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "issue",
          organizationSlug: "my-org",
        }),
      ).toThrow("`resourceId` is required when not using a URL");
    });

    it("throws for unsupported explicit resourceType (profile)", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "profile",
          organizationSlug: "my-org",
          resourceId: "something",
        }),
      ).toThrow("Invalid resourceType: profile");
    });

    it("accepts replay as an explicit resourceType", () => {
      expect(
        resolveResourceParams({
          resourceType: "replay",
          organizationSlug: "my-org",
          resourceId: "something",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "replay",
        organizationSlug: "my-org",
        replayId: "something",
      });
    });

    it("accepts monitor as an explicit resourceType", () => {
      expect(
        resolveResourceParams({
          resourceType: "monitor",
          organizationSlug: "my-org",
          resourceId: "daily-backup",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "monitor",
        organizationSlug: "my-org",
        monitorSlug: "daily-backup",
      });
    });

    it("preserves scoped project for explicit monitor resourceType", () => {
      expect(
        resolveResourceParams({
          resourceType: "monitor",
          organizationSlug: "my-org",
          projectSlug: "backend",
          resourceId: "daily-backup",
        }),
      ).toEqual<ResolvedResourceParams>({
        type: "monitor",
        organizationSlug: "my-org",
        monitorSlug: "daily-backup",
        projectSlugOrId: "backend",
      });
    });

    it("throws for completely invalid resourceType", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "foobar",
          organizationSlug: "my-org",
          resourceId: "something",
        }),
      ).toThrow("Invalid resourceType: foobar");
    });
  });

  // ─── Null/undefined param handling ────────────────────────────────────────
  describe("Null/undefined param handling", () => {
    it("treats null url same as undefined", () => {
      expect(() => resolveResourceParams({ url: null })).toThrow(
        "Either `url` or `resourceType` must be provided",
      );
    });

    it("treats null resourceType same as undefined", () => {
      expect(() => resolveResourceParams({ resourceType: null })).toThrow(
        "Either `url` or `resourceType` must be provided",
      );
    });

    it("treats null organizationSlug as missing", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "issue",
          organizationSlug: null,
          resourceId: "PROJECT-123",
        }),
      ).toThrow("`organizationSlug` is required");
    });

    it("treats null resourceId as missing", () => {
      expect(() =>
        resolveResourceParams({
          resourceType: "issue",
          organizationSlug: "my-org",
          resourceId: null,
        }),
      ).toThrow("`resourceId` is required");
    });
  });
});
