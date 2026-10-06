/**
 * Tests for human formatter detail functions
 *
 * These tests cover formatters that display detailed information about
 * organizations, projects, and issues. They use mock data objects.
 */

import { describe, expect, test } from "vitest";
import {
  formatEventDetails,
  formatFixability,
  formatFixabilityDetail,
  formatIssueDetails,
  formatOrgDetails,
  formatProjectDetails,
  getSeerFixabilityLabel,
} from "../../../src/lib/formatters/human.js";
import type {
  SentryEvent,
  SentryIssue,
  SentryOrganization,
  SentryProject,
} from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";

// Isolated per-test config dir so `resolveOrgDisplayName`'s cached-org lookup
// (via `getCachedOrganizations`) starts empty. Without this, an earlier test
// run in the same process could seed `org_regions` and mask the slug-fallback
// path below.
useTestConfigDir("human-details-");

// Helper to strip ANSI codes for content testing
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Mock data factories

function createMockOrg(
  overrides: Partial<SentryOrganization> = {}
): SentryOrganization {
  return {
    id: "123",
    slug: "acme-corp",
    name: "Acme Corporation",
    dateCreated: "2024-01-01T00:00:00Z",
    require2FA: false,
    isEarlyAdopter: false,
    features: [],
    ...overrides,
  };
}

function createMockProject(
  overrides: Partial<SentryProject & { orgSlug?: string }> = {}
): SentryProject & { orgSlug?: string } {
  return {
    id: "456",
    slug: "frontend",
    name: "Frontend App",
    platform: "javascript",
    status: "active",
    dateCreated: "2024-01-01T00:00:00Z",
    hasSessions: true,
    hasReplays: false,
    hasProfiles: false,
    hasMonitors: false,
    features: [],
    ...overrides,
  };
}

function createMockIssue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id: "789",
    shortId: "FRONTEND-ABC",
    title: "TypeError: Cannot read property 'foo' of undefined",
    level: "error",
    status: "unresolved",
    count: "42",
    userCount: 10,
    firstSeen: "2024-01-01T00:00:00Z",
    lastSeen: "2024-01-15T12:30:00Z",
    permalink: "https://sentry.io/issues/789",
    ...overrides,
  };
}

// Organization Formatting Tests

describe("formatOrgDetails", () => {
  test("formats basic organization details", () => {
    const org = createMockOrg({
      slug: "acme",
      name: "Acme Corp",
      id: "123",
      require2FA: true,
      isEarlyAdopter: true,
    });

    const result = stripAnsi(formatOrgDetails(org));
    const lines = result.split("\n");

    // Header contains slug and name
    expect(lines[0]).toContain("acme");
    expect(lines[0]).toContain("Acme Corp");

    // Table rows contain the right values
    expect(result).toContain("acme");
    expect(result).toContain("Acme Corp");
    expect(result).toContain("123");
    expect(result).toContain("Required");
    expect(result).toContain("Yes");
  });

  test("formats organization without 2FA", () => {
    const org = createMockOrg({ require2FA: false, isEarlyAdopter: false });
    const result = stripAnsi(formatOrgDetails(org));

    expect(result).toContain("Not required");
    expect(result).toContain("No");
  });

  test("includes features when present", () => {
    const org = createMockOrg({
      features: ["feature-a", "feature-b", "feature-c"],
    });
    const result = stripAnsi(formatOrgDetails(org));

    expect(result).toContain("Features");
    expect(result).toContain("feature-a");
  });

  test("handles missing dateCreated", () => {
    const org = createMockOrg({ dateCreated: undefined });
    // Should not throw
    const result = stripAnsi(formatOrgDetails(org));
    expect(result).not.toContain("Created");
  });
});

// Project Formatting Tests

