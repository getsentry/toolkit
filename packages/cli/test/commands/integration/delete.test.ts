/**
 * Integration Delete Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteCommand,
  parseIntegrationArguments,
} from "../../../src/commands/integration/delete.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import {
  ApiError,
  ContextError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

vi.mock("../../../src/lib/scope-recovery.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/scope-recovery.js")>();
  return { ...actual, ensureScopesForAction: vi.fn() };
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as scopeRecovery from "../../../src/lib/scope-recovery.js";

const sampleIntegration = {
  id: "42",
  name: "getsentry",
  domainName: "github.com/getsentry",
  provider: { key: "github", name: "GitHub" },
  status: "active",
  organizationIntegrationStatus: "active",
};

const yesFlags = { yes: true, force: false, "dry-run": false, json: false };

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

function output(write: ReturnType<typeof vi.fn>): string {
  return write.mock.calls.map((c) => c[0]).join("");
}

describe("parseIntegrationArguments", () => {
  test.each([
    [["42"], { id: "42", org: {}, warnings: [] }],
    [["my-org/42"], { id: "42", org: { org: "my-org" }, warnings: [] }],
    [["my-org", "42"], { id: "42", org: { org: "my-org" }, warnings: [] }],
    // A leading slash names no org, as before
    [["/42"], { id: "42", org: {}, warnings: [] }],
  ])("parses %j", (args, expected) => {
    expect(parseIntegrationArguments(args)).toEqual(expected);
  });

  test("rejects a missing ID", () => {
    expect(() => parseIntegrationArguments([])).toThrow(ContextError);
    expect(() => parseIntegrationArguments([""])).toThrow(ContextError);
  });

  test("rejects non-numeric IDs", () => {
    expect(() => parseIntegrationArguments(["my-org/github"])).toThrow(
      "Use the numeric ID from 'sentry integration list'",
    );
    expect(() => parseIntegrationArguments(["github"])).toThrow(
      ValidationError,
    );
  });

  test("rejects a project, which integrations do not have", () => {
    expect(() => parseIntegrationArguments(["my-org/web/42"])).toThrow(
      "this takes no project",
    );
  });

  test("rejects more than one ID instead of removing just one", () => {
    expect(() => parseIntegrationArguments(["42", "43"])).toThrow(
      "Remove one integration at a time",
    );
  });
});

describe("integration delete", () => {
  let getSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  const ensureScopesSpy = vi.mocked(scopeRecovery.ensureScopesForAction);

  beforeEach(() => {
    ensureScopesSpy.mockResolvedValue("ready");
    getSpy = vi.spyOn(apiClient, "getIntegration");
    deleteSpy = vi.spyOn(apiClient, "deleteIntegration");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    getSpy.mockResolvedValue(sampleIntegration);
    deleteSpy.mockResolvedValue(undefined);
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
  });

  afterEach(() => {
    getSpy.mockRestore();
    deleteSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    ensureScopesSpy.mockReset();
  });

  test("removes the integration with --yes", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, yesFlags, "my-org/42");

    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: "my-org", cwd: "/tmp" });
    expect(getSpy).toHaveBeenCalledWith("my-org", "42");
    expect(deleteSpy).toHaveBeenCalledWith("my-org", "42");
    expect(output(stdoutWrite)).toContain("Removed GitHub integration");
  });

  test("elevates to org:integrations before deleting", async () => {
    ensureScopesSpy.mockResolvedValue("elevated");
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, yesFlags, "my-org/42");

    expect(ensureScopesSpy).toHaveBeenCalledWith(
      ["org:integrations"],
      "Removing an integration",
      expect.any(Function),
    );
    expect(deleteSpy).toHaveBeenCalledWith("my-org", "42");
  });

  test("does not delete when authorization is declined", async () => {
    ensureScopesSpy.mockResolvedValue("declined");
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, json: true }, "my-org/42");

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(JSON.parse(output(stdoutWrite))).toMatchObject({ deleted: false });
  });

  test("dry-run does not delete", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, "dry-run": true }, "my-org/42");

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(ensureScopesSpy).not.toHaveBeenCalled();
    expect(output(stdoutWrite)).toContain("Would remove");
  });

  test("JSON output reports the removed integration", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, json: true }, "my-org/42");

    expect(JSON.parse(output(stdoutWrite))).toMatchObject({
      deleted: true,
      org: "my-org",
      id: "42",
      provider: "GitHub",
    });
  });

  test("propagates 404 before attempting the delete", async () => {
    getSpy.mockRejectedValue(new ApiError("Not found", 404));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, yesFlags, "my-org/42")).rejects.toThrow(
      ApiError,
    );
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("explains the role requirement on a 403 that survives elevation", async () => {
    deleteSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const error = await func
      .call(context, yesFlags, "my-org/42")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("org:integrations");
    expect((error as ApiError).detail).toContain("owners and managers");
  });

  test("explains the missing scope on a 403 when elevation was unavailable", async () => {
    ensureScopesSpy.mockResolvedValue("unavailable");
    deleteSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const error = await func
      .call(context, yesFlags, "my-org/42")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("predates");
    expect((error as ApiError).detail).toContain(
      "skipped with --yes or --json",
    );
  });

  test("throws ContextError when no org can be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, yesFlags, "42")).rejects.toThrow(
      ContextError,
    );
  });
});
