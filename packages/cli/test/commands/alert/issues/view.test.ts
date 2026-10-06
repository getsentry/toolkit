/**
 * Alert issues view — parsing, name resolution, and non-404 API error propagation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../../src/commands/alert/issues/view.js";
import type { IssueAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../../src/lib/browser.js";
import { ApiError, ValidationError } from "../../../../src/lib/errors.js";
import type { ResolvedTarget } from "../../../../src/lib/resolve-target.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-issues-view-", {
  isolateProjectRoot: true,
});

const sampleTarget: ResolvedTarget = {
  org: "test-org",
  project: "test-project",
  orgDisplay: "test-org",
  projectDisplay: "test-project",
};

const baseRule: IssueAlertRule = {
  id: "1",
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

type ViewFlags = { readonly web: boolean; readonly json: boolean };

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

describe("alert issues view", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let listRulesSpy: ReturnType<typeof vi.spyOn>;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getIssueAlertRule");
    listRulesSpy = vi.spyOn(apiClient, "listIssueAlertsPaginated");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    resolveSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTargets");

    openInBrowserSpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    getRuleSpy.mockRestore();
    listRulesSpy.mockRestore();
    openInBrowserSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  test("rejects a single org/project (missing rule) with ValidationError", async () => {
    const { context } = createContext();
    // Parse fails before target resolution; no need to mock resolve
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(context, { web: false, json: true }, "acme/frontend")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("numeric id: propagates non-404 API errors (e.g. 500)", async () => {
    const { context } = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    getRuleSpy.mockRejectedValue(new ApiError("Server error", 500, "nope"));
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(context, { web: false, json: true }, "test-org/test-project/42")
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("numeric id: renders human output for the resolved issue alert rule", async () => {
    const { context, stdoutWrite } = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    getRuleSpy.mockResolvedValue({
      ...baseRule,
      id: "42",
      name: "Prod Error Spike",
      conditions: [{ id: "condition-a" }],
      actions: [{ id: "action-a" }, { id: "action-b" }],
      environment: "prod",
      owner: "team:ops",
    });
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      { web: false, json: false },
      "test-org/test-project/42"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Issue alert rule in test-org/test-project:");
    expect(output).toContain("ID:           42");
    expect(output).toContain("Name:         Prod Error Spike");
    expect(output).toContain("Status:       active");
    expect(output).toContain("Conditions:   1");
    expect(output).toContain("Actions:      2");
    expect(output).toContain("Environment:  prod");
    expect(output).toContain("Owner:        team:ops");
  });

  test("--web opens the issue alerts page without fetching a rule", async () => {
    const { context } = createContext();
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      { web: true, json: false },
      "test-org/test-project/42"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-org"),
      "issue alert rules"
    );
    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-project"),
      "issue alert rules"
    );
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getRuleSpy).not.toHaveBeenCalled();
    expect(listRulesSpy).not.toHaveBeenCalled();
  });

  test("name: no exact match with suggestions returns ValidationError with Did you mean", async () => {
    const { context, stdoutWrite } = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    listRulesSpy.mockResolvedValue({
      data: [baseRule],
      nextCursor: undefined,
    });
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    const err = await func
      .call(
        context,
        { web: false, json: true },
        "test-org/test-project/Rule Alph"
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain("Did you mean");
    expect((err as ValidationError).message).toContain("Rule Alpha");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
