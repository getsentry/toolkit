/**
 * Dashboard argument parsing tests (src/lib/dashboard-arguments.ts and
 * grammar/dashboard-arguments.pegjs).
 */

import { describe, expect, test } from "vitest";
import {
  parseDashboardArgs,
  parseDashboardListArgs,
} from "../../src/lib/dashboard-arguments.js";
import { ValidationError } from "../../src/lib/errors.js";

const USAGE_HINT = "sentry dashboard view <org>/ <id>";

function parseRef(args: string[]) {
  return parseDashboardArgs(args, USAGE_HINT);
}

// ---------------------------------------------------------------------------
// parseDashboardArgs
// ---------------------------------------------------------------------------

describe("parseDashboardArgs", () => {
  test("throws ValidationError for empty args", () => {
    expect(() => parseRef([])).toThrow(ValidationError);
  });

  test("error message contains 'Dashboard ID or title'", () => {
    try {
      parseRef([]);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(
        "Dashboard ID or title",
      );
    }
  });

  test("single arg returns dashboardRef only", () => {
    const result = parseRef(["123"]);
    expect(result.dashboardRef).toBe("123");
    expect(result.targetArg).toBeUndefined();
  });

  test.each([
    ["my-org/12345", "my-org/"],
    ["my-org/web_app/12345", "my-org/web_app"],
  ])("extracts a numeric dashboard ID from %s", (input, targetArg) => {
    expect(parseRef([input])).toEqual({
      dashboardRef: "12345",
      targetArg,
      warnings: [],
    });
  });

  test.each([
    "Latency/p95",
    "Errors / 2026",
    "My Dashboard/123",
    "Errors.v2/123",
    "org/project/title",
    "org/",
    "/123",
    "org//123",
    "org/a/b/123",
  ])("preserves %s as a dashboard title", (title) => {
    expect(parseRef([title])).toEqual({
      dashboardRef: title,
      targetArg: undefined,
      warnings: [],
    });
  });

  test("preserves a numeric slash title with a separate target", () => {
    expect(parseRef(["my-org/", "incidents/2026"])).toEqual({
      dashboardRef: "incidents/2026",
      targetArg: "my-org/",
      warnings: [],
    });
  });

  test("two args returns target + dashboardRef", () => {
    const result = parseRef(["my-org/", "My Dashboard"]);
    expect(result.dashboardRef).toBe("My Dashboard");
    expect(result.targetArg).toBe("my-org/");
  });

  test("two args with bare org slug auto-appends /", () => {
    const result = parseRef(["my-org", "12345"]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/");
  });

  test("two args with org/project is unchanged", () => {
    const result = parseRef(["my-org/my-project", "12345"]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/my-project");
  });

  // -- URL auto-recovery --

  test("extracts dashboard ID and org from SaaS subdomain URL", () => {
    const result = parseRef([
      "https://sentry-sdks.sentry.io/dashboard/4326879/",
    ]);
    expect(result.dashboardRef).toBe("4326879");
    expect(result.targetArg).toBe("sentry-sdks/");
  });

  test("extracts dashboard ID and org from organizations-path URL", () => {
    const result = parseRef([
      "https://sentry.io/organizations/my-org/dashboard/12345/",
    ]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/");
  });

  test("URL with org but no dashboard ID + second arg uses second arg as ref", () => {
    const result = parseRef(["https://my-org.sentry.io/", "My Dashboard"]);
    expect(result.dashboardRef).toBe("My Dashboard");
    expect(result.targetArg).toBe("my-org/");
  });

  test("URL with org but no dashboard ID and no second arg throws", () => {
    expect(() => parseRef(["https://my-org.sentry.io/"])).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// parseDashboardListArgs
// ---------------------------------------------------------------------------

describe("parseDashboardListArgs", () => {
  test("empty args returns undefined for both", () => {
    const result = parseDashboardListArgs([]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBeUndefined();
  });

  test("single arg with trailing slash is target", () => {
    const result = parseDashboardListArgs(["my-org/"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBeUndefined();
  });

  test("single arg with glob * is title filter", () => {
    const result = parseDashboardListArgs(["Error*"]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBe("Error*");
  });

  test("single arg with space is title filter", () => {
    const result = parseDashboardListArgs(["My Dashboard"]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBe("My Dashboard");
  });

  test("single arg with glob ? is title filter", () => {
    const result = parseDashboardListArgs(["?something"]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBe("?something");
  });

  test("single arg with glob [ is title filter", () => {
    const result = parseDashboardListArgs(["[abc]"]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBe("[abc]");
  });

  test("single bare word is title filter (dashboards are org-scoped)", () => {
    const result = parseDashboardListArgs(["performance"]);
    expect(result.targetArg).toBeUndefined();
    expect(result.titleFilter).toBe("performance");
  });

  test("two args with trailing slash target and glob filter", () => {
    const result = parseDashboardListArgs(["my-org/", "Error*"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBe("Error*");
  });

  test("two args with bare org slug auto-appends /", () => {
    const result = parseDashboardListArgs(["my-org", "Error*"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBe("Error*");
  });

  test("two args with org/project and glob filter", () => {
    const result = parseDashboardListArgs(["my-org/my-project", "*API*"]);
    expect(result.targetArg).toBe("my-org/my-project");
    expect(result.titleFilter).toBe("*API*");
  });

  test("multi-word unquoted filter: remaining args joined with spaces", () => {
    const result = parseDashboardListArgs(["sentry/cli", "CLI", "Health"]);
    expect(result.targetArg).toBe("sentry/cli");
    expect(result.titleFilter).toBe("CLI Health");
  });

  test("multi-word unquoted filter with bare org", () => {
    const result = parseDashboardListArgs(["my-org", "Error", "Overview"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBe("Error Overview");
  });

  test("single arg org/project/name splits into target + filter", () => {
    const result = parseDashboardListArgs(["sentry/cli/CLI"]);
    expect(result.targetArg).toBe("sentry/cli");
    expect(result.titleFilter).toBe("CLI");
  });

  test("single arg org/project/name with spaces in name", () => {
    const result = parseDashboardListArgs(["sentry/cli/My Dashboard"]);
    expect(result.targetArg).toBe("sentry/cli");
    expect(result.titleFilter).toBe("My Dashboard");
  });

  test("single arg org/ is target only (one slash, trailing)", () => {
    const result = parseDashboardListArgs(["my-org/"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBeUndefined();
  });

  test("single arg org/project is target only (one slash)", () => {
    const result = parseDashboardListArgs(["my-org/my-project"]);
    expect(result.targetArg).toBe("my-org/my-project");
    expect(result.titleFilter).toBeUndefined();
  });

  test("single arg org/project/ is target only (trailing slash after project)", () => {
    const result = parseDashboardListArgs(["my-org/my-project/"]);
    expect(result.targetArg).toBe("my-org/my-project/");
    expect(result.titleFilter).toBeUndefined();
  });

  // -- URL handling --

  test("dashboard URL throws ValidationError suggesting view command", () => {
    expect(() =>
      parseDashboardListArgs([
        "https://sentry-sdks.sentry.io/dashboard/4326879/",
      ]),
    ).toThrow(ValidationError);
    try {
      parseDashboardListArgs([
        "https://sentry-sdks.sentry.io/dashboard/4326879/",
      ]);
    } catch (error) {
      const msg = (error as ValidationError).message;
      expect(msg).toContain("sentry dashboard view");
      expect(msg).toContain("4326879");
      expect(msg).toContain("sentry-sdks");
    }
  });

  test("org-only URL extracts org as target", () => {
    const result = parseDashboardListArgs(["https://my-org.sentry.io/"]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBeUndefined();
  });

  test("org-only URL with second arg uses it as title filter", () => {
    const result = parseDashboardListArgs([
      "https://my-org.sentry.io/",
      "Error*",
    ]);
    expect(result.targetArg).toBe("my-org/");
    expect(result.titleFilter).toBe("Error*");
  });
});

describe("parseDashboardArgs warnings and edge cases", () => {
  test("a dashboard URL warns which ID it took, and returns its server", () => {
    expect(
      parseRef(["https://sentry.example.com/organizations/acme/dashboard/42/"]),
    ).toEqual({
      dashboardRef: "42",
      targetArg: "acme/",
      baseUrl: "https://sentry.example.com",
      warnings: ["Extracted dashboard ID 42 from URL (org: acme)"],
    });
  });

  test("an org URL warns which org it took", () => {
    expect(parseRef(["https://acme.sentry.io/", "Errors"])).toEqual({
      dashboardRef: "Errors",
      targetArg: "acme/",
      baseUrl: "https://acme.sentry.io",
      warnings: ["Extracted org 'acme' from URL"],
    });
  });

  test("after a target, an unquoted title's words form one title", () => {
    expect(parseRef(["my-org", "My", "Dashboard"])).toEqual({
      dashboardRef: "My Dashboard",
      targetArg: "my-org/",
      warnings: [],
    });
    expect(parseRef(["my-org/", "Backend", "Performance"])).toEqual({
      dashboardRef: "Backend Performance",
      targetArg: "my-org/",
      warnings: [],
    });
    expect(parseRef(["my-org/web", "Errors", "/", "2026"])).toEqual({
      dashboardRef: "Errors / 2026",
      targetArg: "my-org/web",
      warnings: [],
    });
  });

  test("after an org URL, an unquoted title's words form one title", () => {
    expect(
      parseRef(["https://acme.sentry.io/", "Backend", "Performance"]),
    ).toEqual({
      dashboardRef: "Backend Performance",
      targetArg: "acme/",
      baseUrl: "https://acme.sentry.io",
      warnings: ["Extracted org 'acme' from URL"],
    });
  });

  test("arguments after a dashboard URL are ignored with a warning", () => {
    const { dashboardRef, warnings } = parseRef([
      "https://acme.sentry.io/dashboard/7/",
      "extra",
    ]);
    expect(dashboardRef).toBe("7");
    expect(warnings).toContain(
      `Extra arguments ignored: extra. Expected: ${USAGE_HINT}`,
    );
  });

  test("an empty argument is still a dashboard reference", () => {
    expect(parseRef([""])).toEqual({ dashboardRef: "", warnings: [] });
    expect(parseRef(["my-org", ""])).toEqual({
      dashboardRef: "",
      targetArg: "my-org/",
      warnings: [],
    });
  });

  test("an org URL without a dashboard suggests the org form", () => {
    expect(() => parseRef(["https://acme.sentry.io/"])).toThrow(
      "Try: sentry dashboard <command> acme/ <id-or-title>",
    );
  });

  test("rejects NUL characters", () => {
    expect(() => parseRef(["a\0b"])).toThrow(ValidationError);
  });
});

describe("parseDashboardListArgs edge cases", () => {
  test("skips omitted and empty arguments", () => {
    expect(parseDashboardListArgs([undefined, "", "Error*"])).toEqual({
      titleFilter: "Error*",
      warnings: [],
    });
  });

  test("an org URL warns which org it took", () => {
    expect(parseDashboardListArgs(["https://acme.sentry.io/"])).toEqual({
      targetArg: "acme/",
      baseUrl: "https://acme.sentry.io",
      warnings: ["Extracted org 'acme' from URL"],
    });
  });

  test("an org URL joins the filter words after it", () => {
    expect(
      parseDashboardListArgs(["https://acme.sentry.io/", "CLI", "Health"]),
    ).toMatchObject({ targetArg: "acme/", titleFilter: "CLI Health" });
  });

  test("everything after the second slash is the filter", () => {
    expect(parseDashboardListArgs(["a/b/c/d"])).toEqual({
      targetArg: "a/b",
      titleFilter: "c/d",
      warnings: [],
    });
  });
});
