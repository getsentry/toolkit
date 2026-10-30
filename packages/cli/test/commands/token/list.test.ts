/**
 * Token List Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/token/list.js";

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
import { ApiError, ContextError } from "../../../src/lib/errors.js";

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
    dateLastUsed: "2026-02-01T00:00:00Z",
    projectLastUsedId: "42",
  },
  {
    id: "8",
    name: "unused",
    scopes: ["org:ci"],
    tokenLastCharacters: "wxyz",
    dateCreated: "2026-01-02T00:00:00Z",
    dateLastUsed: null,
    projectLastUsedId: null,
  },
];

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
      commandPrefix: ["sentry", "token", "list"],
    },
    stdoutWrite,
  };
}

function output(write: ReturnType<typeof vi.fn>): string {
  return write.mock.calls.map((c) => c[0]).join("");
}

describe("token list", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  const ensureScopesSpy = vi.mocked(scopeRecovery.ensureScopesForAction);

  beforeEach(() => {
    ensureScopesSpy.mockResolvedValue("ready");
    listSpy = vi.spyOn(apiClient, "listOrgAuthTokens");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    listSpy.mockResolvedValue(tokens);
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
  });

  afterEach(() => {
    listSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    ensureScopesSpy.mockReset();
  });

  test("lists tokens without their values", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, "my-org/");

    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: "my-org", cwd: "/tmp" });
    expect(ensureScopesSpy).toHaveBeenCalledWith(
      ["org:tokens", "org:read"],
      "Listing org auth tokens",
      expect.any(Function),
    );
    expect(listSpy).toHaveBeenCalledWith("my-org");
    const text = output(stdoutWrite);
    expect(text).toContain("github-actions");
    expect(text).toContain("abcd");
    expect(text).toContain("never");
  });

  test("JSON output is the token array", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true });

    expect(JSON.parse(output(stdoutWrite))).toEqual(tokens);
  });

  test("says when there are no tokens", async () => {
    listSpy.mockResolvedValue([]);
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, "my-org");

    expect(output(stdoutWrite)).toContain("No active org auth tokens");
  });

  test("explains a 403", async () => {
    ensureScopesSpy.mockResolvedValue("unavailable");
    listSpy.mockRejectedValue(new ApiError("Forbidden", 403));
    const { context } = createMockContext();
    const func = await listCommand.loader();

    const error = await func
      .call(context, { json: true }, "my-org")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail).toContain("org:tokens");
  });

  test("throws ContextError when no org can be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);
    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(func.call(context, { json: false })).rejects.toThrow(
      ContextError,
    );
    expect(ensureScopesSpy).not.toHaveBeenCalled();
  });
});
