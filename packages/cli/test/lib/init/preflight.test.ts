/**
 * Tests for `resolveInitContext`. Stubs API and DSN-detection layers
 * with `spyOn` and uses `MockUI` to drive prompts deterministically.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

vi.mock("../../../src/lib/scope-recovery.js", () => ({
  captureOAuthScopeRecoveryGate: vi.fn(),
}));

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as auth from "../../../src/lib/db/auth.js";

vi.mock("../../../src/lib/dsn/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/dsn/index.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as dsnIndex from "../../../src/lib/dsn/index.js";
import {
  ApiError,
  AuthError,
  HostScopeError,
  WizardError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/init/org-prefetch.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/init/org-prefetch.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as prefetch from "../../../src/lib/init/org-prefetch.js";
import { resolveInitContext } from "../../../src/lib/init/preflight.js";
import type { WizardOptions } from "../../../src/lib/init/types.js";
import { CANCELLED } from "../../../src/lib/init/ui/types.js";
// biome-ignore lint/performance/noNamespaceImport: scope decision is mocked at the module boundary
import * as scopeRecovery from "../../../src/lib/scope-recovery.js";

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

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as resolveTarget from "../../../src/lib/resolve-target.js";

vi.mock("../../../src/lib/resolve-team.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-team.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as resolveTeam from "../../../src/lib/resolve-team.js";
import { createMockUI, type MockCall } from "./ui/mock-ui.js";

function makeOptions(overrides?: Partial<WizardOptions>): WizardOptions {
  return {
    directory: "/tmp/test",
    yes: true,
    dryRun: false,
    ...overrides,
  };
}

function feedbackOutcomes(calls: MockCall[]): string[] {
  return calls
    .filter(
      (c): c is Extract<MockCall, { kind: "feedback" }> => c.kind === "feedback"
    )
    .map((c) => c.outcome);
}

let resolveOrgPrefetchedSpy: ReturnType<typeof spyOn>;
let listOrganizationsSpy: ReturnType<typeof spyOn>;
let listTeamsSpy: ReturnType<typeof spyOn>;
let getOrganizationSpy: ReturnType<typeof spyOn>;
let getProjectSpy: ReturnType<typeof spyOn>;
let tryGetPrimaryDsnSpy: ReturnType<typeof spyOn>;
let getAuthTokenSpy: ReturnType<typeof spyOn>;
let resolveOrCreateTeamSpy: ReturnType<typeof spyOn>;
let detectDsnSpy: ReturnType<typeof spyOn>;
let resolveDsnByPublicKeySpy: ReturnType<typeof spyOn>;
let shouldDelegateScopeRecovery: ReturnType<typeof vi.fn>;

beforeEach(() => {
  shouldDelegateScopeRecovery = vi.fn().mockResolvedValue(false);
  vi.mocked(scopeRecovery.captureOAuthScopeRecoveryGate).mockReturnValue({
    shouldDelegate: shouldDelegateScopeRecovery,
  });
  resolveOrgPrefetchedSpy = vi
    .spyOn(prefetch, "resolveOrgPrefetched")
    .mockResolvedValue({ org: "acme" });
  listOrganizationsSpy = vi
    .spyOn(apiClient, "listOrganizations")
    .mockResolvedValue([{ id: "1", slug: "acme", name: "Acme" }]);
  listTeamsSpy = vi.spyOn(apiClient, "listTeams").mockResolvedValue([
    {
      id: "1",
      slug: "platform",
      name: "Platform",
      access: ["team:admin"],
      isMember: true,
    } as any,
  ]);
  getOrganizationSpy = vi
    .spyOn(apiClient, "getOrganization")
    .mockResolvedValue({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read"],
      allowMemberProjectCreation: true,
    } as any);
  getProjectSpy = vi.spyOn(apiClient, "getProject").mockResolvedValue({
    id: "42",
    slug: "my-app",
    name: "my-app",
    platform: "javascript-react",
    dateCreated: "2026-04-16T00:00:00Z",
  } as any);
  tryGetPrimaryDsnSpy = vi
    .spyOn(apiClient, "tryGetPrimaryDsn")
    .mockResolvedValue("https://abc@o1.ingest.sentry.io/42");
  getAuthTokenSpy = vi
    .spyOn(auth, "getAuthToken")
    .mockReturnValue("sntrys_test");
  resolveOrCreateTeamSpy = vi
    .spyOn(resolveTeam, "resolveOrCreateTeam")
    .mockResolvedValue({
      slug: "platform",
      source: "auto-selected",
    });
  detectDsnSpy = vi.spyOn(dsnIndex, "detectDsn").mockResolvedValue(null);
  resolveDsnByPublicKeySpy = vi
    .spyOn(resolveTarget, "resolveDsnByPublicKey")
    .mockResolvedValue(null);
});

afterEach(() => {
  resolveOrgPrefetchedSpy.mockRestore();
  listOrganizationsSpy.mockRestore();
  listTeamsSpy.mockRestore();
  getOrganizationSpy.mockRestore();
  getProjectSpy.mockRestore();
  tryGetPrimaryDsnSpy.mockRestore();
  getAuthTokenSpy.mockRestore();
  resolveOrCreateTeamSpy.mockRestore();
  detectDsnSpy.mockRestore();
  resolveDsnByPublicKeySpy.mockRestore();
  vi.mocked(scopeRecovery.captureOAuthScopeRecoveryGate).mockReset();
  process.exitCode = 0;
});

describe("resolveInitContext", () => {
  test("uses an existing detected project in --yes mode", async () => {
    detectDsnSpy.mockResolvedValue({
      publicKey: "abc",
      protocol: "https",
      host: "o1.ingest.sentry.io",
      projectId: "42",
      raw: "https://abc@o1.ingest.sentry.io/42",
      source: "env_file" as const,
    });
    resolveDsnByPublicKeySpy.mockResolvedValue({
      org: "acme",
      project: "my-app",
    });

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context).toEqual(
      expect.objectContaining({
        org: "acme",
        project: "my-app",
        team: "platform",
        authToken: "sntrys_test",
        existingProject: expect.objectContaining({
          orgSlug: "acme",
          projectSlug: "my-app",
        }),
      })
    );
    expect(getProjectSpy).toHaveBeenCalledTimes(1);
    expect(tryGetPrimaryDsnSpy).toHaveBeenCalledTimes(1);
  });

  test("keeps a detected DSN project even when project enrichment fails", async () => {
    detectDsnSpy.mockResolvedValue({
      publicKey: "abc",
      protocol: "https",
      host: "o1.ingest.sentry.io",
      projectId: "42",
      raw: "https://abc@o1.ingest.sentry.io/42",
      source: "env_file" as const,
    });
    resolveDsnByPublicKeySpy.mockResolvedValue({
      org: "acme",
      project: "my-app",
    });
    getProjectSpy.mockRejectedValue(new ApiError("temporary failure", 503));

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context).toEqual(
      expect.objectContaining({
        org: "acme",
        project: "my-app",
        team: "platform",
      })
    );
    expect(context?.existingProject).toBeUndefined();
  });

  test("retries detected project enrichment during project selection when the first lookup yields no metadata", async () => {
    detectDsnSpy.mockResolvedValue({
      publicKey: "abc",
      protocol: "https",
      host: "o1.ingest.sentry.io",
      projectId: "42",
      raw: "https://abc@o1.ingest.sentry.io/42",
      source: "env_file" as const,
    });
    resolveDsnByPublicKeySpy.mockResolvedValue({
      org: "acme",
      project: "my-app",
    });
    getProjectSpy
      .mockRejectedValueOnce(new ApiError("not found", 404))
      .mockResolvedValue({
        id: "42",
        slug: "my-app",
        name: "my-app",
        platform: "javascript-react",
        dateCreated: "2026-04-16T00:00:00Z",
      } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.existingProject).toEqual(
      expect.objectContaining({
        orgSlug: "acme",
        projectSlug: "my-app",
      })
    );
    expect(getProjectSpy).toHaveBeenCalledTimes(2);
    expect(tryGetPrimaryDsnSpy).toHaveBeenCalledTimes(1);
  });

  test("falls back to listing organizations when prefetch misses", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "solo-org", name: "Solo Org" },
    ]);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions({ yes: false }), ui);

    expect(context?.org).toBe("solo-org");
  });

  test("lets the user choose an existing bare-slug project", async () => {
    const { ui, respond } = createMockUI();
    respond.select("existing");

    const context = await resolveInitContext(
      makeOptions({ yes: false, project: "my-app" }),
      ui
    );

    expect(context?.project).toBe("my-app");
    expect(context?.existingProject?.projectSlug).toBe("my-app");
  });

  test("keeps the bare slug when the existence lookup fails", async () => {
    getProjectSpy.mockRejectedValue(new ApiError("temporary failure", 503));

    const { ui } = createMockUI();
    const context = await resolveInitContext(
      makeOptions({ yes: false, project: "my-app" }),
      ui
    );

    expect(context?.project).toBe("my-app");
    expect(context?.existingProject).toBeUndefined();
  });

  test("uses org-scoped creation when no Team Admin team is available", async () => {
    listTeamsSpy.mockResolvedValueOnce([
      {
        id: "1",
        slug: "frontend",
        name: "Frontend",
        access: ["team:read"],
        isMember: true,
      } as any,
    ]);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBeUndefined();
    expect(getOrganizationSpy).toHaveBeenCalledWith("acme");
    expect(resolveOrCreateTeamSpy).not.toHaveBeenCalled();
  });

  test("clears the project when the user chooses to create new", async () => {
    const { ui, respond } = createMockUI();
    respond.select("create");

    const context = await resolveInitContext(
      makeOptions({ yes: false, project: "my-app" }),
      ui
    );

    expect(context?.project).toBeUndefined();
    expect(context?.existingProject).toBeUndefined();
  });

  test("resolves an explicit team during preflight", async () => {
    resolveOrCreateTeamSpy.mockImplementation(async (_org, options) => ({
      slug: options.team ?? "platform",
      source: options.team ? "explicit" : "auto-selected",
    }));

    const { ui } = createMockUI();
    const context = await resolveInitContext(
      makeOptions({ team: "backend", yes: false }),
      ui
    );

    expect(context?.team).toBe("backend");
    expect(resolveOrCreateTeamSpy).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        team: "backend",
        deferAutoCreateOnEmptyOrg: true,
      })
    );
  });

  test("selects a Team Admin team over non-admin member teams", async () => {
    listTeamsSpy.mockResolvedValueOnce([
      {
        id: "1",
        slug: "frontend",
        name: "Frontend",
        access: ["team:read"],
        isMember: true,
      } as any,
      {
        id: "2",
        slug: "platform",
        name: "Platform",
        access: ["team:admin"],
        isMember: true,
      } as any,
    ]);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBe("platform");
    expect(resolveOrCreateTeamSpy).not.toHaveBeenCalled();
  });

  test("prompts when multiple Team Admin teams are available", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.select("mobile");
    listTeamsSpy.mockResolvedValueOnce([
      {
        id: "1",
        slug: "platform",
        name: "Platform",
        access: ["team:admin"],
        isMember: true,
      } as any,
      {
        id: "2",
        slug: "mobile",
        name: "Mobile",
        access: ["team:admin"],
        isMember: true,
      } as any,
    ]);

    const context = await resolveInitContext(makeOptions({ yes: false }), ui);

    expect(context?.team).toBe("mobile");
    const selectCall = calls.find((call) => call.kind === "select");
    expect(selectCall?.options).toEqual(["mobile", "platform"]);
  });

  test("selects the first alphabetical Team Admin team in --yes mode", async () => {
    listTeamsSpy.mockResolvedValueOnce([
      {
        id: "1",
        slug: "platform",
        name: "Platform",
        access: ["team:admin"],
        isMember: true,
      } as any,
      {
        id: "2",
        slug: "mobile",
        name: "Mobile",
        access: ["team:admin"],
        isMember: true,
      } as any,
    ]);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions({ yes: true }), ui);

    expect(context?.team).toBe("mobile");
  });

  test("sorts organization options alphabetically by name", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "z-org", name: "Alpha" },
      { id: "2", slug: "beta", name: "Beta" },
      { id: "3", slug: "a-org", name: "Alpha" },
    ]);

    const { ui, calls, respond } = createMockUI();
    respond.select("a-org");

    const context = await resolveInitContext(makeOptions({ yes: false }), ui);

    expect(context?.org).toBe("a-org");
    const selectCall = calls.find((call) => call.kind === "select");
    expect(selectCall?.options).toEqual(["a-org", "z-org", "beta"]);
  });

  test("sorts organizations in the --yes error", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "z-org", name: "Zulu" },
      { id: "2", slug: "a-org", name: "Alpha" },
    ]);

    const { ui } = createMockUI();

    await expect(
      resolveInitContext(makeOptions({ yes: true }), ui)
    ).rejects.toThrow("Multiple organizations found (a-org, z-org).");
  });

  test("returns null when the user cancels an org selection", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockResolvedValue([
      { id: "1", slug: "acme", name: "Acme" },
      { id: "2", slug: "beta", name: "Beta" },
    ]);

    const { ui, calls, respond } = createMockUI();
    respond.select(CANCELLED);

    const context = await resolveInitContext(makeOptions({ yes: false }), ui);

    expect(context).toBeNull();
    const cancelCall = calls.find((c) => c.kind === "cancel");
    expect(cancelCall?.kind === "cancel" && cancelCall.message).toBe(
      "Setup cancelled."
    );
    expect(feedbackOutcomes(calls)).toEqual(["cancelled"]);
  });

  test("surfaces 403 guidance when listOrganizations is forbidden", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockRejectedValueOnce(
      new ApiError(
        "Failed to list organizations",
        403,
        "You do not have permission."
      )
    );

    const { ui, calls } = createMockUI();
    await expect(
      resolveInitContext(makeOptions({ yes: true }), ui)
    ).rejects.toThrow("403 Forbidden");

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("403 Forbidden");
    expect(errorCall?.message).toContain("sentry init <org-slug>/");
  });

  test("preserves an organization-list 403 when OAuth recovery can run", async () => {
    const error = new ApiError(
      "Failed to list organizations",
      403,
      "Missing org:read"
    );
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockRejectedValueOnce(error);
    shouldDelegateScopeRecovery.mockResolvedValueOnce(true);

    const { ui } = createMockUI();

    await expect(
      resolveInitContext(makeOptions({ yes: false }), ui)
    ).rejects.toBe(error);
  });

  test("surfaces 401 guidance when listOrganizations is unauthorized", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValue(null);
    listOrganizationsSpy.mockRejectedValueOnce(
      new ApiError("Failed to list organizations", 401, "Token expired")
    );

    const { ui, calls } = createMockUI();
    await expect(
      resolveInitContext(makeOptions({ yes: true }), ui)
    ).rejects.toThrow("401 Unauthorized");

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("401 Unauthorized");
    expect(errorCall?.message).toContain("Token expired");
  });

  test("includes the auth token in the resolved context", async () => {
    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.authToken).toBe("sntrys_test");
  });

  test("sets isExplicitTeam:true when --team flag is provided", async () => {
    resolveOrCreateTeamSpy.mockResolvedValue({
      slug: "backend",
      source: "explicit",
    } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(
      makeOptions({ team: "backend" }),
      ui
    );

    expect(context?.isExplicitTeam).toBe(true);
    expect(context?.team).toBe("backend");
  });

  test("sets isExplicitTeam:false when no --team flag is provided", async () => {
    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.isExplicitTeam).toBe(false);
  });

  test("keeps the org-scoped fallback for an unattended explicit-team 403", async () => {
    resolveOrCreateTeamSpy.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, "No team:admin access")
    );

    const { ui } = createMockUI();
    const context = await resolveInitContext(
      makeOptions({ team: "backend", yes: true }),
      ui
    );

    expect(context?.team).toBeUndefined();
  });

  test("preserves an explicit-team 403 when OAuth recovery can run", async () => {
    const error = new ApiError("Forbidden", 403, "No team:admin access");
    resolveOrCreateTeamSpy.mockRejectedValueOnce(error);
    shouldDelegateScopeRecovery.mockResolvedValueOnce(true);

    const { ui } = createMockUI();

    await expect(
      resolveInitContext(makeOptions({ team: "backend", yes: false }), ui)
    ).rejects.toBe(error);
  });

  test("swallows 403 from listTeams and resolves context with team:undefined", async () => {
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, "No team:read access")
    );

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    // 403 is swallowed so the wizard can proceed to the org-scoped fallback
    expect(context).not.toBeNull();
    expect(context?.team).toBeUndefined();
    expect(getOrganizationSpy).toHaveBeenCalledWith("acme");
    expect(resolveOrCreateTeamSpy).not.toHaveBeenCalled();
  });

  test("preserves a 403 when OAuth scope recovery can run", async () => {
    const error = new ApiError("Forbidden", 403, "No team:read access");
    listTeamsSpy.mockRejectedValueOnce(error);
    shouldDelegateScopeRecovery.mockResolvedValueOnce(true);

    const { ui } = createMockUI();

    await expect(
      resolveInitContext(makeOptions({ yes: false }), ui)
    ).rejects.toBe(error);
    expect(shouldDelegateScopeRecovery).toHaveBeenCalledWith(error, {
      unattended: false,
    });
  });

  test("preserves a recoverable 401 from team lookup", async () => {
    const error = new ApiError("Unauthorized", 401, "Invalid token");
    listTeamsSpy.mockRejectedValueOnce(error);
    shouldDelegateScopeRecovery.mockResolvedValueOnce(true);

    const { ui } = createMockUI();

    await expect(
      resolveInitContext(makeOptions({ yes: false }), ui)
    ).rejects.toBe(error);
  });

  test("keeps the org-scoped fallback when OAuth recovery is unattended", async () => {
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, "No team:read access")
    );

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions({ yes: true }), ui);

    expect(context?.team).toBeUndefined();
    expect(shouldDelegateScopeRecovery).toHaveBeenCalledWith(
      expect.any(ApiError),
      {
        unattended: true,
      }
    );
  });

  test("preserves rich org-not-found guidance when implicit team lookup returns 404", async () => {
    resolveOrgPrefetchedSpy.mockResolvedValueOnce({ org: "missing-org" });
    listOrganizationsSpy.mockResolvedValueOnce([
      { id: "1", slug: "acme", name: "Acme" },
      { id: "2", slug: "beta", name: "Beta" },
    ]);
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError("Not found", 404, "Organization not found")
    );

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow(
      "Organization 'missing-org'"
    );

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("Your organizations:");
    expect(errorCall?.message).toContain("acme");
    expect(errorCall?.message).toContain("beta");
  });

  test("surfaces the enriched detail when implicit listTeams returns 401", async () => {
    // member-disabled-over-limit: a 401 from listTeams must reach the user with
    // its actionable detail, not a bare "Failed to list teams" + status line.
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError(
        "Failed to list teams",
        401,
        "Your account is disabled in this organization because it is over its member limit."
      )
    );

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow();

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("over its member limit");
  });

  test("surfaces the enriched detail when explicit --team listTeams returns 401", async () => {
    resolveOrCreateTeamSpy.mockRejectedValueOnce(
      new ApiError(
        "Failed to list teams",
        401,
        "Your account is disabled in this organization because it is over its member limit."
      )
    );

    const { ui, calls } = createMockUI();
    await expect(
      resolveInitContext(makeOptions({ team: "backend" }), ui)
    ).rejects.toThrow();

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("over its member limit");
  });

  test("passes a pre-rendered WizardError through team resolution unchanged", async () => {
    listTeamsSpy.mockRejectedValueOnce(
      new WizardError("custom preflight failure")
    );

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow(
      "custom preflight failure"
    );

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toBe("custom preflight failure");
  });

  test.each([
    ["AuthError", new AuthError("expired")],
    ["HostScopeError", new HostScopeError("host mismatch")],
  ])("propagates %s without turning it into a wizard failure", async (_, error) => {
    listTeamsSpy.mockRejectedValueOnce(error);

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toBe(error);

    expect(calls.some((call) => call.kind === "log.error")).toBe(false);
    expect(calls.some((call) => call.kind === "cancel")).toBe(false);
    expect(calls.some((call) => call.kind === "feedback")).toBe(false);
  });

  test("surfaces a non-API error message from implicit team resolution", async () => {
    listTeamsSpy.mockRejectedValueOnce(new Error("network down"));

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow(
      "network down"
    );

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("network down");
  });

  test("fails early when listTeams is forbidden and member project creation is disabled", async () => {
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, "No team:read access")
    );
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow(
      "Project creation is disabled for members"
    );
  });

  test("fails early when member project creation is disabled and no Team Admin team exists", async () => {
    listTeamsSpy.mockResolvedValueOnce([]);
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui, calls } = createMockUI();
    await expect(resolveInitContext(makeOptions(), ui)).rejects.toThrow(
      "Project creation is disabled for members"
    );

    const errorCall = calls.find(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    );
    expect(errorCall?.message).toContain("sentry init acme/<project-slug>");
  });

  test("allows org-scoped creation when member creation is disabled but token has org:write", async () => {
    listTeamsSpy.mockResolvedValueOnce([]);
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["org:write"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBeUndefined();
  });

  test("allows org-scoped creation when member creation is disabled but user is an admin (project:admin scope)", async () => {
    listTeamsSpy.mockResolvedValueOnce([]);
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read", "project:write", "project:admin", "team:admin"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBeUndefined();
  });

  test("allows org-scoped creation when member creation is disabled but user has project:write scope", async () => {
    listTeamsSpy.mockResolvedValueOnce([]);
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read", "project:write"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBeUndefined();
  });

  test("allows org-scoped creation when listTeams returns 403 and user has project:admin scope", async () => {
    listTeamsSpy.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, "No team:read access")
    );
    getOrganizationSpy.mockResolvedValueOnce({
      id: "1",
      slug: "acme",
      name: "Acme",
      access: ["project:read", "project:write", "project:admin"],
      allowMemberProjectCreation: false,
    } as any);

    const { ui } = createMockUI();
    const context = await resolveInitContext(makeOptions(), ui);

    expect(context?.team).toBeUndefined();
  });
});
