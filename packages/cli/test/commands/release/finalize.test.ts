/**
 * Release Finalize Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { finalizeCommand } from "../../../src/commands/release/finalize.js";

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
import type { SentryRelease } from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("release-finalize-");

const finalizedRelease: SentryRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: "2025-06-15T12:00:00Z",
  commitCount: 5,
  deployCount: 0,
  newGroups: 0,
  versionInfo: null,
  data: {},
  authors: [],
  projects: [],
};

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("release finalize", () => {
  let updateReleaseSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    updateReleaseSpy = vi.spyOn(apiClient, "updateRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    updateReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("finalizes a release", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    updateReleaseSpy.mockResolvedValue(finalizedRelease);

    const { context, stdoutWrite } = createMockContext();
    const func = await finalizeCommand.loader();
    await func.call(context, { json: true }, "my-org/1.0.0");

    expect(updateReleaseSpy).toHaveBeenCalledWith(
      "my-org",
      "1.0.0",
      expect.objectContaining({ dateReleased: expect.any(String) })
    );
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.dateReleased).toBe("2025-06-15T12:00:00Z");
  });

  test("throws when no version provided", async () => {
    const { context } = createMockContext();
    const func = await finalizeCommand.loader();

    await expect(func.call(context, { json: false })).rejects.toThrow(
      "Release version"
    );
  });

  test("throws when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await finalizeCommand.loader();

    await expect(func.call(context, { json: false }, "1.0.0")).rejects.toThrow(
      "organization"
    );
  });
});
