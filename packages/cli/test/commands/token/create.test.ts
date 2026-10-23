/**
 * Token Create Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../src/commands/token/create.js";

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
import { ApiError, AuthError } from "../../../src/lib/errors.js";

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

const created = {
  id: "9",
  name: "github-actions",
  scopes: ["org:ci"],
  tokenLastCharacters: "abcd",
  dateCreated: "2026-01-01T00:00:00Z",
  dateLastUsed: null,
  token: "sntrys_secret_abcd",
};

const flags = { "dry-run": false, json: false };

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

describe("token create", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  const ensureScopesSpy = vi.mocked(scopeRecovery.ensureScopesForAction);

  beforeEach(() => {
    ensureScopesSpy.mockResolvedValue("ready");
    createSpy = vi.spyOn(apiClient, "createOrgAuthToken");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    createSpy.mockResolvedValue(created);
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
  });

  afterEach(() => {
    createSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    ensureScopesSpy.mockReset();
  });

  test("creates a token and prints its value once", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, flags, "my-org/github-actions");

    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: "my-org", cwd: "/tmp" });
    expect(ensureScopesSpy).toHaveBeenCalledWith(
      ["org:tokens", "org:read", "org:ci"],
      "Creating an org auth token",
      expect.any(Function),
    );
    expect(createSpy).toHaveBeenCalledWith("my-org", "github-actions");
    expect(output(stdoutWrite)).toContain("sntrys_secret_abcd");
  });

  test("JSON output includes the token value", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { ...flags, json: true }, "github-actions");

    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: undefined, cwd: "/tmp" });
    expect(JSON.parse(output(stdoutWrite))).toMatchObject({
      org: "my-org",
      id: "9",
      token: "sntrys_secret_abcd",
    });
  });

  test("dry-run neither elevates nor creates", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { ...flags, "dry-run": true }, "my-org/ci");

    expect(ensureScopesSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(output(stdoutWrite)).toContain("Would create");
  });

  test("does not create when authorization is declined", async () => {
    ensureScopesSpy.mockResolvedValue("declined");
    const { context } = createMockContext();
    const func = await createCommand.loader();

    await expect(func.call(context, flags, "my-org/ci")).rejects.toThrow(
      AuthError,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("explains a 403", async () => {
    createSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const error = await func
      .call(context, flags, "my-org/ci")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("org:ci");
  });
});
