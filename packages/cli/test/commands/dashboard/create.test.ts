/**
 * Dashboard Create Command Tests
 *
 * Tests for the dashboard create command in src/commands/dashboard/create.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createCommand } from "../../../src/commands/dashboard/create.js";

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
import { ContextError, ValidationError } from "../../../src/lib/errors.js";

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
import type { DashboardDetail } from "../../../src/types/dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd,
    },
    stdoutWrite,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleDashboard: DashboardDetail = {
  id: "123",
  title: "My Dashboard",
  widgets: [],
  dateCreated: "2026-03-01T10:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard create", () => {
  let createDashboardSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;
  let resolveAllTargetsSpy: ReturnType<typeof spyOn>;
  let fetchProjectIdSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createDashboardSpy = vi.spyOn(apiClient, "createDashboard");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    resolveAllTargetsSpy = vi.spyOn(resolveTarget, "resolveAllTargets");
    fetchProjectIdSpy = vi.spyOn(resolveTarget, "fetchProjectId");

    // Default mocks
    resolveOrgSpy.mockResolvedValue({ org: "acme-corp" });
    resolveAllTargetsSpy.mockResolvedValue({ targets: [] });
    createDashboardSpy.mockResolvedValue(sampleDashboard);
    fetchProjectIdSpy.mockResolvedValue(999);
  });

  afterEach(() => {
    createDashboardSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    resolveAllTargetsSpy.mockRestore();
    fetchProjectIdSpy.mockRestore();
  });

  test("creates dashboard with title and verifies API args", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "My Dashboard");

    expect(createDashboardSpy).toHaveBeenCalledWith("acme-corp", {
      title: "My Dashboard",
      widgets: [],
      projects: undefined,
    });
  });

  test("JSON output contains dashboard data and url", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: true }, "My Dashboard");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe("123");
    expect(parsed.title).toBe("My Dashboard");
    expect(parsed.url).toContain("dashboard/123");
  });

  test("human output contains 'Created dashboard' and title", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "My Dashboard");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Created dashboard");
    expect(output).toContain("My Dashboard");
  });

  test("throws ValidationError when title is missing", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();

    const err = await func
      .call(context, { json: false })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Dashboard title is required");
  });

  test("two args parses target + title correctly", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(context, { json: false }, "my-org/", "My Dashboard");

    expect(createDashboardSpy).toHaveBeenCalledWith("my-org", {
      title: "My Dashboard",
      widgets: [],
      projects: undefined,
    });
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await createCommand.loader();

    await expect(
      func.call(context, { json: false }, "My Dashboard")
    ).rejects.toThrow(ContextError);
  });

  test("explicit org/project target calls fetchProjectId", async () => {
    const { context } = createMockContext();
    const func = await createCommand.loader();
    await func.call(
      context,
      { json: false },
      "my-org/my-project",
      "My Dashboard"
    );

    expect(fetchProjectIdSpy).toHaveBeenCalledWith("my-org", "my-project");
  });
});
