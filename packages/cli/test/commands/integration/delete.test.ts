/**
 * Integration Delete Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteCommand,
  parseIntegrationArg,
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

describe("parseIntegrationArg", () => {
  test("parses org/id and bare id", () => {
    expect(parseIntegrationArg("my-org/42")).toEqual({
      id: "42",
      orgSlug: "my-org",
    });
    expect(parseIntegrationArg("42")).toEqual({ id: "42" });
  });

  test("rejects empty and non-numeric IDs", () => {
    expect(() => parseIntegrationArg("")).toThrow(ContextError);
    expect(() => parseIntegrationArg("my-org/github")).toThrow(ValidationError);
  });
});

describe("integration delete", () => {
  let getSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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

  test("dry-run does not delete", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, "dry-run": true }, "my-org/42");

    expect(deleteSpy).not.toHaveBeenCalled();
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

  test("explains the missing org:integrations scope on 403", async () => {
    deleteSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const error = await func
      .call(context, yesFlags, "my-org/42")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("org:integrations");
    expect((error as ApiError).detail).toContain("sentry auth refresh --scope");
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