describe("formatProjectDetails", () => {
  test("formats basic project details", () => {
    const project = createMockProject({
      slug: "frontend",
      name: "Frontend App",
      id: "456",
      platform: "javascript",
      status: "active",
    });

    const result = stripAnsi(formatProjectDetails(project));
    const lines = result.split("\n");

    // Header contains slug and name
    expect(lines[0]).toContain("frontend");
    expect(lines[0]).toContain("Frontend App");

    // Table rows contain the right values
    expect(result).toContain("frontend");
    expect(result).toContain("Frontend App");
    expect(result).toContain("456");
    expect(result).toContain("javascript");
    expect(result).toContain("active");
  });

  test("includes DSN when provided", () => {
    const project = createMockProject();
    const dsn = "https://abc123@sentry.io/456";

    const result = stripAnsi(formatProjectDetails(project, dsn));
    expect(result).toContain(dsn);
  });

  test("shows 'No DSN available' when DSN is null", () => {
    const project = createMockProject();

    const result = stripAnsi(formatProjectDetails(project, null));
    expect(result).toContain("No DSN available");
  });

  test("includes organization context when present", () => {
    const project = createMockProject({
      organization: { id: "1", slug: "acme", name: "Acme Corp" },
    });

    const result = stripAnsi(formatProjectDetails(project));
    expect(result).toContain("Acme Corp");
    expect(result).toContain("acme");
  });

  test("falls back to org slug when collapsed response omits name", () => {
    // `getProject()` passes `?collapse=organization` to save ~400-500ms,
    // which drops `organization.name`. `formatProjectDetails` must still
    // render a reasonable Organization row. With no cached org name
    // available (empty config dir + no seeded org_regions), the slug is
    // the last-resort fallback.
    const project = createMockProject({
      organization: { id: "1", slug: "acme-only-slug" },
    });

    const result = stripAnsi(formatProjectDetails(project));

    // Organization row renders the slug twice — once as the display name
    // (fallback when no cached name exists) and once inside the parens
    // as the raw slug identifier. Matching both positions guarantees the
    // fallback actually fired; a stray cached name would show up between
    // the "Organization" label and `(acme-only-slug)`.
    // Renders as `Organization │ acme-only-slug (acme-only-slug)` (box-drawing
    // separator). Matching both positions guarantees the fallback actually
    // fired; a stray cached display name would show up between the
    // "Organization" label and `(acme-only-slug)`.
    expect(result).toMatch(
      /Organization\s*\S\s*acme-only-slug\s*\(\s*acme-only-slug\s*\)/
    );
  });

  test("includes capability flags", () => {
    const project = createMockProject({
      hasSessions: true,
      hasReplays: true,
      hasProfiles: false,
      hasMonitors: true,
    });

    const result = stripAnsi(formatProjectDetails(project));
    expect(result).toContain("Sessions");
    expect(result).toContain("Replays");
    expect(result).toContain("Profiles");
    expect(result).toContain("Monitors");
  });

  test("handles missing firstEvent", () => {
    const project = createMockProject({ firstEvent: undefined });
    const result = stripAnsi(formatProjectDetails(project));
    expect(result).toContain("No events yet");
  });

  test("formats firstEvent date when present", () => {
    const project = createMockProject({
      firstEvent: "2024-06-15T10:30:00Z",
    });
    const result = stripAnsi(formatProjectDetails(project));
    // Should contain year (locale-dependent format)
    expect(result).toContain("2024");
  });
});

// Issue Formatting Tests

