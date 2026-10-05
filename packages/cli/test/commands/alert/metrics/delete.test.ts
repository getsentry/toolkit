import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deleteCommand } from "../../../../src/commands/alert/metrics/delete.js";
import type { MetricAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-metrics-delete-", {
  isolateProjectRoot: true,
});

const sampleRule: MetricAlertRule = {
  id: "9",
  name: "Metric Rule",
  status: 0,
  query: "event.type:error",
  aggregate: "count()",
  dataset: "errors",
  timeWindow: 5,
  environment: null,
  owner: null,
  projects: [],
  dateCreated: "2026-01-01T00:00:00Z",
};

const defaultFlags = {
  yes: false,
  force: false,
  "dry-run": false,
  json: false,
};

function createContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: getConfigDir(),
    },
    stdoutWrite,
  };
}

describe("alert metrics delete", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let deleteRuleSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getMetricAlertRule");
    deleteRuleSpy = vi.spyOn(apiClient, "deleteMetricAlertRule");
    resolveSpy = vi.spyOn(resolveTarget, "resolveOrgOnlyFromArg");

    getRuleSpy.mockResolvedValue(sampleRule);
    deleteRuleSpy.mockResolvedValue(undefined);
    resolveSpy.mockResolvedValue("test-org");
  });

  afterEach(() => {
    getRuleSpy.mockRestore();
    deleteRuleSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  test("dry-run resolves the rule without deleting it", async () => {
    const { context, stdoutWrite } = createContext();
    const func = await deleteCommand.loader();

    await func.call(
      context,
      { ...defaultFlags, "dry-run": true },
      "test-org/9"
    );

    expect(resolveSpy).toHaveBeenCalledWith(
      "test-org/",
      getConfigDir(),
      "alert metrics delete"
    );
    expect(getRuleSpy).toHaveBeenCalledWith("test-org", "9");
    expect(deleteRuleSpy).not.toHaveBeenCalled();
    expect(stdoutWrite.mock.calls.map((c) => c[0]).join("")).toContain(
      "Would delete metric alert rule"
    );
  });

  test("--yes deletes the resolved rule", async () => {
    const { context, stdoutWrite } = createContext();
    const func = await deleteCommand.loader();

    await func.call(context, { ...defaultFlags, yes: true }, "test-org/9");

    expect(getRuleSpy).toHaveBeenCalledWith("test-org", "9");
    expect(deleteRuleSpy).toHaveBeenCalledWith("test-org", "9");
    expect(stdoutWrite.mock.calls.map((c) => c[0]).join("")).toContain(
      "Deleted metric alert rule"
    );
  });

  test("--yes JSON returns the deleted contract", async () => {
    const { context, stdoutWrite } = createContext();
    const func = await deleteCommand.loader();

    await func.call(
      context,
      { ...defaultFlags, yes: true, json: true },
      "test-org/9"
    );

    expect(
      JSON.parse(stdoutWrite.mock.calls.map((c) => c[0]).join(""))
    ).toEqual({
      deleted: true,
      org: "test-org",
      id: "9",
      name: "Metric Rule",
    });
    expect(deleteRuleSpy).toHaveBeenCalledWith("test-org", "9");
  });

  test.each([
    ["--yes", { ...defaultFlags, yes: true }],
    ["--dry-run", { ...defaultFlags, "dry-run": true }],
  ])("rejects bare rule id with %s before resolving target", async (_, flags) => {
    const { context } = createContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, flags, "9")).rejects.toThrow(
      "Auto-detection is disabled for destructive operations"
    );

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getRuleSpy).not.toHaveBeenCalled();
    expect(deleteRuleSpy).not.toHaveBeenCalled();
  });
});
