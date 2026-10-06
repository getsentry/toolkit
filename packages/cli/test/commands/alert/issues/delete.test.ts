import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deleteCommand } from "../../../../src/commands/alert/issues/delete.js";
import type { IssueAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import type { ResolvedTarget } from "../../../../src/lib/resolve-target.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-issues-delete-", {
  isolateProjectRoot: true,
});

const sampleTarget: ResolvedTarget = {
  org: "test-org",
  project: "test-project",
  orgDisplay: "test-org",
  projectDisplay: "test-project",
};

const sampleRule: IssueAlertRule = {
  id: "42",
  name: "Rule Alpha",
  status: "active",
  actionMatch: "any",
  conditions: [],
  actions: [],
  frequency: 30,
  environment: null,
  owner: null,
  projects: ["test-project"],
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

describe("alert issues delete", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let deleteRuleSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getIssueAlertRule");
    deleteRuleSpy = vi.spyOn(apiClient, "deleteIssueAlertRule");
    resolveSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTargets");

    getRuleSpy.mockResolvedValue(sampleRule);
    deleteRuleSpy.mockResolvedValue(undefined);
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
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
      "test-org/test-project/42"
    );

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "explicit",
        org: "test-org",
        project: "test-project",
      }),
      expect.objectContaining({
        cwd: getConfigDir(),
        usageHint:
          "sentry alert issues delete <org>/<project>/<rule-id-or-name>",
      })
    );
    expect(getRuleSpy).toHaveBeenCalledWith("test-org", "test-project", "42");
    expect(deleteRuleSpy).not.toHaveBeenCalled();
    expect(stdoutWrite.mock.calls.map((c) => c[0]).join("")).toContain(
      "Would delete issue alert rule"
    );
  });

  test("dry-run JSON returns the preview contract", async () => {
    const { context, stdoutWrite } = createContext();
    const func = await deleteCommand.loader();

    await func.call(
      context,
      { ...defaultFlags, "dry-run": true, json: true },
      "test-org/test-project/42"
    );

    expect(
      JSON.parse(stdoutWrite.mock.calls.map((c) => c[0]).join(""))
    ).toEqual({
      dryRun: true,
      org: "test-org",
      project: "test-project",
      id: "42",
      name: "Rule Alpha",
    });
    expect(deleteRuleSpy).not.toHaveBeenCalled();
  });

  test("--yes deletes the resolved rule", async () => {
    const { context, stdoutWrite } = createContext();
    const func = await deleteCommand.loader();

    await func.call(
      context,
      { ...defaultFlags, yes: true },
      "test-org/test-project/42"
    );

    expect(getRuleSpy).toHaveBeenCalledWith("test-org", "test-project", "42");
    expect(deleteRuleSpy).toHaveBeenCalledWith("test-org", "42");
    expect(stdoutWrite.mock.calls.map((c) => c[0]).join("")).toContain(
      "Deleted issue alert rule"
    );
  });

  test.each([
    ["--yes", { ...defaultFlags, yes: true }],
    ["--dry-run", { ...defaultFlags, "dry-run": true }],
  ])("rejects bare rule id with %s before resolving target", async (_, flags) => {
    const { context } = createContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, flags, "42")).rejects.toThrow(
      "Auto-detection is disabled for destructive operations"
    );

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getRuleSpy).not.toHaveBeenCalled();
    expect(deleteRuleSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["--yes", { ...defaultFlags, yes: true }],
    ["--dry-run", { ...defaultFlags, "dry-run": true }],
  ])("rejects org-all issue alert rule target with %s before resolving target", async (_, flags) => {
    const { context } = createContext();
    const func = await deleteCommand.loader();

    await expect(func.call(context, flags, "test-org//42")).rejects.toThrow(
      "requires an explicit <org>/<project>/<rule-id-or-name>"
    );

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getRuleSpy).not.toHaveBeenCalled();
    expect(deleteRuleSpy).not.toHaveBeenCalled();
  });
});
