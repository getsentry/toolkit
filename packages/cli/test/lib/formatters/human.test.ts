/**
 * Tests for human-readable formatters
 *
 * Note: Core invariants (uppercase, length preservation, determinism) are tested
 * via property-based tests in human.property.test.ts. These tests focus on
 * specific edge cases and environment-dependent behavior.
 */

import { describe, expect, test } from "vitest";
import {
  extractStatsPoints,
  formatDashboardCreated,
  formatIssueSubtitle,
  formatProjectCreated,
  formatShortId,
  formatStatusIcon,
  formatStatusLabel,
  formatUpgradeResult,
  formatUserIdentity,
  type IssueTableRow,
  type ProjectCreatedResult,
  substatusLabel,
  writeIssueTable,
} from "../../../src/lib/formatters/human.js";
import type { SentryIssue } from "../../../src/types/index.js";

// Helper to strip ANSI codes for content testing
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Strip ANSI escape codes and color tags for content testing. */
function stripFormatting(s: string): string {
  return (
    s
      .replace(/<\/?[a-z]+>/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
      .replace(/\x1b\[[0-9;]*m/g, "")
  );
}

describe("formatShortId edge cases", () => {
  test("handles empty options object", () => {
    expect(stripFormatting(formatShortId("CRAFT-G", {}))).toBe("CRAFT-G");
  });

  test("handles undefined options", () => {
    expect(stripFormatting(formatShortId("CRAFT-G", undefined))).toBe(
      "CRAFT-G"
    );
  });

  test("handles mismatched project slug gracefully", () => {
    const result = formatShortId("CRAFT-G", { projectSlug: "other" });
    expect(stripFormatting(result)).toBe("CRAFT-G");
  });

  test("handles legacy string parameter", () => {
    const result = formatShortId("CRAFT-G", "craft");
    expect(stripFormatting(result)).toBe("CRAFT-G");
  });
});

describe("formatShortId formatting", () => {
  test("single project mode applies formatting to suffix", () => {
    const result = formatShortId("CRAFT-G", { projectSlug: "craft" });
    expect(stripFormatting(result)).toBe("CRAFT-G");
    // Suffix should be wrapped in bold+underline tag
    expect(result).toContain("<bu>G</bu>");
  });

  test("multi-project mode applies formatting to suffix", () => {
    const result = formatShortId("SPOTLIGHT-ELECTRON-4Y", {
      projectSlug: "spotlight-electron",
      projectAlias: "e",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("SPOTLIGHT-ELECTRON-4Y");
    // Alias char and suffix should be bold+underlined
    expect(result).toContain("<bu>E</bu>");
    expect(result).toContain("<bu>4Y</bu>");
  });

  test("no formatting when no options provided", () => {
    const result = formatShortId("CRAFT-G");
    expect(result).toBe("CRAFT-G");
    expect(result).toBe(stripFormatting(result));
  });
});

describe("formatShortId multi-project alias highlighting", () => {
  // These tests verify the highlighting logic finds the correct part to highlight.
  // Content is always verified (ANSI codes stripped); formatting presence depends on FORCE_COLOR.

  test("highlights rightmost matching part for ambiguous aliases", () => {
    // Bug fix: For projects api-app, api-admin with aliases ap, ad
    // API-APP-5 with alias "ap" should highlight APP (not API)
    const result = formatShortId("API-APP-5", {
      projectAlias: "ap",
      isMultiProject: true,
    });
    // Content is always correct - the text should be unchanged
    expect(stripFormatting(result)).toBe("API-APP-5");
  });

  test("highlights alias with embedded dash correctly", () => {
    // Bug fix: For projects x-ab, xyz with aliases x-a, xy
    // X-AB-5 with alias "x-a" should highlight X-A (joined project portion)
    const result = formatShortId("X-AB-5", {
      projectAlias: "x-a",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("X-AB-5");
  });

  test("highlights single char alias at start of multi-part short ID", () => {
    // CLI-WEBSITE-4 with alias "w" should highlight W in WEBSITE (not CLI)
    const result = formatShortId("CLI-WEBSITE-4", {
      projectAlias: "w",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("CLI-WEBSITE-4");
  });

  test("highlights single char alias in simple short ID", () => {
    // CLI-25 with alias "c" should highlight C in CLI
    const result = formatShortId("CLI-25", {
      projectAlias: "c",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("CLI-25");
  });

  test("handles org-prefixed alias format", () => {
    // Alias "o1/d" should use "d" for matching against DASHBOARD-A3
    const result = formatShortId("DASHBOARD-A3", {
      projectAlias: "o1/d",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("DASHBOARD-A3");
  });

  test("falls back gracefully when alias doesn't match", () => {
    // If alias doesn't match any part, return plain text
    const result = formatShortId("CLI-25", {
      projectAlias: "xyz",
      isMultiProject: true,
    });
    expect(stripFormatting(result)).toBe("CLI-25");
  });
});

/** Capture stdout writes for table output testing */
function capture(): {
  writer: { write: (s: string) => boolean };
  output: () => string;
} {
  let buf = "";
  return {
    writer: {
      write: (s: string) => {
        buf += s;
        return true;
      },
    },
    output: () => buf,
  };
}

describe("writeIssueTable", () => {
  const mockIssue: SentryIssue = {
    id: "123",
    shortId: "DASHBOARD-A3",
    title: "Test issue",
    level: "error",
    status: "unresolved",
    count: "42",
    userCount: 10,
    firstSeen: "2024-01-01T00:00:00Z",
    lastSeen: "2024-01-02T00:00:00Z",
    permalink: "https://sentry.io/issues/123",
  };

  test("single project mode shows short ID without alias subtitle", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: mockIssue,
        orgSlug: "test-org",
        formatOptions: { projectSlug: "dashboard" },
      },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    expect(text).not.toContain("ALIAS");
    expect(text).toContain("DASHBOARD-");
    expect(text).toContain("A3");
    expect(text).toContain("Test issue");
  });

  test("multi-project mode shows alias alongside SHORT ID", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: mockIssue,
        orgSlug: "test-org",
        formatOptions: {
          projectSlug: "dashboard",
          projectAlias: "o1:d",
          isMultiProject: true,
        },
      },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    // No separate ALIAS column header
    expect(text).not.toContain("ALIAS");
    // Alias shorthand appears alongside SHORT ID on the same line
    expect(text).toContain("o1:d-a3");
  });

  test("table contains all essential columns", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: mockIssue,
        orgSlug: "test-org",
        formatOptions: { projectSlug: "dashboard" },
      },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    // Column set matching Sentry web UI
    for (const col of [
      "SHORT ID",
      "ISSUE",
      "SEEN",
      "AGE",
      "EVENTS",
      "USERS",
      "TRIAGE",
    ]) {
      expect(text).toContain(col);
    }
    // Old/removed columns should not appear
    for (const col of [
      "LEVEL",
      "FIXABILITY",
      "TITLE",
      "GRAPH",
      "ALIAS",
      "ASSIGNEE",
      "PRIORITY",
    ]) {
      expect(text).not.toContain(col);
    }
    // COUNT was renamed to EVENTS
    expect(text).not.toContain(" COUNT ");
  });

  test("issue title and event count appear in output", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      { issue: mockIssue, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    expect(text).toContain("Test issue");
    expect(text).toContain("42");
  });

  test("substatus label appears in TREND column on wide terminals", () => {
    const { writer, output } = capture();
    const issueWithSubstatus: SentryIssue = {
      ...mockIssue,
      substatus: "regressed",
    };
    const rows: IssueTableRow[] = [
      { issue: issueWithSubstatus, orgSlug: "test-org", formatOptions: {} },
    ];
    // TREND column requires terminal width >= 100
    const saved = process.stdout.columns;
    process.stdout.columns = 200;
    try {
      writeIssueTable(writer, rows);
    } finally {
      process.stdout.columns = saved;
    }
    const text = stripAnsi(output());
    expect(text).toContain("Regressed");
    expect(text).toContain("Test issue");
  });

  test("default mode shows title and subtitle (2-line)", () => {
    // Use a wide terminal so the subtitle doesn't get truncated by column fitting
    const savedCols = process.stdout.columns;
    process.stdout.columns = 200;
    try {
      const { writer, output } = capture();
      const issueWithMeta: SentryIssue = {
        ...mockIssue,
        metadata: { value: "Cannot read property 'x' of null" },
      };
      const rows: IssueTableRow[] = [
        { issue: issueWithMeta, orgSlug: "test-org", formatOptions: {} },
      ];
      writeIssueTable(writer, rows);
      const text = stripAnsi(output());
      expect(text).toContain("Test issue");
      expect(text).toContain("Cannot read property");
    } finally {
      process.stdout.columns = savedCols;
    }
  });

  test("compact mode shows title only, no subtitle", () => {
    const { writer, output } = capture();
    const issueWithMeta: SentryIssue = {
      ...mockIssue,
      metadata: { value: "Cannot read property 'x' of null" },
    };
    const rows: IssueTableRow[] = [
      { issue: issueWithMeta, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows, { compact: true });
    const text = stripAnsi(output());
    expect(text).toContain("Test issue");
    expect(text).not.toContain("Cannot read property");
  });

  test("user count appears in USERS column", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      { issue: mockIssue, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    expect(text).toContain("10");
  });

  test("priority appears in TRIAGE column", () => {
    const { writer, output } = capture();
    const issueWithPriority: SentryIssue = {
      ...mockIssue,
      priority: "high",
    };
    const rows: IssueTableRow[] = [
      { issue: issueWithPriority, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    expect(text).toContain("High");
    expect(text).toContain("TRIAGE");
  });

  test("triage shows priority label with composite score", () => {
    const { writer, output } = capture();
    const issueWithBoth: SentryIssue = {
      ...mockIssue,
      priority: "high",
      seerFixabilityScore: 0.85,
    };
    const rows: IssueTableRow[] = [
      { issue: issueWithBoth, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    // high=0.75*0.6 + 0.85*0.4 = 0.45+0.34 = 0.79 → 79%
    expect(text).toContain("High");
    expect(text).toContain("79%");
  });

  test("triage shows only priority label without fixability", () => {
    const { writer, output } = capture();
    const issuePriorityOnly: SentryIssue = {
      ...mockIssue,
      priority: "medium",
    };
    const rows: IssueTableRow[] = [
      { issue: issuePriorityOnly, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    expect(text).toContain("Med");
    expect(text).not.toContain("%");
  });

  test("triage shows only composite score without priority", () => {
    const { writer, output } = capture();
    const issueFixOnly: SentryIssue = {
      ...mockIssue,
      seerFixabilityScore: 0.75,
    };
    const rows: IssueTableRow[] = [
      { issue: issueFixOnly, orgSlug: "test-org", formatOptions: {} },
    ];
    writeIssueTable(writer, rows);
    const text = stripAnsi(output());
    // default impact (0.5)*0.6 + 0.75*0.4 = 0.30+0.30 = 0.60 → 60%
    expect(text).toContain("60%");
  });

  test("renders table with null lastSeen and firstSeen (covers ?? null branches)", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: {
          ...mockIssue,
          lastSeen: null as unknown as string,
          firstSeen: null as unknown as string,
        },
        orgSlug: "test-org",
        formatOptions: { projectSlug: "dashboard" },
      },
    ];
    writeIssueTable(writer, rows);
    // Should render without throwing; SEEN/AGE columns receive undefined
    expect(stripAnsi(output())).toContain("Test issue");
  });
});

describe("substatusLabel", () => {
  test("regressed returns colored label", () => {
    expect(stripFormatting(substatusLabel("regressed"))).toBe("Regressed");
  });

  test("escalating returns colored label", () => {
    expect(stripFormatting(substatusLabel("escalating"))).toBe("Escalating");
  });

  test("new returns colored label", () => {
    expect(stripFormatting(substatusLabel("new"))).toBe("New");
  });

  test("ongoing returns muted label", () => {
    expect(stripFormatting(substatusLabel("ongoing"))).toBe("Ongoing");
  });

  test("null returns empty string", () => {
    expect(substatusLabel(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(substatusLabel(undefined)).toBe("");
  });
});

describe("formatIssueSubtitle", () => {
  test("returns empty string for undefined metadata", () => {
    expect(formatIssueSubtitle(undefined)).toBe("");
  });

  test("returns empty string for empty metadata", () => {
    expect(formatIssueSubtitle({})).toBe("");
  });

  test("returns value when present", () => {
    expect(formatIssueSubtitle({ value: "Some error message" })).toBe(
      "Some error message"
    );
  });

  test("collapses whitespace in multi-line values", () => {
    const multiLine = "Error on line 1\n\nDetails on line 3\n  indented";
    const result = formatIssueSubtitle({ value: multiLine });
    expect(result).toBe("Error on line 1 Details on line 3 indented");
  });

  test("preserves long values without truncation", () => {
    const longValue = "A".repeat(200);
    const result = formatIssueSubtitle({ value: longValue });
    expect(result).toBe(longValue);
  });

  test("falls back to type + function", () => {
    expect(
      formatIssueSubtitle({ type: "TypeError", function: "handleClick" })
    ).toBe("TypeError in handleClick");
  });

  test("returns type alone when no function", () => {
    expect(formatIssueSubtitle({ type: "TypeError" })).toBe("TypeError");
  });

  test("prefers value over type + function", () => {
    expect(
      formatIssueSubtitle({
        value: "Error msg",
        type: "TypeError",
        function: "fn",
      })
    ).toBe("Error msg");
  });
});

describe("extractStatsPoints", () => {
  test("returns empty array for undefined stats", () => {
    expect(extractStatsPoints(undefined)).toEqual([]);
  });

  test("returns empty array for empty stats", () => {
    expect(extractStatsPoints({})).toEqual([]);
  });

  test("extracts counts from time-series buckets", () => {
    const stats = {
      "24h": [
        [1_700_000_000, 5],
        [1_700_003_600, 10],
        [1_700_007_200, 3],
      ],
    };
    expect(extractStatsPoints(stats)).toEqual([5, 10, 3]);
  });

  test("handles non-array stats values", () => {
    expect(extractStatsPoints({ "24h": "not-an-array" })).toEqual([]);
  });

  test("handles malformed bucket entries", () => {
    const stats = {
      auto: [[1_700_000_000], [1_700_003_600, 5], "bad", [1_700_007_200, 3]],
    };
    expect(extractStatsPoints(stats)).toEqual([0, 5, 0, 3]);
  });
});

describe("formatUserIdentity API shapes", () => {
  // Note: Core behavior is tested via property-based tests.
  // These tests verify specific API contract shapes.

  test("handles UserInfo shape (from database)", () => {
    const result = formatUserIdentity({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
      name: "Test User",
    });
    expect(result).toBe("Test User <test@example.com>");
  });

  test("handles UserInfo without name", () => {
    const result = formatUserIdentity({
      userId: "12345",
      email: "test@example.com",
      username: "testuser",
    });
    expect(result).toBe("testuser <test@example.com>");
  });

  test("handles token response user with id field", () => {
    const result = formatUserIdentity({
      id: "67890",
      name: "OAuth User",
      email: "oauth@example.com",
    });
    expect(result).toBe("OAuth User <oauth@example.com>");
  });
});

describe("writeIssueTable priority labels", () => {
  const baseMockIssue: SentryIssue = {
    id: "1",
    shortId: "TEST-1",
    title: "Test",
    culprit: "",
    permalink: "https://sentry.io/issues/1/",
    status: "unresolved",
    level: "error",
    count: "1",
    userCount: 0,
    firstSeen: "2024-01-01T00:00:00Z",
    lastSeen: "2024-01-01T00:00:00Z",
    metadata: {},
  };

  test("critical priority renders in triage column", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: { ...baseMockIssue, priority: "critical" },
        orgSlug: "org",
        formatOptions: {},
      },
    ];
    writeIssueTable(writer, rows);
    expect(stripAnsi(output())).toContain("Critical");
  });

  test("low priority renders in triage column", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: { ...baseMockIssue, priority: "low" },
        orgSlug: "org",
        formatOptions: {},
      },
    ];
    writeIssueTable(writer, rows);
    expect(stripAnsi(output())).toContain("Low");
  });

  test("unknown priority renders raw value", () => {
    const { writer, output } = capture();
    const rows: IssueTableRow[] = [
      {
        issue: { ...baseMockIssue, priority: "urgent" },
        orgSlug: "org",
        formatOptions: {},
      },
    ];
    writeIssueTable(writer, rows);
    expect(stripAnsi(output())).toContain("urgent");
  });
});

describe("formatProjectCreated", () => {
  const baseResult: ProjectCreatedResult = {
    project: {
      id: "42",
      name: "My Project",
      slug: "my-project",
      platform: "javascript",
    } as ProjectCreatedResult["project"],
    orgSlug: "my-org",
    teamSlug: "my-team",
    teamSource: "explicit",
    requestedPlatform: "javascript",
    dsn: "https://abc@o123.ingest.us.sentry.io/456",
    url: "https://my-org.sentry.io/settings/projects/my-project/",
    slugDiverged: false,
    expectedSlug: "my-project",
  };

  test("includes project name and org in heading", () => {
    const result = stripAnsi(formatProjectCreated(baseResult));
    expect(result).toContain("My Project");
    expect(result).toContain("my-org");
  });

  test("includes DSN when provided", () => {
    const result = stripAnsi(formatProjectCreated(baseResult));
    expect(result).toContain("abc@o123.ingest.us.sentry.io");
  });

  test("omits DSN row when null", () => {
    const result = stripAnsi(
      formatProjectCreated({ ...baseResult, dsn: null })
    );
    expect(result).not.toContain("DSN");
  });

  test("shows slug divergence note", () => {
    const result = stripAnsi(
      formatProjectCreated({
        ...baseResult,
        slugDiverged: true,
        project: {
          ...baseResult.project,
          slug: "my-project-1",
        } as ProjectCreatedResult["project"],
        expectedSlug: "my-project",
      })
    );
    expect(result).toContain("my-project-1");
    expect(result).toContain("already taken");
  });

  test("shows auto-created team note", () => {
    const result = stripAnsi(
      formatProjectCreated({ ...baseResult, teamSource: "auto-created" })
    );
    expect(result).toContain("Created team");
    expect(result).toContain("my-team");
  });

  test("shows auto-selected team note", () => {
    const result = stripAnsi(
      formatProjectCreated({ ...baseResult, teamSource: "auto-selected" })
    );
    expect(result).toContain("Using team");
    expect(result).toContain("sentry team list");
  });

  test("uses requestedPlatform as fallback when project.platform is empty", () => {
    const result = stripAnsi(
      formatProjectCreated({
        ...baseResult,
        project: {
          ...baseResult.project,
          platform: "",
        } as ProjectCreatedResult["project"],
      })
    );
    expect(result).toContain("javascript");
  });

  test("includes tip with project view command", () => {
    const result = stripAnsi(formatProjectCreated(baseResult));
    expect(result).toContain("sentry project view my-org/my-project");
  });
});

describe("formatDashboardCreated", () => {
  test("output contains title, ID, and URL", () => {
    const result = stripAnsi(
      formatDashboardCreated({
        id: "42",
        title: "My Dashboard",
        url: "https://acme.sentry.io/dashboard/42/",
      })
    );
    expect(result).toContain("My Dashboard");
    expect(result).toContain("42");
    expect(result).toContain("https://acme.sentry.io/dashboard/42/");
  });

  test("title with special chars is escaped", () => {
    const result = stripAnsi(
      formatDashboardCreated({
        id: "1",
        title: "Dash | with * special",
        url: "https://acme.sentry.io/dashboard/1/",
      })
    );
    expect(result).toContain("Dash");
    expect(result).toContain("special");
  });
});

describe("formatUpgradeResult", () => {
  // Force plain output so we get raw markdown (no ANSI codes)
  const origPlain = process.env.SENTRY_PLAIN_OUTPUT;
  function withPlain(fn: () => void) {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    try {
      fn();
    } finally {
      if (origPlain === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = origPlain;
      }
    }
  }

  test("renders compact metadata line with method and channel", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "upgraded",
        currentVersion: "0.5.0",
        targetVersion: "0.6.0",
        channel: "stable",
        method: "curl",
        forced: false,
      });
      expect(result).toContain("Method: curl");
      expect(result).toContain("Channel: stable");
    });
  });

  test("includes from-version in upgraded action", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "upgraded",
        currentVersion: "0.5.0",
        targetVersion: "0.6.0",
        channel: "stable",
        method: "curl",
        forced: false,
      });
      expect(result).toContain("Upgraded to");
      expect(result).toContain("0.6.0");
      expect(result).toContain("(from 0.5.0)");
    });
  });

  test("renders nightly channel in metadata line", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "checked",
        currentVersion: "0.5.0",
        targetVersion: "0.6.0-dev.123",
        channel: "nightly",
        method: "npm",
        forced: false,
      });
      expect(result).toContain("Method: npm");
      expect(result).toContain("Channel: nightly");
    });
  });

  test("up-to-date action includes compact metadata", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "up-to-date",
        currentVersion: "0.5.0",
        targetVersion: "0.5.0",
        channel: "stable",
        method: "brew",
        forced: false,
      });
      expect(result).toContain("Already up to date");
      expect(result).toContain("Method: brew");
      expect(result).toContain("Channel: stable");
    });
  });

  test("offline upgrade shows offline note instead of from-version", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "upgraded",
        currentVersion: "0.5.0",
        targetVersion: "0.6.0",
        channel: "stable",
        method: "curl",
        forced: false,
        offline: true,
      });
      expect(result).toContain("(offline, from cache)");
      expect(result).not.toContain("(from 0.5.0)");
    });
  });

  test("does not include from-version when versions match", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "upgraded",
        currentVersion: "0.5.0",
        targetVersion: "0.5.0",
        channel: "stable",
        method: "curl",
        forced: true,
      });
      expect(result).toContain("Upgraded to");
      expect(result).not.toContain("(from");
    });
  });

  test("changelog is separated from metadata by a blank line", () => {
    withPlain(() => {
      const result = formatUpgradeResult({
        action: "upgraded",
        currentVersion: "0.5.0",
        targetVersion: "0.6.0",
        channel: "stable",
        method: "curl",
        forced: false,
        changelog: {
          fromVersion: "0.5.0",
          toVersion: "0.6.0",
          sections: [
            { category: "features", markdown: "- add cool feature (#1)" },
          ],
          totalItems: 1,
          truncated: false,
          originalCount: 1,
        },
      });
      // Blank line between metadata and changelog heading
      expect(result).toContain("Channel: stable\n\n");
      // Changelog content present
      expect(result).toContain("New Features");
      expect(result).toContain("add cool feature (#1)");
      // Trailing newline after changelog
      expect(result).toMatch(/\n$/);
    });
  });
});