describe("formatIssueDetails", () => {
  test("formats basic issue details", () => {
    const issue = createMockIssue({
      shortId: "PROJ-ABC",
      title: "Test Error",
      status: "unresolved",
      level: "error",
      count: "100",
      userCount: 25,
    });

    const result = stripAnsi(formatIssueDetails(issue));
    const lines = result.split("\n");

    // Header contains shortId and title
    expect(lines[0]).toContain("PROJ-ABC");
    expect(lines[0]).toContain("Test Error");

    // Table contains key fields
    expect(result).toContain("Status");
    expect(result).toContain("Level");
    expect(result).toContain("error");
    expect(result).toContain("100");
    expect(result).toContain("25");
  });

  test("includes substatus when present", () => {
    const issue = createMockIssue({
      status: "unresolved",
      substatus: "ongoing",
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Ongoing");
  });

  test("includes priority when present", () => {
    const issue = createMockIssue({ priority: "high" });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Priority");
    expect(result).toContain("High");
  });

  test("shows unhandled indicator", () => {
    const issue = createMockIssue({ isUnhandled: true });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("unhandled");
  });

  test("includes project info when present", () => {
    const issue = createMockIssue({
      project: { slug: "frontend", name: "Frontend App" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Frontend App");
    expect(result).toContain("frontend");
  });

  test("formats single release correctly", () => {
    const issue = createMockIssue({
      firstRelease: { shortVersion: "1.0.0" },
      lastRelease: { shortVersion: "1.0.0" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("1.0.0");
    expect(result).toContain("Release");
  });

  test("formats release range when different", () => {
    const issue = createMockIssue({
      firstRelease: { shortVersion: "1.0.0" },
      lastRelease: { shortVersion: "2.0.0" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("1.0.0");
    expect(result).toContain("2.0.0");
    expect(result).toContain("→");
  });

  test("includes assignee name", () => {
    const issue = createMockIssue({
      assignedTo: { name: "John Doe" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("John Doe");
  });

  test("shows Unassigned when no assignee", () => {
    const issue = createMockIssue({ assignedTo: undefined });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Unassigned");
  });

  test("includes culprit when present", () => {
    const issue = createMockIssue({ culprit: "app.js in handleClick" });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("app.js in handleClick");
  });

  test("includes metadata message when present", () => {
    const issue = createMockIssue({
      metadata: { value: "Cannot read property 'x' of null" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Message");
    expect(result).toContain("Cannot read property");
  });

  test("includes metadata filename and function", () => {
    const issue = createMockIssue({
      metadata: { filename: "src/app.js", function: "handleClick" },
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("src/app.js");
    expect(result).toContain("handleClick");
  });

  test("includes permalink", () => {
    const issue = createMockIssue({
      permalink: "https://sentry.io/issues/123",
    });

    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("https://sentry.io/issues/123");
  });

  test("handles missing optional fields gracefully", () => {
    const issue = createMockIssue({
      platform: undefined,
      type: undefined,
      priority: undefined,
      substatus: undefined,
      isUnhandled: undefined,
      project: undefined,
      firstRelease: undefined,
      lastRelease: undefined,
      culprit: undefined,
      metadata: undefined,
    });

    // Should not throw
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result.length).toBeGreaterThan(50);
    expect(result).toContain("Platform");
    expect(result).toContain("unknown");
    expect(result).toContain("Type");
  });

  test("includes fixability with percentage when seerFixabilityScore is present", () => {
    const issue = createMockIssue({ seerFixabilityScore: 0.7 });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Fixability");
    expect(result).toContain("High");
    expect(result).toContain("70%");
  });

  test("omits fixability when seerFixabilityScore is null", () => {
    const issue = createMockIssue({ seerFixabilityScore: null });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).not.toContain("Fixability");
  });

  test("omits fixability when seerFixabilityScore is undefined", () => {
    const issue = createMockIssue({ seerFixabilityScore: undefined });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).not.toContain("Fixability");
  });

  test("shows med label for medium score", () => {
    const issue = createMockIssue({ seerFixabilityScore: 0.5 });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Fixability");
    expect(result).toContain("Med");
    expect(result).toContain("50%");
  });

  test("shows low label for low score", () => {
    const issue = createMockIssue({ seerFixabilityScore: 0.1 });
    const result = stripAnsi(formatIssueDetails(issue));
    expect(result).toContain("Fixability");
    expect(result).toContain("Low");
    expect(result).toContain("10%");
  });
});

// Seer Fixability Tests

describe("getSeerFixabilityLabel", () => {
  test("returns high for scores above 0.66", () => {
    expect(getSeerFixabilityLabel(0.67)).toBe("high");
    expect(getSeerFixabilityLabel(0.99)).toBe("high");
    expect(getSeerFixabilityLabel(0.8)).toBe("high");
  });

  test("returns med for scores between 0.33 and 0.66", () => {
    expect(getSeerFixabilityLabel(0.66)).toBe("med");
    expect(getSeerFixabilityLabel(0.5)).toBe("med");
    expect(getSeerFixabilityLabel(0.34)).toBe("med");
  });

  test("returns low for scores at or below 0.33", () => {
    expect(getSeerFixabilityLabel(0.33)).toBe("low");
    expect(getSeerFixabilityLabel(0.1)).toBe("low");
    expect(getSeerFixabilityLabel(0)).toBe("low");
  });

  test("handles extreme boundary values", () => {
    expect(getSeerFixabilityLabel(1)).toBe("high");
    expect(getSeerFixabilityLabel(0)).toBe("low");
  });
});

describe("formatFixability", () => {
  test("formats score as label(pct%)", () => {
    expect(formatFixability(0.5)).toBe("med(50%)");
    expect(formatFixability(0.8)).toBe("high(80%)");
    expect(formatFixability(0.2)).toBe("low(20%)");
  });

  test("rounds percentage to nearest integer", () => {
    expect(formatFixability(0.495)).toBe("med(50%)");
    expect(formatFixability(0.333)).toBe("med(33%)");
  });

  test("handles boundary values", () => {
    expect(formatFixability(0)).toBe("low(0%)");
    expect(formatFixability(1)).toBe("high(100%)");
  });

  test("max output fits within column width", () => {
    // "high(100%)" = 10 chars, matching COL_FIX
    expect(formatFixability(1).length).toBeLessThanOrEqual(10);
  });

  test("returns empty string for null or undefined", () => {
    expect(formatFixability(null)).toBe("");
    expect(formatFixability(undefined)).toBe("");
  });
});

describe("formatFixabilityDetail", () => {
  test("formats with capitalized label and space", () => {
    expect(formatFixabilityDetail(0.5)).toBe("Med (50%)");
    expect(formatFixabilityDetail(0.8)).toBe("High (80%)");
    expect(formatFixabilityDetail(0.2)).toBe("Low (20%)");
  });

  test("handles boundary values", () => {
    expect(formatFixabilityDetail(0)).toBe("Low (0%)");
    expect(formatFixabilityDetail(1)).toBe("High (100%)");
  });

  test("returns empty string for null or undefined", () => {
    expect(formatFixabilityDetail(null)).toBe("");
    expect(formatFixabilityDetail(undefined)).toBe("");
  });
});

// Event Formatting Tests

function createMockEvent(overrides: Partial<SentryEvent> = {}): SentryEvent {
  return {
    eventID: "abc123def456abc7890",
    dateReceived: "2024-01-15T12:30:00Z",
    ...overrides,
  };
}

describe("formatEventDetails", () => {
  test("returns a string", () => {
    const result = formatEventDetails(createMockEvent());
    expect(typeof result).toBe("string");
  });

  test("includes event ID in header", () => {
    const result = stripAnsi(formatEventDetails(createMockEvent()));
    expect(result).toContain("abc123de");
  });

  test("includes custom header text", () => {
    const result = stripAnsi(
      formatEventDetails(createMockEvent(), "My Custom Header")
    );
    expect(result).toContain("My Custom Header");
  });

  test("includes event ID and received date", () => {
    const result = stripAnsi(formatEventDetails(createMockEvent()));
    expect(result).toContain("abc123def456abc7890");
    expect(result).toContain("Event ID");
    expect(result).toContain("Received");
  });

  test("includes location when present", () => {
    const result = stripAnsi(
      formatEventDetails(createMockEvent({ location: "app/main.py" }))
    );
    expect(result).toContain("Location");
    expect(result).toContain("app/main.py");
  });

  test("includes trace context when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          contexts: { trace: { trace_id: "aabbccdd11223344" } },
        })
      )
    );
    expect(result).toContain("Trace");
    expect(result).toContain("aabbccdd11223344");
  });

  test("includes SDK info when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          sdk: { name: "sentry.javascript.browser", version: "7.0.0" },
        })
      )
    );
    expect(result).toContain("SDK");
    expect(result).toContain("sentry.javascript.browser");
    expect(result).toContain("7.0.0");
  });

  test("includes release when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          release: { version: "1.0.0", shortVersion: "1.0.0" },
        })
      )
    );
    expect(result).toContain("Release");
    expect(result).toContain("1.0.0");
  });

  test("includes user section when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          user: {
            email: "test@example.com",
            username: "testuser",
            id: "42",
            ip_address: "192.168.1.1",
          },
        })
      )
    );
    expect(result).toContain("User");
    expect(result).toContain("test@example.com");
    expect(result).toContain("testuser");
    expect(result).toContain("192.168.1.1");
  });

  test("includes user geo when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          user: {
            email: "test@example.com",
            geo: { city: "Berlin", region: "Berlin", country_code: "DE" },
          },
        })
      )
    );
    expect(result).toContain("Location");
    expect(result).toContain("Berlin");
    expect(result).toContain("DE");
  });

  test("includes environment contexts when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          contexts: {
            browser: { name: "Chrome", version: "120.0" },
            os: { name: "Windows", version: "11" },
            device: { family: "Desktop", brand: "Apple" },
          },
        })
      )
    );
    expect(result).toContain("Environment");
    expect(result).toContain("Chrome");
    expect(result).toContain("Windows");
    expect(result).toContain("Desktop");
  });

  test("includes request section when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "request",
              data: {
                url: "https://api.example.com/users",
                method: "POST",
                headers: [["User-Agent", "Mozilla/5.0"]],
              },
            },
          ],
        })
      )
    );
    expect(result).toContain("Request");
    expect(result).toContain("POST https://api.example.com/users");
    expect(result).toContain("Mozilla/5.0");
  });

  test("includes stack trace when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    type: "TypeError",
                    value: "Cannot read property",
                    mechanism: { type: "generic", handled: false },
                    stacktrace: {
                      frames: [
                        {
                          function: "handleClick",
                          filename: "app.js",
                          lineNo: 42,
                          colNo: 10,
                          inApp: true,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );
    expect(result).toContain("Stack Trace");
    expect(result).toContain("TypeError: Cannot read property");
    expect(result).toContain("handleClick");
    expect(result).toContain("app.js");
    expect(result).toContain("[in-app]");
    expect(result).toContain("unhandled");
  });

  test("includes stack frame code context when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    type: "Error",
                    value: "fail",
                    stacktrace: {
                      frames: [
                        {
                          function: "foo",
                          filename: "bar.js",
                          lineNo: 10,
                          colNo: 1,
                          context: [
                            [9, "  const x = 1;"],
                            [10, '  throw new Error("fail");'],
                            [11, "}"],
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );
    expect(result).toContain("const x = 1");
    expect(result).toContain("throw new Error");
  });

  test("includes breadcrumbs when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "breadcrumbs",
              data: {
                values: [
                  {
                    timestamp: "2024-01-15T12:29:55Z",
                    level: "info",
                    category: "navigation",
                    message: "User clicked button",
                  },
                  {
                    timestamp: "2024-01-15T12:30:00Z",
                    level: "error",
                    category: "http",
                    data: {
                      url: "https://api.example.com/data",
                      method: "GET",
                      status_code: 500,
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );
    expect(result).toContain("Breadcrumbs");
    expect(result).toContain("navigation");
    expect(result).toContain("User clicked button");
    expect(result).toContain("GET");
    expect(result).toContain("500");
  });

  test("includes replay link when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          tags: [
            {
              key: "replayId",
              value: "346789a703f6454384f1de473b8b9fcc",
            },
          ],
        }),
        "Latest Event",
        "https://acme.sentry.io/issues/789/"
      )
    );
    expect(result).toContain("Replay");
    expect(result).toContain("346789a703f6454384f1de473b8b9fcc");
    expect(result).toContain(
      "https://acme.sentry.io/explore/replays/346789a703f6454384f1de473b8b9fcc/"
    );
  });

  test("includes replay link from replay.id tag", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          tags: [
            {
              key: "replay.id",
              value: "346789a703f6454384f1de473b8b9fcc",
            },
          ],
        }),
        "Latest Event",
        "https://acme.sentry.io/issues/789/"
      )
    );
    expect(result).toContain("346789a703f6454384f1de473b8b9fcc");
  });

  test("includes replay link from replay context", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          contexts: {
            replay: { replay_id: "346789a703f6454384f1de473b8b9fcc" },
          },
          tags: [],
        }),
        "Latest Event",
        "https://acme.sentry.io/issues/789/"
      )
    );
    expect(result).toContain("346789a703f6454384f1de473b8b9fcc");
  });

  test("includes tags when present", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          tags: [
            { key: "browser", value: "Chrome 120" },
            { key: "os", value: "Windows 11" },
          ],
        })
      )
    );
    expect(result).toContain("Tags");
    expect(result).toContain("browser");
    expect(result).toContain("Chrome 120");
  });

  test("handles minimal event", () => {
    const result = formatEventDetails(
      createMockEvent({ dateReceived: undefined })
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("handles breadcrumb navigation data", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "breadcrumbs",
              data: {
                values: [
                  {
                    category: "navigation",
                    data: { from: "/home", to: "/profile" },
                  },
                ],
              },
            },
          ],
        })
      )
    );
    expect(result).toContain("/home");
    expect(result).toContain("/profile");
  });

  test("truncates long breadcrumb messages", () => {
    const longMsg = "X".repeat(100);
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [
            {
              type: "breadcrumbs",
              data: {
                values: [
                  { category: "console", message: longMsg, level: "info" },
                ],
              },
            },
          ],
        })
      )
    );
    expect(result).not.toContain(longMsg);
    expect(result).toContain("...");
  });

  test("skips empty breadcrumbs array", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [{ type: "breadcrumbs", data: { values: [] } }],
        })
      )
    );
    expect(result).not.toContain("Breadcrumbs");
  });

  test("shows user name when available", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          user: { name: "John Doe" },
        })
      )
    );
    expect(result).toContain("Name");
    expect(result).toContain("John Doe");
  });

  test("skips user section when user has no data", () => {
    const result = stripAnsi(formatEventDetails(createMockEvent({ user: {} })));
    expect(result).not.toContain("User");
  });

  test("skips environment section when no contexts", () => {
    const result = stripAnsi(
      formatEventDetails(createMockEvent({ contexts: null }))
    );
    expect(result).not.toContain("Environment");
  });

  test("skips request section when no URL", () => {
    const result = stripAnsi(
      formatEventDetails(
        createMockEvent({
          entries: [{ type: "request", data: {} }],
        })
      )
    );
    expect(result).not.toContain("Request");
  });
});
