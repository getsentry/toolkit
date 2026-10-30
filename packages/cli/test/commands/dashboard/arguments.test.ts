/**
 * Dashboard argument resolution tests (src/commands/dashboard/arguments.ts):
 * a bare first word before a title names an org only if there is one.
 * Parsing alone is tested in test/lib/dashboard-arguments.test.ts.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const { fakeLog, mocks } = vi.hoisted(() => {
  const log: {
    warn: ReturnType<typeof vi.fn>;
    withTag: () => typeof log;
  } = { warn: vi.fn(), withTag: () => log };
  return {
    fakeLog: log,
    mocks: {
      getOrganization: vi.fn(),
      listDashboardsPaginated: vi.fn(),
      getCachedOrganizations: vi.fn(),
      getOrgRegion: vi.fn(),
      resolveOrgOnlyTarget: vi.fn(),
    },
  };
});

vi.mock("../../../src/lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/logger.js")>()),
  logger: fakeLog,
}));

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/api-client.js")>()),
  getOrganization: mocks.getOrganization,
  listDashboardsPaginated: mocks.listDashboardsPaginated,
}));

vi.mock("../../../src/lib/db/regions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/db/regions.js")>()),
  getCachedOrganizations: mocks.getCachedOrganizations,
  getOrgRegion: mocks.getOrgRegion,
}));

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/resolve-target.js")
  >()),
  resolveOrgOnlyTarget: mocks.resolveOrgOnlyTarget,
}));

import {
  parseDashboardInput,
  resolveDashboardInput,
} from "../../../src/commands/dashboard/arguments.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";

const USAGE_HINT = "sentry dashboard view <org>/ <id-or-title>";
const DETECTED_ORG = "detected-org";

/** Dashboards per org, for `listDashboardsPaginated` */
let dashboards: Record<string, { id: string; title: string }[]>;

beforeEach(() => {
  vi.clearAllMocks();
  dashboards = {};
  mocks.getCachedOrganizations.mockReturnValue([]);
  mocks.getOrgRegion.mockReturnValue(undefined);
  mocks.getOrganization.mockRejectedValue(new ApiError("Not Found", 404));
  mocks.listDashboardsPaginated.mockImplementation(async (org: string) => ({
    data: dashboards[org] ?? [],
  }));
  mocks.resolveOrgOnlyTarget.mockImplementation(
    async (parsed: { type: string; org?: string }) =>
      parsed.type === "auto-detect" ? DETECTED_ORG : parsed.org,
  );
});

function resolve(args: string[]) {
  return resolveDashboardInput(
    parseDashboardInput(args, USAGE_HINT),
    "/tmp",
    USAGE_HINT,
  );
}

/** Warnings about falling back to the whole input as the title */
function fallbackWarnings(): unknown[] {
  return fakeLog.warn.mock.calls
    .map(([message]) => message)
    .filter((message) => String(message).startsWith("No org "));
}

describe("a bare word before a title", () => {
  test("names an org when there is one, from the cache: no fallback", async () => {
    mocks.getCachedOrganizations.mockReturnValue([{ slug: "my-org" }]);
    dashboards["my-org"] = [{ id: "7", title: "Errors" }];

    expect(await resolve(["my-org", "Errors"])).toEqual({
      orgSlug: "my-org",
      dashboardId: "7",
    });
    expect(mocks.getOrganization).not.toHaveBeenCalled();
    expect(fallbackWarnings()).toEqual([]);
  });

  test("names an org the API finds on a cache miss: its lookup is final", async () => {
    mocks.getOrganization.mockResolvedValue({ slug: "my-org" });
    dashboards[DETECTED_ORG] = [{ id: "9", title: "my-org Errors" }];

    await expect(resolve(["my-org", "Errors"])).rejects.toThrow(
      "No dashboard with title 'Errors' found in 'my-org'",
    );
    expect(mocks.getOrganization).toHaveBeenCalledWith("my-org");
    expect(fallbackWarnings()).toEqual([]);
  });

  test("without that org, is the title's first word, with a warning", async () => {
    dashboards[DETECTED_ORG] = [{ id: "42", title: "My Dashboard" }];

    expect(await resolve(["My", "Dashboard"])).toEqual({
      orgSlug: DETECTED_ORG,
      dashboardId: "42",
    });
    expect(fallbackWarnings()).toEqual([
      `No org 'My'; treating "My Dashboard" as the dashboard title. Use my-org/ to name an org.`,
    ]);
  });

  test("a 403 is no org either", async () => {
    mocks.getOrganization.mockRejectedValue(new ApiError("Forbidden", 403));
    dashboards[DETECTED_ORG] = [{ id: "42", title: "My Dashboard" }];

    expect((await resolve(["My", "Dashboard"])).dashboardId).toBe("42");
  });

  test("when neither reading finds a dashboard, one error names both", async () => {
    const error = await resolve(["My", "Dashboard"]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ValidationError);
    const { message } = error as ValidationError;
    expect(message).toContain("no org 'My' to find 'Dashboard' in");
    expect(message).toContain(
      `no dashboard 'My Dashboard' in '${DETECTED_ORG}'`,
    );
    expect(message).toContain("<org>/ Dashboard");
    expect(message).toContain("quote it: 'My Dashboard'");
  });

  test("a server error checking the org propagates, without a fallback", async () => {
    const serverError = new ApiError("Internal Server Error", 500);
    mocks.getOrganization.mockRejectedValue(serverError);
    dashboards[DETECTED_ORG] = [{ id: "42", title: "My Dashboard" }];

    await expect(resolve(["My", "Dashboard"])).rejects.toBe(serverError);
    expect(mocks.listDashboardsPaginated).not.toHaveBeenCalled();
    expect(fallbackWarnings()).toEqual([]);
  });
});

describe("never falls back", () => {
  test("for an explicit org: `my-org/ My Dashboard`", async () => {
    dashboards[DETECTED_ORG] = [{ id: "42", title: "my-org/ My Dashboard" }];

    await expect(resolve(["my-org/", "My", "Dashboard"])).rejects.toThrow(
      "No dashboard with title 'My Dashboard' found in 'my-org'",
    );
    expect(mocks.getOrganization).not.toHaveBeenCalled();
    expect(fallbackWarnings()).toEqual([]);
  });

  test("for a numeric ID", async () => {
    expect(await resolve(["my-org", "123"])).toEqual({
      orgSlug: "my-org",
      dashboardId: "123",
    });
    expect(mocks.getOrganization).not.toHaveBeenCalled();
    expect(mocks.listDashboardsPaginated).not.toHaveBeenCalled();
  });
});