describe("formatStatusIcon", () => {
  test("resolved shows green icon", () => {
    expect(stripFormatting(formatStatusIcon("resolved"))).toContain("✓");
  });

  test("unresolved shows yellow icon", () => {
    expect(stripFormatting(formatStatusIcon("unresolved"))).toContain("●");
  });

  test("resolvedInNextRelease shows green icon", () => {
    expect(
      stripFormatting(formatStatusIcon("resolvedInNextRelease"))
    ).toContain("✓");
  });

  test("muted shows muted icon", () => {
    expect(stripFormatting(formatStatusIcon("muted"))).toContain("−");
  });

  test("unknown status falls back to yellow icon", () => {
    expect(stripFormatting(formatStatusIcon("unknown"))).toContain("●");
  });
});

describe("formatStatusLabel", () => {
  test("resolved → Resolved label", () => {
    expect(stripFormatting(formatStatusLabel("resolved"))).toContain(
      "Resolved"
    );
  });

  test("resolvedInNextRelease → Resolved in Next Release label", () => {
    expect(
      stripFormatting(formatStatusLabel("resolvedInNextRelease"))
    ).toContain("Resolved in Next Release");
  });

  test("muted → Muted label", () => {
    expect(stripFormatting(formatStatusLabel("muted"))).toContain("Muted");
  });

  test("unknown status falls back to Unknown label", () => {
    expect(stripFormatting(formatStatusLabel("unknown"))).toContain("Unknown");
  });
});
