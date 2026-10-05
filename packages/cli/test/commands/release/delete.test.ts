/**
 * Release Delete Command Tests
 *
 * Tests for the release delete command in src/commands/release/delete.ts.
 * Uses spyOn to mock api-client and resolve-target to test
 * the func() body without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deleteCommand } from "../../../src/commands/release/delete.js";

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
import { ApiError, ContextError } from "../../../src/lib/errors.js";

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

/** Minimal release shape returned by getRelease */
const sampleRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: null,
  commitCount: 0,
  deployCount: 0,
  newGroups: 0,
};

/** Default flags for confirmed deletion (skips prompt) */
const defaultFlags = {
  yes: true,
  force: false,
  "dry-run": false,
  json: false,
};

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("release delete", () => {
  let getReleaseSpy: ReturnType<typeof spyOn>;
  let deleteReleaseSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getReleaseSpy = vi.spyOn(apiClient, "getRelease");
    deleteReleaseSpy = vi.spyOn(apiClient, "deleteRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");

    // Default mocks
    getReleaseSpy.mockResolvedValue(sampleRelease);
    deleteReleaseSpy.mockResolvedValue(undefined);
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
  });

  afterEach(() => {
    getReleaseSpy.mockRestore();
    deleteReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("deletes release with explicit org/version and --yes", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "my-org/1.0.0");

    expect(getReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0");
    expect(deleteReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("1.0.0");
    expect(output).toContain("deleted");
  });

  test("throws ContextError when no version provided", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, defaultFlags, "")).rejects.toThrow(
      ContextError
    );
    expect(deleteReleaseSpy).not.toHaveBeenCalled();
  });

  test("dry-run shows what would be deleted without calling deleteRelease", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, "dry-run": true },
      "my-org/1.0.0"
    );

    expect(getReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0");
    expect(deleteReleaseSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Would delete");
    expect(output).toContain("1.0.0");
  });

  test("propagates 404 from getRelease", async () => {
    getReleaseSpy.mockRejectedValue(
      new ApiError("Not found", 404, "Release not found")
    );

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(
      func.call(context, defaultFlags, "my-org/1.0.0")
    ).rejects.toThrow(ApiError);

    expect(deleteReleaseSpy).not.toHaveBeenCalled();
  });

  test("enriches 400 health data error with actionable message", async () => {
    const endpoint = "DELETE /api/0/organizations/my-org/releases/1.0.0/";
    deleteReleaseSpy.mockRejectedValue(
      new ApiError(
        "Failed to delete release '1.0.0': 400 Bad Request",
        400,
        "This release has health data and cannot be removed.",
        endpoint
      )
    );

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "my-org/1.0.0");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.message).toContain("health data");
      expect(apiErr.message).toContain("cannot be deleted");
      expect(apiErr.detail).toContain("protected by Sentry");
      expect(apiErr.detail).toContain("age out");
      expect(apiErr.detail).toContain("my-org");
      expect(apiErr.endpoint).toBe(endpoint);
    }
  });

  test("passes through non-health-data 400 errors unchanged", async () => {
    const originalError = new ApiError(
      "Failed to delete release '1.0.0': 400 Bad Request",
      400,
      "Some other validation error"
    );
    deleteReleaseSpy.mockRejectedValue(originalError);

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "my-org/1.0.0");
      expect.unreachable("should have thrown");
    } catch (error) {
      // Should be the exact same error object, not enriched
      expect(error).toBe(originalError);
    }
  });

  test("passes through non-ApiError exceptions unchanged", async () => {
    const originalError = new Error("network timeout");
    deleteReleaseSpy.mockRejectedValue(originalError);

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "my-org/1.0.0");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBe(originalError);
    }
  });

  test("verifies release exists before attempting delete", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "my-org/1.0.0");

    // getRelease must be called before deleteRelease
    const getOrder = getReleaseSpy.mock.invocationCallOrder[0];
    const deleteOrder = deleteReleaseSpy.mock.invocationCallOrder[0];
    expect(getOrder).toBeLessThan(deleteOrder ?? 0);
  });
});
