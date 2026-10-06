/**
 * Property-Based Tests for Sentry URL Utilities
 *
 * Uses fast-check to verify invariants of URL validation and building
 * functions that are difficult to exhaustively test with example-based tests.
 */

import {
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildBillingUrl,
  buildDashboardsListUrl,
  buildDashboardUrl,
  buildEventSearchUrl,
  buildLogsUrl,
  buildOrgSettingsUrl,
  buildOrgUrl,
  buildProjectIssuesUrl,
  buildProjectUrl,
  buildSeerSettingsUrl,
  buildTraceUrl,
  getOrgBaseUrl,
  isSentrySaasUrl,
  parseOrgProjectFromSettingsUrl,
} from "../../src/lib/sentry-urls.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Save original env
let originalSentryUrl: string | undefined;
let originalSentryHost: string | undefined;

beforeEach(() => {
  originalSentryUrl = process.env.SENTRY_URL;
  originalSentryHost = process.env.SENTRY_HOST;
  // Clear SENTRY_HOST/SENTRY_URL for consistent base URL in tests
  delete process.env.SENTRY_HOST;
  delete process.env.SENTRY_URL;
});

afterEach(() => {
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
});

// Arbitraries

/** Valid subdomain parts (lowercase alphanumeric with hyphens, not starting/ending with hyphen) */
const subdomainPartArb = stringMatching(
  /^[a-z][a-z0-9-]{0,10}[a-z0-9]$/
).filter((s) => !s.includes("--") && s.length >= 2);

/** Valid org/project slugs (exclude xn-- punycode prefix — invalid IDN breaks URL parser) */
const slugArb = stringMatching(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/).filter(
  (s) => !s.startsWith("xn--")
);

/** Valid event IDs (32-char hex) */
const eventIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid log IDs (32-char hex, same format as event IDs) */
const logIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid trace IDs (32-char hex) */
const traceIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid dashboard IDs (numeric strings) */
const dashboardIdArb = stringMatching(/^[1-9][0-9]{0,8}$/);

/** Valid project IDs (numeric strings, same shape as other Sentry IDs) */
const projectIdArb = stringMatching(/^[1-9][0-9]{0,8}$/);

/** Common Sentry regions */
const sentryRegionArb = constantFrom("us", "de", "eu", "staging");

/** Arbitrary domain that is NOT sentry.io */
const nonSentryDomainArb = oneof(
  constantFrom(
    "example.com",
    "localhost",
    "evil.com",
    "sentry-fake.com",
    "notsentry.io",
    "sentry.io.evil.com",
    "example.sentry.io.evil.com"
  ),
  // Generate random domains
  tuple(subdomainPartArb, constantFrom(".com", ".org", ".net", ".io")).map(
    ([sub, tld]) => `${sub}${tld}`
  )
).filter((domain) => {
  // Ensure it's not actually sentry.io or a subdomain
  return domain !== "sentry.io" && !domain.endsWith(".sentry.io");
});

/** Hash fragments for URLs */
const hashArb = stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,20}$/);

/** Product names for billing URLs */
const productArb = constantFrom("seer", "errors", "performance", "replays");

