/**
 * Property-Based Tests for Sentry URL Parser
 *
 * Round-trip tests: verifies that URLs built by sentry-urls.ts builders
 * can be correctly parsed back by parseSentryUrl().
 */

import {
  assert as fcAssert,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parseSentryUrl } from "../../src/lib/sentry-url-parser.js";
import {
  buildOrgUrl,
  buildProjectUrl,
  buildReplayUrl,
  buildTraceUrl,
} from "../../src/lib/sentry-urls.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/**
 * Generates valid org slugs (lowercase, alphanumeric with hyphens).
 *
 * Excludes `xn--` prefixes (punycode-encoded IDN labels) because the URL
 * constructor silently decodes them, collapsing `xn--XX.sentry.io` into
 * `sentry.io` and dropping the org subdomain.
 */
const orgSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/).filter(
  (s) => !s.startsWith("xn--")
);

/** Generates valid project slugs (lowercase, alphanumeric with hyphens) */
const projectSlugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/).filter(
  (s) => !s.startsWith("xn--")
);

/** Generates valid 32-character hex trace IDs */
const traceIdArb = stringMatching(/^[0-9a-f]{32}$/);

/** Generates valid 32-character hex replay IDs */
const replayIdArb = stringMatching(/^[0-9a-f]{32}$/);

/** Generates numeric issue IDs */
const numericIdArb = stringMatching(/^[1-9][0-9]{0,10}$/);

/** Generates hex-like event IDs (32 chars) */
const eventIdArb = stringMatching(/^[0-9a-f]{32}$/);

describe("parseSentryUrl round-trip properties", () => {
  test("buildOrgUrl → parseSentryUrl extracts org", async () => {
    await fcAssert(
      property(orgSlugArb, (org) => {
        const url = buildOrgUrl(org);
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.org).toBe(org);
        expect(parsed?.issueId).toBeUndefined();
        expect(parsed?.project).toBeUndefined();
        expect(parsed?.traceId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("buildProjectUrl → parseSentryUrl extracts org and project", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, projectSlugArb), ([org, project]) => {
        const url = buildProjectUrl(org, project);
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.org).toBe(org);
        expect(parsed?.project).toBe(project);
        expect(parsed?.issueId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("buildTraceUrl → parseSentryUrl extracts org and traceId", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, traceIdArb), ([org, traceId]) => {
        const url = buildTraceUrl(org, traceId);
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.org).toBe(org);
        expect(parsed?.traceId).toBe(traceId);
        expect(parsed?.issueId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("buildReplayUrl → parseSentryUrl extracts org and replayId", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, replayIdArb), ([org, replayId]) => {
        const url = buildReplayUrl(org, replayId);
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.org).toBe(org);
        expect(parsed?.replayId).toBe(replayId);
        expect(parsed?.issueId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("issue URL round-trip: org and numeric issueId extracted", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, numericIdArb), ([org, issueId]) => {
        // Construct the URL pattern that Sentry uses for issues
        const url = `https://sentry.io/organizations/${org}/issues/${issueId}/`;
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.org).toBe(org);
        expect(parsed?.issueId).toBe(issueId);
        expect(parsed?.eventId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("event URL round-trip: org, issueId, and eventId extracted", async () => {
    await fcAssert(
      property(
        tuple(orgSlugArb, numericIdArb, eventIdArb),
        ([org, issueId, eventId]) => {
          const url = `https://sentry.io/organizations/${org}/issues/${issueId}/events/${eventId}/`;
          const parsed = parseSentryUrl(url);

          expect(parsed).not.toBeNull();
          expect(parsed?.org).toBe(org);
          expect(parsed?.issueId).toBe(issueId);
          expect(parsed?.eventId).toBe(eventId);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-URL strings always return null", async () => {
    // Org slugs alone should never parse as URLs
    await fcAssert(
      property(orgSlugArb, (org) => {
        expect(parseSentryUrl(org)).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("baseUrl always contains scheme and host", async () => {
    await fcAssert(
      property(tuple(orgSlugArb, numericIdArb), ([org, issueId]) => {
        const url = `https://sentry.io/organizations/${org}/issues/${issueId}/`;
        const parsed = parseSentryUrl(url);

        expect(parsed).not.toBeNull();
        expect(parsed?.baseUrl).toMatch(/^https?:\/\/.+/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
