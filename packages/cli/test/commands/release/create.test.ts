/**
 * Release Create Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../src/commands/release/create.js";

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

useTestConfigDir("release-create-");

const sampleRelease: SentryRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: null,
  commitCount: 0,
  deployCount: 0,
  newGroups: 0,
  versionInfo: null,
  data: {},
  authors: [],
  projects: [
    {
      id: 1,
      slug: "my-project",
      name: "My Project",
      platform: null,
      platforms: null,
      hasHealthData: false,
      newGroups: 0,
    },
  ],
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

describe("release create", () => {
  let createReleaseSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createReleaseSpy = vi.spyOn(apiClient, "createRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    createReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("creates a release with version", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createReleaseSpy.mockResolvedValue(sampleRelease);

    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { finalize: false, json: true }, "my-org/1.0.0");

    expect(createReleaseSpy).toHaveBeenCalledWith("my-org", {
      version: "1.0.0",
    });
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("1.0.0");
  });

  test("passes --project flag", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createReleaseSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { finalize: false, project: "my-project", json: true },
      "1.0.0"
    );

    expect(createReleaseSpy).toHaveBeenCalledWith("my-org", {
      version: "1.0.0",
      projects: ["my-project"],
    });
  });

  test("--finalize sets dateReleased", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createReleaseSpy.mockResolvedValue({
      ...sampleRelease,
      dateReleased: "2025-01-01T00:00:00Z",
    });

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { finalize: true, json: true }, "1.0.0");

    const call = createReleaseSpy.mock.calls[0];
    const body = call[1];
    expect(body.dateReleased).toBeDefined();
    expect(typeof body.dateReleased).toBe("string");
  });

  test("passes --ref flag", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createReleaseSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { finalize: false, ref: "main", json: true },
      "1.0.0"
    );

    expect(createReleaseSpy).toHaveBeenCalledWith("my-org", {
      version: "1.0.0",
      ref: "main",
    });
  });

  test("throws when no version provided", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    await expect(
      func.call(context, { finalize: false, json: false })
    ).rejects.toThrow("Release version");
  });
});
