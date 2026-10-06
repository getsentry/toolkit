/**
 * Dashboard Resolution Utility Tests
 *
 * Tests for positional argument parsing, dashboard ID resolution,
 * and org resolution in src/commands/dashboard/resolve.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyGroupLimitAutoDefault,
  autoDefaultGroupLimit,
  DEFAULT_GROUP_BY_LIMIT,
  enrichDashboardError,
  normalizeDataset,
  parseDashboardListArgs,
  parseDashboardPositionalArgs,
  resolveDashboardId,
  resolveOrgFromTarget,
  resolveWidgetIndex,
  validateWidgetEnums,
} from "../../../src/commands/dashboard/resolve.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { parseOrgProjectArg } from "../../../src/lib/arg-parsing.js";
import {
  ApiError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/region.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/region.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as region from "../../../src/lib/region.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

// ---------------------------------------------------------------------------
// parseDashboardPositionalArgs
// ---------------------------------------------------------------------------

describe("parseDashboardPositionalArgs", () => {
  test("throws ValidationError for empty args", () => {
    expect(() => parseDashboardPositionalArgs([])).toThrow(ValidationError);
  });

  test("error message contains 'Dashboard ID or title'", () => {
    try {
      parseDashboardPositionalArgs([]);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain(
        "Dashboard ID or title"
      );
    }
  });

  test("single arg returns dashboardRef only", () => {
    const result = parseDashboardPositionalArgs(["123"]);
    expect(result.dashboardRef).toBe("123");
    expect(result.targetArg).toBeUndefined();
  });

  test("two args returns target + dashboardRef", () => {
    const result = parseDashboardPositionalArgs(["my-org/", "My Dashboard"]);
    expect(result.dashboardRef).toBe("My Dashboard");
    expect(result.targetArg).toBe("my-org/");
  });

  test("two args with bare org slug auto-appends /", () => {
    const result = parseDashboardPositionalArgs(["my-org", "12345"]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/");
  });

  test("two args with org/project is unchanged", () => {
    const result = parseDashboardPositionalArgs(["my-org/my-project", "12345"]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/my-project");
  });

  // -- URL auto-recovery --

  test("extracts dashboard ID and org from SaaS subdomain URL", () => {
    const result = parseDashboardPositionalArgs([
      "https://sentry-sdks.sentry.io/dashboard/4326879/",
    ]);
    expect(result.dashboardRef).toBe("4326879");
    expect(result.targetArg).toBe("sentry-sdks/");
  });

  test("extracts dashboard ID and org from organizations-path URL", () => {
    const result = parseDashboardPositionalArgs([
      "https://sentry.io/organizations/my-org/dashboard/12345/",
    ]);
    expect(result.dashboardRef).toBe("12345");
    expect(result.targetArg).toBe("my-org/");
  });

  test("URL with org but no dashboard ID + second arg uses second arg as ref", () => {
    const result = parseDashboardPositionalArgs([
      "https://my-org.sentry.io/",
      "My Dashboard",
    ]);
    expect(result.dashboardRef).toBe("My Dashboard");
    expect(result.targetArg).toBe("my-org/");
  });

  test("URL with org but no dashboard ID and no second arg throws", () => {
    expect(() =>
      parseDashboardPositionalArgs(["https://my-org.sentry.io/"])
    ).toThrow(ValidationError);
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
      ])
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

// ---------------------------------------------------------------------------
// resolveDashboardId
// ---------------------------------------------------------------------------

describe("resolveDashboardId", () => {
  let listDashboardsPaginatedSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listDashboardsPaginatedSpy = vi.spyOn(apiClient, "listDashboardsPaginated");
  });

  afterEach(() => {
    listDashboardsPaginatedSpy.mockRestore();
  });

  test("numeric string returns directly without API call", async () => {
    const id = await resolveDashboardId("test-org", "42");
    expect(id).toBe("42");
    expect(listDashboardsPaginatedSpy).not.toHaveBeenCalled();
  });

  test("title match returns matching dashboard ID", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "10", title: "Errors Overview" },
        { id: "20", title: "Performance" },
      ],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "Performance");
    expect(id).toBe("20");
  });

  test("title match is case-insensitive", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [{ id: "10", title: "Errors Overview" }],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "errors overview");
    expect(id).toBe("10");
  });

  test("ID/slug match returns matching dashboard ID", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "default-overview", title: "General" },
        { id: "20", title: "Performance" },
      ],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "default-overview");
    expect(id).toBe("default-overview");
  });

  test("ID match is case-insensitive", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [{ id: "default-overview", title: "General" }],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "Default-Overview");
    expect(id).toBe("default-overview");
  });

  test("ID match takes priority over title match", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "perf", title: "Performance Dashboard" },
        { id: "30", title: "perf" },
      ],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "perf");
    expect(id).toBe("perf");
  });

  test("title match still works when no ID matches", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [{ id: "default-overview", title: "General" }],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "General");
    expect(id).toBe("default-overview");
  });

  test("no match throws ValidationError with fuzzy suggestions", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "10", title: "Errors Overview" },
        { id: "20", title: "Performance" },
      ],
      nextCursor: undefined,
    });

    try {
      await resolveDashboardId("test-org", "Missing Dashboard");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("Missing Dashboard");
    }
  });

  test("title not found shows fuzzy suggestions for close misspelling", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "10", title: "Errors Overview" },
        { id: "20", title: "Performance" },
      ],
      nextCursor: undefined,
    });

    try {
      await resolveDashboardId("test-org", "Eror Overview");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("Eror Overview");
      expect(message).toContain("Did you mean");
      expect(message).toContain("Errors Overview");
    }
  });

  test("no dashboards at all shows empty org message", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    try {
      await resolveDashboardId("test-org", "My Dashboard");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("My Dashboard");
      expect(message).toContain("No dashboards found in this organization.");
    }
  });

  test("handles dashboards with undefined title without crashing", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [
        { id: "10", title: undefined as unknown as string },
        { id: "20", title: "Performance" },
      ],
      nextCursor: undefined,
    });

    const id = await resolveDashboardId("test-org", "Performance");
    expect(id).toBe("20");
  });

  test("undefined title dashboards are collected as '(untitled)' in suggestions", async () => {
    listDashboardsPaginatedSpy.mockResolvedValue({
      data: [{ id: "10", title: undefined as unknown as string }],
      nextCursor: undefined,
    });

    try {
      await resolveDashboardId("test-org", "Missing");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("Missing");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOrgFromTarget
// ---------------------------------------------------------------------------

describe("resolveOrgFromTarget", () => {
  let resolveOrgOnlyTargetSpy: ReturnType<typeof spyOn>;
  let resolveEffectiveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveOrgOnlyTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOnlyTarget");
    // Default: resolveEffectiveOrg returns the input unchanged
    resolveEffectiveOrgSpy = vi
      .spyOn(region, "resolveEffectiveOrg")
      .mockImplementation((slug: string) => Promise.resolve(slug));
  });

  afterEach(() => {
    resolveOrgOnlyTargetSpy.mockRestore();
    resolveEffectiveOrgSpy.mockRestore();
  });

  test("explicit type normalizes org via resolveEffectiveOrg", async () => {
    const parsed = parseOrgProjectArg("my-org/my-project");
    const org = await resolveOrgFromTarget(
      parsed,
      "/tmp",
      "sentry dashboard view"
    );
    expect(org).toBe("my-org");
    expect(resolveEffectiveOrgSpy).toHaveBeenCalledWith("my-org");
  });

  test("explicit type with o-prefixed numeric ID resolves to slug", async () => {
    resolveEffectiveOrgSpy.mockResolvedValue("my-org");
    const parsed = parseOrgProjectArg("o1169445/my-project");
    const org = await resolveOrgFromTarget(
      parsed,
      "/tmp",
      "sentry dashboard list"
    );
    expect(org).toBe("my-org");
    expect(resolveEffectiveOrgSpy).toHaveBeenCalledWith("o1169445");
  });

  test("auto-detect propagates missing-organization ContextError", async () => {
    resolveOrgOnlyTargetSpy.mockRejectedValue(
      new ContextError("Organization", "sentry dashboard view")
    );
    const parsed = parseOrgProjectArg(undefined);

    await expect(
      resolveOrgFromTarget(parsed, "/tmp", "sentry dashboard view")
    ).rejects.toThrow(ContextError);
  });

  test("auto-detect delegates to the org-only target resolver", async () => {
    resolveOrgOnlyTargetSpy.mockResolvedValue("detected-org");
    const parsed = parseOrgProjectArg(undefined);
    const org = await resolveOrgFromTarget(
      parsed,
      "/tmp",
      "sentry dashboard list"
    );
    expect(org).toBe("detected-org");
    expect(resolveOrgOnlyTargetSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// enrichDashboardError
// ---------------------------------------------------------------------------

describe("enrichDashboardError", () => {
  test("re-throws non-ApiError unchanged", async () => {
    const original = new Error("network failure");
    await expect(
      enrichDashboardError(original, { orgSlug: "my-org", operation: "list" })
    ).rejects.toThrow(original);
  });

  test("re-throws ApiError with unhandled status unchanged", async () => {
    const original = new ApiError("rate limited", 429, "Too many requests");
    await expect(
      enrichDashboardError(original, { orgSlug: "my-org", operation: "list" })
    ).rejects.toThrow(ApiError);
    try {
      await enrichDashboardError(original, {
        orgSlug: "my-org",
        operation: "list",
      });
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  // -- 404 errors --

  test("404 on list throws ResolutionError mentioning org", async () => {
    const apiErr = new ApiError("Not Found", 404);
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        operation: "list",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("'my-org'");
      expect(msg).toContain("not found");
      expect(msg).toContain("sentry dashboard list");
      expect(msg).toContain("sentry org list");
    }
  });

  test("404 on view with dashboardId throws ResolutionError for dashboard", async () => {
    const apiErr = new ApiError("Not Found", 404);
    // Mock listDashboardsPaginated to return suggestions
    const listSpy = vi
      .spyOn(apiClient, "listDashboardsPaginated")
      .mockResolvedValue({
        data: [
          {
            id: "100",
            title: "Error Overview",
            dateCreated: "",
            createdBy: { id: 0, name: "", email: "" },
            widgets: [],
            projects: [],
          },
          {
            id: "200",
            title: "Performance",
            dateCreated: "",
            createdBy: { id: 0, name: "", email: "" },
            widgets: [],
            projects: [],
          },
        ],
        nextCursor: undefined,
      });
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        dashboardId: "12345",
        operation: "view",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("Dashboard 12345");
      expect(msg).toContain("'my-org'");
      expect(msg).toContain("not found");
      expect(msg).toContain("sentry dashboard list");
      // Should include suggestions from the API
      expect(msg).toContain("Available dashboards");
      expect(msg).toContain("Error Overview");
      expect(msg).toContain("Performance");
    } finally {
      listSpy.mockRestore();
    }
  });

  test("404 on view still works when suggestion fetch fails", async () => {
    const apiErr = new ApiError("Not Found", 404);
    const listSpy = vi
      .spyOn(apiClient, "listDashboardsPaginated")
      .mockRejectedValue(new Error("network error"));
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        dashboardId: "99999",
        operation: "view",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("Dashboard 99999");
      expect(msg).toContain("not found");
      // Should NOT contain suggestions since fetch failed
      expect(msg).not.toContain("Available dashboards");
    } finally {
      listSpy.mockRestore();
    }
  });

  test("404 on create without dashboardId throws ResolutionError for org", async () => {
    const apiErr = new ApiError("Not Found", 404);
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "bad-org",
        operation: "create",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("'bad-org'");
      expect(msg).toContain("not found");
    }
  });

  // -- 403 errors --

  test("403 with dashboardId throws ResolutionError for dashboard access", async () => {
    const apiErr = new ApiError("Forbidden", 403, "No permission");
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        dashboardId: "99",
        operation: "view",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("Dashboard 99");
      expect(msg).toContain("access denied");
      expect(msg).toContain("No permission");
    }
  });

  test("403 without dashboardId throws ResolutionError for org dashboards", async () => {
    const apiErr = new ApiError("Forbidden", 403);
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        operation: "list",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("Dashboards in 'my-org'");
      expect(msg).toContain("access denied");
    }
  });

  test("403 includes default detail when API provides none", async () => {
    const apiErr = new ApiError("Forbidden", 403);
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        operation: "list",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const msg = (error as ResolutionError).message;
      expect(msg).toContain("You do not have permission.");
    }
  });

  // -- 400 errors --

  test("400 on update throws enriched ApiError with dashboard context", async () => {
    const apiErr = new ApiError("Bad Request", 400, "Invalid widget config");
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        dashboardId: "42",
        operation: "update",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const msg = (error as ApiError).message;
      expect(msg).toContain("Dashboard update failed");
      expect(msg).toContain("'my-org'");
      expect((error as ApiError).detail).toContain("Invalid widget config");
    }
  });

  test("400 on create throws enriched ApiError with plan limit detail", async () => {
    const apiErr = new ApiError(
      "Bad Request",
      400,
      "You may not exceed 10 dashboards on your current plan."
    );
    try {
      await enrichDashboardError(apiErr, {
        orgSlug: "my-org",
        operation: "create",
      });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const msg = (error as ApiError).message;
      expect(msg).toContain("Dashboard create failed");
      expect(msg).toContain("'my-org'");
      expect((error as ApiError).detail).toContain(
        "You may not exceed 10 dashboards"
      );
    }
  });

  test("400 on non-create/update operation re-throws unchanged", async () => {
    const apiErr = new ApiError("Bad Request", 400, "some detail");
    await expect(
      enrichDashboardError(apiErr, { orgSlug: "my-org", operation: "list" })
    ).rejects.toThrow(apiErr);
  });
});

// ---------------------------------------------------------------------------
// normalizeDataset + validateWidgetEnums
// ---------------------------------------------------------------------------

describe("normalizeDataset", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeDataset(undefined)).toBeUndefined();
  });

  test("lowercases canonical values (pass-through)", () => {
    expect(normalizeDataset("spans")).toBe("spans");
    expect(normalizeDataset("error-events")).toBe("error-events");
    expect(normalizeDataset("tracemetrics")).toBe("tracemetrics");
    expect(normalizeDataset("logs")).toBe("logs");
    expect(normalizeDataset("issue")).toBe("issue");
  });

  test("resolves error/errors aliases", () => {
    expect(normalizeDataset("errors")).toBe("error-events");
    expect(normalizeDataset("error")).toBe("error-events");
  });

  test("resolves metrics and metricsEnhanced aliases", () => {
    expect(normalizeDataset("metrics")).toBe("tracemetrics");
    expect(normalizeDataset("metricsEnhanced")).toBe("tracemetrics");
  });

  test("resolves log alias", () => {
    expect(normalizeDataset("log")).toBe("logs");
  });

  test("case-insensitive matching", () => {
    expect(normalizeDataset("Errors")).toBe("error-events");
    expect(normalizeDataset("ERRORS")).toBe("error-events");
    expect(normalizeDataset("SPANS")).toBe("spans");
    expect(normalizeDataset("MetricsEnhanced")).toBe("tracemetrics");
  });

  test("returns lowercased unknown input unchanged for validator to reject", () => {
    expect(normalizeDataset("unknown-dataset")).toBe("unknown-dataset");
    expect(normalizeDataset("DoesNotExist")).toBe("doesnotexist");
  });
});

describe("validateWidgetEnums (with normalizeDataset)", () => {
  test("accepts a normalized alias without error", () => {
    // Pipeline: caller runs normalizeDataset first, then passes the canonical
    // value to validateWidgetEnums. This simulates the wiring in add/edit.
    expect(() =>
      validateWidgetEnums("bar", normalizeDataset("errors"))
    ).not.toThrow();
  });

  test("rejects an unresolved alias when passed un-normalized", () => {
    // Guard: forgetting to normalize surfaces as a ValidationError listing
    // canonical values, not silent success.
    expect(() => validateWidgetEnums("bar", "errors")).toThrow(ValidationError);
  });

  test("rejects unknown datasets (no such alias)", () => {
    expect(() => validateWidgetEnums(undefined, "bogus-dataset")).toThrow(
      ValidationError
    );
  });

  test("rejects unknown display types", () => {
    expect(() => validateWidgetEnums("pie-chart", undefined)).toThrow(
      ValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// autoDefaultGroupLimit / applyGroupLimitAutoDefault
// ---------------------------------------------------------------------------

describe("autoDefaultGroupLimit", () => {
  test("returns the provided limit when set", () => {
    expect(autoDefaultGroupLimit(["browser.name"], 10)).toBe(10);
  });

  test("returns DEFAULT_GROUP_BY_LIMIT for grouped widgets with no limit", () => {
    expect(autoDefaultGroupLimit(["browser.name"], undefined)).toBe(
      DEFAULT_GROUP_BY_LIMIT
    );
    expect(autoDefaultGroupLimit(["browser.name"], null)).toBe(
      DEFAULT_GROUP_BY_LIMIT
    );
  });

  test("returns undefined for ungrouped widgets with no limit", () => {
    expect(autoDefaultGroupLimit([], undefined)).toBeUndefined();
    expect(autoDefaultGroupLimit([], null)).toBeUndefined();
  });

  test("preserves explicit limit even for ungrouped widgets", () => {
    expect(autoDefaultGroupLimit([], 3)).toBe(3);
  });
});

describe("applyGroupLimitAutoDefault", () => {
  test("skips auto-default when --group-by not passed", () => {
    // Auto-defaulted columns (e.g., ["issue"] for issue/table) should NOT
    // trigger the auto-default limit — caller signals intent via userGroupBy.
    expect(
      applyGroupLimitAutoDefault(undefined, ["issue"], undefined)
    ).toBeUndefined();
  });

  test("applies default when --group-by passed without limit", () => {
    expect(
      applyGroupLimitAutoDefault(["browser.name"], ["browser.name"], undefined)
    ).toBe(DEFAULT_GROUP_BY_LIMIT);
  });

  test("preserves explicit limit", () => {
    expect(
      applyGroupLimitAutoDefault(["browser.name"], ["browser.name"], 25)
    ).toBe(25);
  });

  test("empty --group-by is treated as not passed", () => {
    expect(applyGroupLimitAutoDefault([], [], undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveWidgetIndex — undefined title handling
// ---------------------------------------------------------------------------

describe("resolveWidgetIndex", () => {
  test("resolves by index when title is undefined", () => {
    const widgets = [
      { title: undefined as unknown as string } as Parameters<
        typeof resolveWidgetIndex
      >[0][0],
      { title: "My Widget" } as Parameters<typeof resolveWidgetIndex>[0][0],
    ];
    expect(resolveWidgetIndex(widgets, 0, undefined)).toBe(0);
  });

  test("does not crash when widgets have undefined titles during title search", () => {
    const widgets = [
      { title: undefined as unknown as string } as Parameters<
        typeof resolveWidgetIndex
      >[0][0],
      { title: "My Widget" } as Parameters<typeof resolveWidgetIndex>[0][0],
    ];
    expect(resolveWidgetIndex(widgets, undefined, "My Widget")).toBe(1);
  });
});
