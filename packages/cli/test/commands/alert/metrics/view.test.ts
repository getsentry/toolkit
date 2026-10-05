/**
 * Alert metrics view — parsing, name resolution, and non-404 API error propagation.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../../src/commands/alert/metrics/view.js";
import type { MetricAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../../src/lib/browser.js";
import { ApiError, ValidationError } from "../../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-metrics-view-", {
  isolateProjectRoot: true,
});

const baseRule: MetricAlertRule = {
  id: "1",
  name: "Metric Rule Alpha",
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

describe("alert metrics view", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let listRulesSpy: ReturnType<typeof vi.spyOn>;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getMetricAlertRule");
    listRulesSpy = vi.spyOn(apiClient, "listMetricAlertsPaginated");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    resolveSpy = vi.spyOn(resolveTarget, "resolveOrgOnlyFromArg");

    openInBrowserSpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    getRuleSpy.mockRestore();
    listRulesSpy.mockRestore();
    openInBrowserSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  test("rejects org/ with no rule id or name (ValidationError)", async () => {
    const { context } = createContext();
    // Parse fails before target resolution; no need to mock resolve
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(context, { web: false, json: true }, "acme/")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("numeric id: propagates non-404 API errors (e.g. 500)", async () => {
    const { context } = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockRejectedValue(new ApiError("Server error", 500, "nope"));
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(context, { web: false, json: true }, "test-org/42")
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("numeric id: renders human output for the resolved metric alert rule", async () => {
    const { context, stdoutWrite } = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockResolvedValue({
      ...baseRule,
      id: "9",
      name: "All Errors",
      status: "1",
      query: "",
      projects: [],
      environment: "prod",
      owner: "team:ops",
    });
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await func.call(context, { web: false, json: false }, "test-org/9");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Metric alert rule in test-org:");
    expect(output).toContain("ID:           9");
    expect(output).toContain("Name:         All Errors");
    expect(output).toContain("Status:       disabled");
    expect(output).toContain("Query:        (none)");
    expect(output).toContain("Projects:     (all)");
    expect(output).toContain("Environment:  prod");
    expect(output).toContain("Owner:        team:ops");
  });

  test("--web opens the metric alerts page without fetching a rule", async () => {
    const { context } = createContext();
    const func = (await viewCommand.loader()) as unknown as (
      this: unknown,
      flags: ViewFlags,
      arg: string
    ) => Promise<void>;

    await func.call(context, { web: true, json: false }, "test-org/9");

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-org"),
      "metric alert rules"
    );
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getRuleSpy).not.toHaveBeenCalled();
    expect(listRulesSpy).not.toHaveBeenCalled();
  });

  test("name: no exact match with suggestions returns ValidationError with Did you mean", async () => {
    const { context, stdoutWrite } = createContext();
    resolveSpy.mockResolvedValue("test-org");
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
      .call(context, { web: false, json: true }, "test-org/Metric Rule Alph")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain("Did you mean");
    expect((err as ValidationError).message).toContain("Metric Rule Alpha");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
