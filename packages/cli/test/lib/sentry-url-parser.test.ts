/**
 * Sentry URL Parser Tests
 *
 * Unit tests for parseSentryUrl() and applySentryUrlContext().
 * Uses fictional domains (sentry.example.com, sentry.acme.internal)
 * — never real customer data.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applySentryUrlContext,
  parseSentryUrl,
} from "../../src/lib/sentry-url-parser.js";

describe("parseSentryUrl", () => {
  describe("non-URL inputs return null", () => {
    test("plain text", () => {
      expect(parseSentryUrl("sentry/cli-G")).toBeNull();
    });

    test("numeric ID", () => {
      expect(parseSentryUrl("12345")).toBeNull();
    });

    test("short ID", () => {
      expect(parseSentryUrl("CLI-4Y")).toBeNull();
    });

    test("org/project format", () => {
      expect(parseSentryUrl("my-org/my-project")).toBeNull();
    });

    test("empty string", () => {
      expect(parseSentryUrl("")).toBeNull();
    });

    test("malformed URL", () => {
      expect(parseSentryUrl("http://")).toBeNull();
    });
  });

  describe("organization URLs", () => {
    test("SaaS /organizations/{org}/", () => {
      const result = parseSentryUrl("https://sentry.io/organizations/my-org/");
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
      });
    });

    test("self-hosted /organizations/{org}/", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/acme-corp/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme-corp",
      });
    });

    test("self-hosted Feedback permalink supports legacy mixed-case project slugs", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/acme-corp/feedback/?feedbackSlug=Legacy_Project%3A5146636313"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme-corp",
        project: "Legacy_Project",
        issueId: "5146636313",
      });
    });

    test("strips trailing path segments after org", () => {
      // /organizations/{org}/ with no further recognized segments → org only
      const result = parseSentryUrl("https://sentry.io/organizations/my-org/");
      expect(result?.org).toBe("my-org");
      expect(result?.issueId).toBeUndefined();
    });
  });

  describe("issue URLs", () => {
    test("/organizations/{org}/issues/{numericId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/issues/32886/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        issueId: "32886",
      });
    });

    test("/organizations/{org}/issues/{shortId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/issues/CLI-G/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        issueId: "CLI-G",
      });
    });

    test("self-hosted issue URL with query params", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/acme-corp/issues/32886/?project=2"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme-corp",
        issueId: "32886",
      });
    });

    test("self-hosted issue URL with port", () => {
      const result = parseSentryUrl(
        "https://sentry.acme.internal:9000/organizations/devops/issues/100/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.acme.internal:9000",
        org: "devops",
        issueId: "100",
      });
    });

    test("HTTP (non-HTTPS) self-hosted URL", () => {
      const result = parseSentryUrl(
        "http://sentry.local:8080/organizations/dev/issues/42/"
      );
      expect(result).toEqual({
        baseUrl: "http://sentry.local:8080",
        org: "dev",
        issueId: "42",
      });
    });
  });

  describe("event URLs", () => {
    test("/organizations/{org}/issues/{id}/events/{eventId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/issues/32886/events/abc123def456/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        issueId: "32886",
        eventId: "abc123def456",
      });
    });

    test("self-hosted event URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/acme/issues/999/events/deadbeef/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme",
        issueId: "999",
        eventId: "deadbeef",
      });
    });

    test("event URL without trailing slash", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/issues/1/events/evt001"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        issueId: "1",
        eventId: "evt001",
      });
    });
  });

  describe("trace URLs", () => {
    test("/organizations/{org}/explore/traces/trace/{traceId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
      });
    });

    test("org-domain /explore/traces/trace/{traceId}/", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
      });
    });

    test("/organizations/{org}/traces/{traceId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/traces/a4d1aae7216b47ff8117cf4e09ce9d0a/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
      });
    });

    test("self-hosted trace URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/devops/traces/00112233445566778899aabbccddeeff/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "devops",
        traceId: "00112233445566778899aabbccddeeff",
      });
    });

    test("explore/traces without the trace segment is not a detail", () => {
      // `explore/traces/{slug}/` (no `trace/` segment) is the list route or an
      // unrelated sub-route — the slug must not be captured as a trace ID. It
      // resolves to the org (like the replay list), not a trace detail.
      const result = parseSentryUrl(
        "https://my-org.sentry.io/explore/traces/some-subroute/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
      });
    });

    test("subdomain trace list resolves to the org", () => {
      const result = parseSentryUrl("https://my-org.sentry.io/explore/traces/");
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
      });
    });

    test("organizations explore/traces without trace segment is org-only", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/explore/traces/some-subroute/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
      });
    });
  });

  describe("replay URLs", () => {
    test("/organizations/{org}/explore/replays/{replayId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/explore/replays/346789a703f6454384f1de473b8b9fcc/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("legacy /organizations/{org}/replays/{replayId}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/replays/346789a703f6454384f1de473b8b9fcc/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("self-hosted replay URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/acme-corp/explore/replays/346789a703f6454384f1de473b8b9fcc/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme-corp",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("normalizes uppercase replay IDs in replay URLs", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/explore/replays/346789A703F6454384F1DE473B8B9FCC/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("falls back to org for replay listing URL", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/explore/replays/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
      });
    });

    test("falls back to org for legacy replay listing URL", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/replays/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
      });
    });

    test("rejects non-hex replay ID on explore path", () => {
      expect(
        parseSentryUrl(
          "https://sentry.io/organizations/my-org/explore/replays/some-random-page/"
        )
      ).toBeNull();
    });

    test("rejects non-hex replay ID on legacy path", () => {
      expect(
        parseSentryUrl(
          "https://sentry.io/organizations/my-org/replays/some-random-page/"
        )
      ).toBeNull();
    });

    test("rejects non-hex replay ID on subdomain explore path", () => {
      expect(
        parseSentryUrl(
          "https://my-org.sentry.io/explore/replays/some-random-page/"
        )
      ).toBeNull();
    });

    test("falls back to org for subdomain replay listing URL", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/explore/replays/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
      });
    });
  });

  describe("dashboard URLs", () => {
    test("/organizations/{org}/dashboard/{id}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/dashboard/4326879/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        dashboardId: "4326879",
      });
    });

    test("self-hosted dashboard URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/organizations/devops/dashboard/12345/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "devops",
        dashboardId: "12345",
      });
    });

    test("dashboard URL without trailing slash", () => {
      const result = parseSentryUrl(
        "https://sentry.io/organizations/my-org/dashboard/999"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        dashboardId: "999",
      });
    });
  });

  describe("project settings URLs", () => {
    test("/settings/{org}/projects/{project}/", () => {
      const result = parseSentryUrl(
        "https://sentry.io/settings/my-org/projects/backend/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        org: "my-org",
        project: "backend",
      });
    });

    test("self-hosted project settings URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/settings/acme/projects/web-frontend/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        org: "acme",
        project: "web-frontend",
      });
    });
  });

  describe("SaaS subdomain-style URLs (org in hostname)", () => {
    test("issue URL extracts org from subdomain", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/issues/99124558/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        issueId: "99124558",
      });
    });

    test("issue URL with event ID", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/issues/99124558/events/abc123/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        issueId: "99124558",
        eventId: "abc123",
      });
    });

    test("trace URL extracts org from subdomain", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/traces/a4d1aae7216b47ff8117cf4e09ce9d0a/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
      });
    });

    test("replay URL extracts org from subdomain", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/explore/replays/346789a703f6454384f1de473b8b9fcc/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("legacy replay URL extracts org from subdomain", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/replays/346789a703f6454384f1de473b8b9fcc/"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        replayId: "346789a703f6454384f1de473b8b9fcc",
      });
    });

    test("dashboard URL extracts org from subdomain", () => {
      const result = parseSentryUrl(
        "https://sentry-sdks.sentry.io/dashboard/4326879/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry-sdks.sentry.io",
        org: "sentry-sdks",
        dashboardId: "4326879",
      });
    });

    test("bare org subdomain returns org only", () => {
      const result = parseSentryUrl("https://my-org.sentry.io/");
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
      });
    });

    test("modern Feedback permalink returns its org", () => {
      const result = parseSentryUrl(
        "https://my-org.sentry.io/feedback/?feedbackSlug=my-project%3A5146636313"
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
        project: "my-project",
        issueId: "5146636313",
      });
    });

    test.each([
      "my-project%3Aa%3A5146636313",
      "my-project%3Aabc%2Fdef",
      "my-project%250A%3A5146636313",
    ])("does not extract malformed Feedback slug %s", (feedbackSlug) => {
      const result = parseSentryUrl(
        `https://my-org.sentry.io/feedback/?feedbackSlug=${feedbackSlug}`
      );
      expect(result).toEqual({
        baseUrl: "https://my-org.sentry.io",
        org: "my-org",
      });
    });

    test("hyphenated org slug", () => {
      const result = parseSentryUrl(
        "https://acme-corp.sentry.io/issues/12345/"
      );
      expect(result).toEqual({
        baseUrl: "https://acme-corp.sentry.io",
        org: "acme-corp",
        issueId: "12345",
      });
    });

    test("region subdomains are ignored (us.sentry.io)", () => {
      // Region hosts don't have org in subdomain — return null for unknown paths
      expect(parseSentryUrl("https://us.sentry.io/issues/123/")).toBeNull();
    });

    test("region subdomains are ignored (de.sentry.io)", () => {
      expect(parseSentryUrl("https://de.sentry.io/issues/123/")).toBeNull();
    });

    test("unknown subdomain path returns null", () => {
      expect(parseSentryUrl("https://my-org.sentry.io/auth/login/")).toBeNull();
    });

    test("self-hosted URLs are not matched as subdomain orgs", () => {
      // Self-hosted hostname doesn't end with .sentry.io — subdomain extraction must not apply.
      // The path /issues/123/ has no /organizations/ prefix, so no matcher handles it.
      expect(
        parseSentryUrl("https://sentry.example.com/issues/123/")
      ).toBeNull();
      expect(
        parseSentryUrl("https://sentry.acme.internal:9000/issues/456/")
      ).toBeNull();
    });
  });

  describe("share URLs", () => {
    test("SaaS subdomain share URL extracts org and shareId", () => {
      const result = parseSentryUrl(
        "https://gibush-kq.sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/"
      );
      expect(result).toEqual({
        baseUrl: "https://gibush-kq.sentry.io",
        org: "gibush-kq",
        shareId: "f1abd515c51346778384ff25dfb341e5",
      });
    });

    test("bare sentry.io share URL has no org", () => {
      const result = parseSentryUrl(
        "https://sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        shareId: "f1abd515c51346778384ff25dfb341e5",
      });
    });

    test("self-hosted share URL", () => {
      const result = parseSentryUrl(
        "https://sentry.example.com/share/issue/aabbccdd11223344aabbccdd11223344/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.example.com",
        shareId: "aabbccdd11223344aabbccdd11223344",
      });
    });

    test("self-hosted share URL with port", () => {
      const result = parseSentryUrl(
        "https://sentry.acme.internal:9000/share/issue/deadbeefdeadbeefdeadbeefdeadbeef/"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.acme.internal:9000",
        shareId: "deadbeefdeadbeefdeadbeefdeadbeef",
      });
    });

    test("region subdomain share URL has no org", () => {
      // us.sentry.io is a region, not an org — share URL falls through to matchSharePath
      const result = parseSentryUrl(
        "https://us.sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5/"
      );
      expect(result).toEqual({
        baseUrl: "https://us.sentry.io",
        shareId: "f1abd515c51346778384ff25dfb341e5",
      });
    });

    test("share URL without trailing slash", () => {
      const result = parseSentryUrl(
        "https://sentry.io/share/issue/f1abd515c51346778384ff25dfb341e5"
      );
      expect(result).toEqual({
        baseUrl: "https://sentry.io",
        shareId: "f1abd515c51346778384ff25dfb341e5",
      });
    });

    test("/share/ without issue segment returns null", () => {
      expect(parseSentryUrl("https://sentry.io/share/")).toBeNull();
    });

    test("/share/issue/ without shareId returns null", () => {
      expect(parseSentryUrl("https://sentry.io/share/issue/")).toBeNull();
    });
  });

  describe("unrecognized paths return null", () => {
    test("root URL", () => {
      expect(parseSentryUrl("https://sentry.io/")).toBeNull();
    });

    test("unknown path", () => {
      expect(parseSentryUrl("https://sentry.io/auth/login/")).toBeNull();
    });

    test("/settings without project segment", () => {
      expect(parseSentryUrl("https://sentry.io/settings/my-org/")).toBeNull();
    });

    test("/settings/{org}/projects/ without project slug", () => {
      expect(
        parseSentryUrl("https://sentry.io/settings/my-org/projects/")
      ).toBeNull();
    });
  });
});

describe("applySentryUrlContext", () => {
  // Host-scoping: applySentryUrlContext honors non-SaaS URLs ONLY when the
  // destination matches the active token's scoped host (with SaaS
  // equivalence). Mismatches throw CliError so credentials can't leak to an
  // attacker-chosen host.
  //
  // The test preload (test/preload.ts) sets `SENTRY_AUTH_TOKEN` scoped to
  // SaaS by default. To simulate a self-hosted-authenticated user, set
  // `SENTRY_HOST` BEFORE the module loads (which pins the env-token's scope)
  // and use `resetEnvTokenHostForTesting()` between cases.
  let originalSentryUrl: string | undefined;
  let originalSentryHost: string | undefined;

  beforeEach(async () => {
    originalSentryUrl = process.env.SENTRY_URL;
    originalSentryHost = process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    delete process.env.SENTRY_HOST;
    // Reset env-token-host capture so each test can re-pin based on the
    // SENTRY_HOST they set (or leave unset → SaaS default).
    const { resetEnvTokenHostForTesting } = await import(
      "../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
  });

  afterEach(async () => {
    if (originalSentryUrl !== undefined) {
      process.env.SENTRY_URL = originalSentryUrl;
    } else {
      delete process.env.SENTRY_URL;
    }
    if (originalSentryHost !== undefined) {
      process.env.SENTRY_HOST = originalSentryHost;
    } else {
      delete process.env.SENTRY_HOST;
    }
    const { resetEnvTokenHostForTesting } = await import(
      "../../src/lib/env-token-host.js"
    );
    resetEnvTokenHostForTesting();
  });

  test("writes env when non-SaaS URL matches token-scoped host", () => {
    // Pin env-token to the self-hosted instance via SENTRY_HOST before
    // calling captureEnvTokenHost() (implicit on first getEnvTokenHost call).
    process.env.SENTRY_HOST = "https://sentry.example.com";
    applySentryUrlContext("https://sentry.example.com");
    expect(process.env.SENTRY_HOST).toBe("https://sentry.example.com");
    expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
  });

  test("throws CliError for non-SaaS URL that does not match token host", () => {
    // Env-token defaults to SaaS (no SENTRY_HOST set), so a self-hosted URL
    // is a host-scope mismatch → CliError, env untouched.
    expect(() => applySentryUrlContext("https://sentry.example.com")).toThrow(
      /does not match|sentry auth login --url/
    );
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("does not set SENTRY_HOST or SENTRY_URL for SaaS (sentry.io)", () => {
    applySentryUrlContext("https://sentry.io");
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("does not set SENTRY_HOST or SENTRY_URL for SaaS subdomain (us.sentry.io)", () => {
    applySentryUrlContext("https://us.sentry.io");
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("throws on mismatch even when SENTRY_HOST is pre-set to a different host", () => {
    // Token scoped to existing.example.com; URL-arg points at sentry.other.com.
    // Primary guard refuses to re-scope by writing the new host — only
    // `sentry auth login --url` may change scope.
    process.env.SENTRY_HOST = "https://existing.example.com";
    process.env.SENTRY_URL = "https://existing.example.com";
    expect(() => applySentryUrlContext("https://sentry.other.com")).toThrow(
      /does not match|sentry auth login --url/
    );
    // Existing env left intact — throw happens before any write.
    expect(process.env.SENTRY_HOST).toBe("https://existing.example.com");
    expect(process.env.SENTRY_URL).toBe("https://existing.example.com");
  });

  test("writes env for self-hosted URL with port when it matches token host", () => {
    process.env.SENTRY_HOST = "https://sentry.acme.internal:9000";
    applySentryUrlContext("https://sentry.acme.internal:9000");
    expect(process.env.SENTRY_HOST).toBe("https://sentry.acme.internal:9000");
    expect(process.env.SENTRY_URL).toBe("https://sentry.acme.internal:9000");
  });

  test("clears both env vars when SaaS URL is detected", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    process.env.SENTRY_URL = "https://sentry.example.com";
    applySentryUrlContext("https://sentry.io");
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("clears both env vars when SaaS subdomain is detected", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    process.env.SENTRY_URL = "https://sentry.example.com";
    applySentryUrlContext("https://us.sentry.io");
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });
});
