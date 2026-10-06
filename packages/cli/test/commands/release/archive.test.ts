/**
 * Release Archive & Restore Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { archiveCommand } from "../../../src/commands/release/archive.js";
import { restoreCommand } from "../../../src/commands/release/restore.js";

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

useTestConfigDir("release-archive-");

function makeRelease(status: string): SentryRelease {
  return {
    id: 1,
    version: "1.0.0",
    shortVersion: "1.0.0",
    status,
    dateCreated: "2025-01-01T00:00:00Z",
    dateReleased: null,
    commitCount: 0,
    deployCount: 0,
    newGroups: 0,
    versionInfo: null,
    data: {},
    authors: [],
    projects: [],
  };
}

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

describe("release archive", () => {
  let updateReleaseSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateReleaseSpy = vi.spyOn(apiClient, "updateRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    updateReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("archives a release by setting status=archived", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    updateReleaseSpy.mockResolvedValue(makeRelease("archived"));

    const { context, stdoutWrite } = createMockContext();
    const func = await archiveCommand.loader();
    await func.call(context, { "dry-run": false, json: true }, "my-org/1.0.0");

    expect(updateReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0", {
      status: "archived",
    });
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output).status).toBe("archived");
  });

  test("dry-run does not call the API", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext();
    const func = await archiveCommand.loader();
    await func.call(context, { "dry-run": true, json: true }, "my-org/1.0.0");

    expect(updateReleaseSpy).not.toHaveBeenCalled();
  });

  test("throws when no version provided", async () => {
    const { context } = createMockContext();
    const func = await archiveCommand.loader();

    await expect(
      func.call(context, { "dry-run": false, json: false })
    ).rejects.toThrow("Release version");
  });

  test("throws when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await archiveCommand.loader();

    await expect(
      func.call(context, { "dry-run": false, json: false }, "1.0.0")
    ).rejects.toThrow("organization");
  });
});

describe("release restore", () => {
  let updateReleaseSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    updateReleaseSpy = vi.spyOn(apiClient, "updateRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    updateReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("restores a release by setting status=open", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    updateReleaseSpy.mockResolvedValue(makeRelease("open"));

    const { context, stdoutWrite } = createMockContext();
    const func = await restoreCommand.loader();
    await func.call(context, { "dry-run": false, json: true }, "my-org/1.0.0");

    expect(updateReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0", {
      status: "open",
    });
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output).status).toBe("open");
  });

  test("dry-run does not call the API", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });

    const { context } = createMockContext();
    const func = await restoreCommand.loader();
    await func.call(context, { "dry-run": true, json: true }, "my-org/1.0.0");

    expect(updateReleaseSpy).not.toHaveBeenCalled();
  });

  test("throws when no version provided", async () => {
    const { context } = createMockContext();
    const func = await restoreCommand.loader();

    await expect(
      func.call(context, { "dry-run": false, json: false })
    ).rejects.toThrow("Release version");
  });

  test("throws when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await restoreCommand.loader();

    await expect(
      func.call(context, { "dry-run": false, json: false }, "1.0.0")
    ).rejects.toThrow("organization");
  });
});