describe("isSentrySaasUrl properties", () => {
  test("sentry.io always returns true", () => {
    expect(isSentrySaasUrl("https://sentry.io")).toBe(true);
    expect(isSentrySaasUrl("http://sentry.io")).toBe(true);
    expect(isSentrySaasUrl("https://sentry.io/")).toBe(true);
    expect(isSentrySaasUrl("https://sentry.io/path")).toBe(true);
  });

  test("*.sentry.io subdomains always return true", async () => {
    await fcAssert(
      property(sentryRegionArb, (region) => {
        const url = `https://${region}.sentry.io`;
        expect(isSentrySaasUrl(url)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("arbitrary subdomains of sentry.io return true", async () => {
    await fcAssert(
      property(subdomainPartArb, (subdomain) => {
        const url = `https://${subdomain}.sentry.io`;
        expect(isSentrySaasUrl(url)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-sentry.io domains always return false", async () => {
    await fcAssert(
      property(nonSentryDomainArb, (domain) => {
        const url = `https://${domain}`;
        expect(isSentrySaasUrl(url)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("invalid URLs return false", () => {
    const invalidUrls = [
      "not-a-url",
      "",
      "://sentry.io",
      "sentry.io", // no protocol
      "http://", // no host
    ];

    for (const url of invalidUrls) {
      expect(isSentrySaasUrl(url)).toBe(false);
    }
  });

  test("non-HTTP protocols still work for sentry.io domain", () => {
    // The function checks hostname, not protocol
    // ftp://sentry.io is still a sentry.io domain
    expect(isSentrySaasUrl("ftp://sentry.io")).toBe(true);
  });

  test("security: lookalike domains return false", () => {
    // These should all return false - they're attempts to spoof sentry.io
    const lookalikes = [
      "https://sentry.io.evil.com",
      "https://sentry.io-fake.com",
      "https://evil.com/sentry.io",
      "https://notsentry.io",
      "https://sentry.io.example.com",
    ];

    for (const url of lookalikes) {
      expect(isSentrySaasUrl(url)).toBe(false);
    }
  });

  test("deterministic: same input always produces same output", async () => {
    await fcAssert(
      property(
        oneof(
          constantFrom("https://sentry.io", "https://us.sentry.io"),
          nonSentryDomainArb.map((d) => `https://${d}`)
        ),
        (url) => {
          const result1 = isSentrySaasUrl(url);
          const result2 = isSentrySaasUrl(url);
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildOrgUrl properties", () => {
  test("output always starts with org base URL", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildOrgUrl(orgSlug);
        expect(result.startsWith(getOrgBaseUrl(orgSlug))).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output always contains the org slug", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildOrgUrl(orgSlug);
        expect(result).toContain(orgSlug);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output follows expected pattern", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildOrgUrl(orgSlug);
        expect(result).toBe(`${getOrgBaseUrl(orgSlug)}/`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildOrgUrl(orgSlug);
        expect(() => new URL(result)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildProjectUrl properties", () => {
  test("output contains both org and project slugs", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb), ([orgSlug, projectSlug]) => {
        const result = buildProjectUrl(orgSlug, projectSlug);
        expect(result).toContain(orgSlug);
        expect(result).toContain(projectSlug);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output follows expected pattern", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb), ([orgSlug, projectSlug]) => {
        const result = buildProjectUrl(orgSlug, projectSlug);
        expect(result).toBe(
          `${getOrgBaseUrl(orgSlug)}/settings/projects/${projectSlug}/`
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb), ([orgSlug, projectSlug]) => {
        const result = buildProjectUrl(orgSlug, projectSlug);
        expect(() => new URL(result)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildEventSearchUrl properties", () => {
  test("output contains event ID in query string", async () => {
    await fcAssert(
      property(tuple(slugArb, eventIdArb), ([orgSlug, eventId]) => {
        const result = buildEventSearchUrl(orgSlug, eventId);
        expect(result).toContain(`event.id:${eventId}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL with query parameter", async () => {
    await fcAssert(
      property(tuple(slugArb, eventIdArb), ([orgSlug, eventId]) => {
        const result = buildEventSearchUrl(orgSlug, eventId);
        const url = new URL(result);
        expect(url.searchParams.get("query")).toContain(eventId);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildProjectIssuesUrl properties", () => {
  test("with a project ID, output filters the Issues stream by project", async () => {
    await fcAssert(
      property(tuple(slugArb, projectIdArb), ([orgSlug, projectId]) => {
        const result = buildProjectIssuesUrl(orgSlug, projectId);
        expect(result).toBe(
          `${getOrgBaseUrl(orgSlug)}/issues/?project=${projectId}`
        );
        expect(new URL(result).searchParams.get("project")).toBe(projectId);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("without a project ID, output is the org-wide Issues stream", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildProjectIssuesUrl(orgSlug);
        expect(result).toBe(`${getOrgBaseUrl(orgSlug)}/issues/`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL that points at the Issues stream", async () => {
    await fcAssert(
      property(tuple(slugArb, projectIdArb), ([orgSlug, projectId]) => {
        const result = buildProjectIssuesUrl(orgSlug, projectId);
        expect(() => new URL(result)).not.toThrow();
        expect(new URL(result).pathname).toBe("/issues/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseOrgProjectFromSettingsUrl properties", () => {
  test("round-trips org and project through a settings URL (SaaS)", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb), ([orgSlug, projectSlug]) => {
        const url = buildProjectUrl(orgSlug, projectSlug);
        expect(parseOrgProjectFromSettingsUrl(url)).toEqual({
          orgSlug,
          projectSlug,
        });
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("round-trips org and project through a settings URL (self-hosted)", async () => {
    process.env.SENTRY_URL = "https://sentry.example.com";
    await fcAssert(
      property(tuple(slugArb, slugArb), ([orgSlug, projectSlug]) => {
        const url = buildProjectUrl(orgSlug, projectSlug);
        expect(parseOrgProjectFromSettingsUrl(url)).toEqual({
          orgSlug,
          projectSlug,
        });
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns empty for unparseable input", () => {
    expect(parseOrgProjectFromSettingsUrl("not a url")).toEqual({});
  });
});

describe("buildOrgSettingsUrl properties", () => {
  test("without hash, output ends with trailing slash", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildOrgSettingsUrl(orgSlug);
        expect(result.endsWith("/")).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("with hash, output contains hash fragment", async () => {
    await fcAssert(
      property(tuple(slugArb, hashArb), ([orgSlug, hash]) => {
        const result = buildOrgSettingsUrl(orgSlug, hash);
        expect(result).toContain(`#${hash}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("hash is appended at the end", async () => {
    await fcAssert(
      property(tuple(slugArb, hashArb), ([orgSlug, hash]) => {
        const result = buildOrgSettingsUrl(orgSlug, hash);
        expect(result.endsWith(`#${hash}`)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildSeerSettingsUrl properties", () => {
  test("output contains /seer/ path", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildSeerSettingsUrl(orgSlug);
        expect(result).toContain("/seer/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is under settings path", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildSeerSettingsUrl(orgSlug);
        expect(result).toContain("/settings/seer/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildBillingUrl properties", () => {
  test("without product, output has no query string", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildBillingUrl(orgSlug);
        expect(result.includes("?")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("with product, output has product query parameter", async () => {
    await fcAssert(
      property(tuple(slugArb, productArb), ([orgSlug, product]) => {
        const result = buildBillingUrl(orgSlug, product);
        expect(result).toContain(`?product=${product}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output contains /billing/overview/ path", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildBillingUrl(orgSlug);
        expect(result).toContain("/billing/overview/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildLogsUrl properties", () => {
  test("without logId, output has no query string", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildLogsUrl(orgSlug);
        expect(result.includes("?")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("with logId, output contains query parameter with log ID", async () => {
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([orgSlug, logId]) => {
        const result = buildLogsUrl(orgSlug, logId);
        expect(result).toContain(`?query=sentry.item_id:${logId}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output contains /explore/logs/ path", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildLogsUrl(orgSlug);
        expect(result).toContain("/explore/logs/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([orgSlug, logId]) => {
        expect(() => new URL(buildLogsUrl(orgSlug))).not.toThrow();
        expect(() => new URL(buildLogsUrl(orgSlug, logId))).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildTraceUrl properties", () => {
  test("output contains /explore/traces/trace/ path with trace ID", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([orgSlug, traceId]) => {
        const result = buildTraceUrl(orgSlug, traceId);
        expect(result).toContain(`/explore/traces/trace/${traceId}/`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output contains the org slug", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([orgSlug, traceId]) => {
        const result = buildTraceUrl(orgSlug, traceId);
        expect(result).toContain(orgSlug);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([orgSlug, traceId]) => {
        const result = buildTraceUrl(orgSlug, traceId);
        expect(() => new URL(result)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output follows expected pattern", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([orgSlug, traceId]) => {
        const result = buildTraceUrl(orgSlug, traceId);
        expect(result).toBe(
          `${getOrgBaseUrl(orgSlug)}/explore/traces/trace/${traceId}/`
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildDashboardsListUrl properties", () => {
  test("output contains /dashboards/ path", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildDashboardsListUrl(orgSlug);
        expect(result).toContain("/dashboards/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output contains the org slug", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildDashboardsListUrl(orgSlug);
        expect(result).toContain(orgSlug);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(slugArb, (orgSlug) => {
        const result = buildDashboardsListUrl(orgSlug);
        expect(() => new URL(result)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("buildDashboardUrl properties", () => {
  test("output contains /dashboard/{id}/ path", async () => {
    await fcAssert(
      property(tuple(slugArb, dashboardIdArb), ([orgSlug, dashboardId]) => {
        const result = buildDashboardUrl(orgSlug, dashboardId);
        expect(result).toContain(`/dashboard/${dashboardId}/`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output contains org slug and dashboard ID", async () => {
    await fcAssert(
      property(tuple(slugArb, dashboardIdArb), ([orgSlug, dashboardId]) => {
        const result = buildDashboardUrl(orgSlug, dashboardId);
        expect(result).toContain(orgSlug);
        expect(result).toContain(dashboardId);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output is a valid URL", async () => {
    await fcAssert(
      property(tuple(slugArb, dashboardIdArb), ([orgSlug, dashboardId]) => {
        const result = buildDashboardUrl(orgSlug, dashboardId);
        expect(() => new URL(result)).not.toThrow();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("SENTRY_HOST precedence", () => {
  test("SENTRY_HOST takes precedence over SENTRY_URL for URL builders", () => {
    process.env.SENTRY_HOST = "https://host.company.com";
    process.env.SENTRY_URL = "https://url.company.com";
    expect(buildOrgUrl("my-org")).toContain("host.company.com");
    expect(buildOrgUrl("my-org")).not.toContain("url.company.com");
  });

  test("SENTRY_HOST alone configures self-hosted URL builders", () => {
    process.env.SENTRY_HOST = "https://sentry.company.com";
    expect(getOrgBaseUrl("my-org")).toBe("https://sentry.company.com");
    expect(buildOrgUrl("my-org")).toBe(
      "https://sentry.company.com/organizations/my-org/"
    );
  });
});

describe("self-hosted URLs", () => {
  const SELF_HOSTED_URL = "https://sentry.company.com";

  beforeEach(() => {
    process.env.SENTRY_URL = SELF_HOSTED_URL;
  });

  test("getOrgBaseUrl returns base URL without subdomain", () => {
    expect(getOrgBaseUrl("my-org")).toBe(SELF_HOSTED_URL);
  });

  test("buildOrgUrl uses path-based pattern", () => {
    expect(buildOrgUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/`
    );
  });

  test("buildEventSearchUrl uses path-based pattern", () => {
    expect(
      buildEventSearchUrl("my-org", "abc123def456abc123def456abc123de")
    ).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/issues/?query=event.id:abc123def456abc123def456abc123de`
    );
  });

  test("buildLogsUrl uses path-based pattern", () => {
    expect(buildLogsUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/explore/logs/`
    );
  });

  test("buildTraceUrl uses path-based pattern", () => {
    expect(buildTraceUrl("my-org", "abc123def456abc123def456abc123de")).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/explore/traces/trace/abc123def456abc123def456abc123de/`
    );
  });

  test("buildDashboardsListUrl uses path-based pattern", () => {
    expect(buildDashboardsListUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/dashboards/`
    );
  });

  test("buildDashboardUrl uses path-based pattern", () => {
    expect(buildDashboardUrl("my-org", "42")).toBe(
      `${SELF_HOSTED_URL}/organizations/my-org/dashboard/42/`
    );
  });

  test("buildProjectUrl uses path-based pattern", () => {
    expect(buildProjectUrl("my-org", "my-project")).toBe(
      `${SELF_HOSTED_URL}/settings/my-org/projects/my-project/`
    );
  });

  test("buildOrgSettingsUrl uses path-based pattern", () => {
    expect(buildOrgSettingsUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/settings/my-org/`
    );
  });

  test("buildSeerSettingsUrl uses path-based pattern", () => {
    expect(buildSeerSettingsUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/settings/my-org/seer/`
    );
  });

  test("buildBillingUrl uses path-based pattern", () => {
    expect(buildBillingUrl("my-org")).toBe(
      `${SELF_HOSTED_URL}/settings/my-org/billing/overview/`
    );
  });

  test("no URL builder prepends org as subdomain", async () => {
    await fcAssert(
      property(
        tuple(slugArb, slugArb, eventIdArb),
        ([orgSlug, projectSlug, eventId]) => {
          const urls = [
            buildOrgUrl(orgSlug),
            buildProjectUrl(orgSlug, projectSlug),
            buildEventSearchUrl(orgSlug, eventId),
            buildOrgSettingsUrl(orgSlug),
            buildSeerSettingsUrl(orgSlug),
            buildBillingUrl(orgSlug),
            buildLogsUrl(orgSlug),
            buildTraceUrl(orgSlug, eventId),
            buildDashboardsListUrl(orgSlug),
            buildDashboardUrl(orgSlug, "1"),
          ];

          for (const url of urls) {
            const parsed = new URL(url);
            expect(parsed.hostname).toBe("sentry.company.com");
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("URL building cross-function properties", () => {
  test("all URL builders produce valid URLs", async () => {
    await fcAssert(
      property(
        tuple(slugArb, slugArb, eventIdArb, hashArb, productArb),
        ([orgSlug, projectSlug, eventId, hash, product]) => {
          const urls = [
            buildOrgUrl(orgSlug),
            buildProjectUrl(orgSlug, projectSlug),
            buildEventSearchUrl(orgSlug, eventId),
            buildOrgSettingsUrl(orgSlug),
            buildOrgSettingsUrl(orgSlug, hash),
            buildSeerSettingsUrl(orgSlug),
            buildBillingUrl(orgSlug),
            buildBillingUrl(orgSlug, product),
            buildDashboardsListUrl(orgSlug),
            buildDashboardUrl(orgSlug, "42"),
          ];

          for (const url of urls) {
            expect(() => new URL(url)).not.toThrow();
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all URL builders are deterministic", async () => {
    await fcAssert(
      property(
        tuple(slugArb, slugArb, eventIdArb, hashArb, productArb),
        ([orgSlug, projectSlug, eventId, hash, product]) => {
          expect(buildOrgUrl(orgSlug)).toBe(buildOrgUrl(orgSlug));
          expect(buildProjectUrl(orgSlug, projectSlug)).toBe(
            buildProjectUrl(orgSlug, projectSlug)
          );
          expect(buildEventSearchUrl(orgSlug, eventId)).toBe(
            buildEventSearchUrl(orgSlug, eventId)
          );
          expect(buildOrgSettingsUrl(orgSlug, hash)).toBe(
            buildOrgSettingsUrl(orgSlug, hash)
          );
          expect(buildSeerSettingsUrl(orgSlug)).toBe(
            buildSeerSettingsUrl(orgSlug)
          );
          expect(buildBillingUrl(orgSlug, product)).toBe(
            buildBillingUrl(orgSlug, product)
          );
          expect(buildDashboardsListUrl(orgSlug)).toBe(
            buildDashboardsListUrl(orgSlug)
          );
          expect(buildDashboardUrl(orgSlug, "42")).toBe(
            buildDashboardUrl(orgSlug, "42")
          );
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
