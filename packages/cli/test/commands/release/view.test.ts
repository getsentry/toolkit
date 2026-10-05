/**
 * Release View Command Tests
 *
 * Tests basic display, org resolution, error handling, and
 * per-project health/adoption data rendering.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../src/commands/release/view.js";

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

useTestConfigDir("release-view-");

const sampleRelease: SentryRelease = {
  id: 1,
  version: "1.0.0",
  shortVersion: "1.0.0",
  status: "open",
  dateCreated: "2025-01-01T00:00:00Z",
  dateReleased: null,
  commitCount: 5,
  deployCount: 1,
  newGroups: 0,
  ref: "main",
  url: null,
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

/** Sample release with per-project health data populated (as from `?health=1`). */
const sampleReleaseWithHealth: SentryRelease = {
  ...sampleRelease,
  projects: [
    {
      id: 1,
      slug: "frontend",
      name: "Frontend",
      platform: "javascript",
      platforms: ["javascript"],
      hasHealthData: true,
      newGroups: 3,
      healthData: {
        adoption: 42.3,
        sessionsAdoption: 38.1,
        crashFreeUsers: 99.1,
        crashFreeSessions: 98.7,
        totalUsers: 50_000,
        totalUsers24h: 10_200,
        totalProjectUsers24h: 12_000,
        totalSessions: 200_000,
        totalSessions24h: 52_000,
        totalProjectSessions24h: 60_000,
        sessionsCrashed: 120,
        sessionsErrored: 450,
        hasHealthData: true,
        durationP50: null,
        durationP90: null,
        stats: {},
      },
    },
    {
      id: 2,
      slug: "backend",
      name: "Backend",
      platform: "python",
      platforms: ["python"],
      hasHealthData: true,
      newGroups: 1,
      healthData: {
        adoption: 78.5,
        sessionsAdoption: 72.0,
        crashFreeUsers: 94.2,
        crashFreeSessions: 93.8,
        totalUsers: 30_000,
        totalUsers24h: 5000,
        totalProjectUsers24h: 6000,
        totalSessions: 100_000,
        totalSessions24h: 18_000,
        totalProjectSessions24h: 20_000,
        sessionsCrashed: 80,
        sessionsErrored: 300,
        hasHealthData: true,
        durationP50: null,
        durationP90: null,
        stats: {},
      },
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

describe("release view", () => {
  let getReleaseSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getReleaseSpy = vi.spyOn(apiClient, "getRelease");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    getReleaseSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("displays release details in JSON mode", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleRelease);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: true }, "my-org/1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.commitCount).toBe(5);
  });

  test("displays release details in human mode", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleRelease);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: false }, "1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("1.0.0");
    expect(output).toContain("Commits");
  });

  test("resolves org from explicit prefix", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleRelease);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: true }, "my-org/1.0.0");

    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: "my-org", cwd: "/tmp" });
    expect(getReleaseSpy).toHaveBeenCalledWith("my-org", "1.0.0", {
      health: true,
      adoptionStages: true,
    });
  });

  test("throws when no version provided", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { fresh: false, json: false })
    ).rejects.toThrow("Release version");
  });

  test("throws when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { fresh: false, json: false }, "1.0.0")
    ).rejects.toThrow("organization");
  });

  test("displays per-project health data in human mode", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleReleaseWithHealth);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: false }, "1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Health section header
    expect(output).toContain("Health by Project");
    // Project slugs
    expect(output).toContain("frontend");
    expect(output).toContain("backend");
    // Adoption percentages
    expect(output).toContain("42.3%");
    expect(output).toContain("78.5%");
    // Crash-free rates
    expect(output).toContain("99.1%");
    expect(output).toContain("98.7%");
  });

  test("includes health data in JSON output", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleReleaseWithHealth);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: true }, "1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0].healthData.adoption).toBe(42.3);
    expect(parsed.projects[0].healthData.crashFreeSessions).toBe(98.7);
    expect(parsed.projects[1].healthData.crashFreeUsers).toBe(94.2);
  });

  test("omits health section when no project has health data", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getReleaseSpy.mockResolvedValue(sampleRelease);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { fresh: false, json: false }, "1.0.0");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("Health by Project");
  });
});
