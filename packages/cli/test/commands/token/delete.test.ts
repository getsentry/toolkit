/**
 * Token Delete Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteCommand,
  parseTokenArg,
} from "../../../src/commands/token/delete.js";

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
  ResolutionError,
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

const tokens = [
  {
    id: "7",
    name: "github-actions",
    scopes: ["org:ci"],
    tokenLastCharacters: "abcd",
    dateCreated: "2026-01-01T00:00:00Z",
    dateLastUsed: null,
  },
];

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

describe("parseTokenArg", () => {
  test("parses org/id and bare id", () => {
    expect(parseTokenArg("my-org/7")).toEqual({ id: "7", orgSlug: "my-org" });
    expect(parseTokenArg("7")).toEqual({ id: "7" });
  });

  test("rejects empty and non-numeric IDs", () => {
    expect(() => parseTokenArg("")).toThrow(ContextError);
    expect(() => parseTokenArg("my-org/github-actions")).toThrow(
      ValidationError,
    );
  });
});

describe("token delete", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  const ensureScopesSpy = vi.mocked(scopeRecovery.ensureScopesForAction);

  beforeEach(() => {
    ensureScopesSpy.mockResolvedValue("ready");
    listSpy = vi.spyOn(apiClient, "listOrgAuthTokens");
    deleteSpy = vi.spyOn(apiClient, "deleteOrgAuthToken");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    listSpy.mockResolvedValue(tokens);
    deleteSpy.mockResolvedValue(undefined);
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
  });

  afterEach(() => {
    listSpy.mockRestore();
    deleteSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    ensureScopesSpy.mockReset();
  });

  test("revokes the token with --yes", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, yesFlags, "my-org/7");

    expect(ensureScopesSpy).toHaveBeenCalledWith(
      ["org:tokens", "org:read", "org:write"],
      "Revoking an org auth token",
      expect.any(Function),
    );
    expect(deleteSpy).toHaveBeenCalledWith("my-org", "7");
    expect(output(stdoutWrite)).toContain("Revoked org auth token");
  });

  test("JSON output reports the revoked token", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, json: true }, "my-org/7");

    expect(JSON.parse(output(stdoutWrite))).toEqual({
      deleted: true,
      org: "my-org",
      id: "7",
      name: "github-actions",
    });
  });

  test("dry-run does not delete", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, { ...yesFlags, "dry-run": true }, "my-org/7");

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(output(stdoutWrite)).toContain("Would revoke");
  });

  test("dry-run explains the 403 when it can't re-authorize", async () => {
    ensureScopesSpy.mockResolvedValue("unavailable");
    listSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const error = await func
      .call(context, { ...yesFlags, "dry-run": true }, "my-org/7")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("--dry-run");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("fails before deleting when the token doesn't exist", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, yesFlags, "my-org/99")).rejects.toThrow(
      ResolutionError,
    );
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("explains a 403 from the delete", async () => {
    deleteSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    const error = await func
      .call(context, yesFlags, "my-org/7")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("org:write");
  });
});
