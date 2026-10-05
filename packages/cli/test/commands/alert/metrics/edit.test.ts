import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editCommand } from "../../../../src/commands/alert/metrics/edit.js";
import type { MetricAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import { ValidationError } from "../../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-metrics-edit-", {
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

type EditFlags = {
  readonly name?: string;
  readonly status?: "active" | "disabled";
  readonly dataset?: string;
  readonly "time-window"?: number;
  readonly trigger?: string[];
  readonly query?: string;
  readonly aggregate?: string;
  readonly json: boolean;
};

function createContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: getConfigDir(),
  };
}

describe("alert metrics edit", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let getDocSpy: ReturnType<typeof vi.spyOn>;
  let putSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getMetricAlertRule");
    getDocSpy = vi.spyOn(apiClient, "getMetricAlertRuleDocument");
    putSpy = vi.spyOn(apiClient, "putMetricAlertRule");
    resolveSpy = vi.spyOn(resolveTarget, "resolveOrgOnlyFromArg");
  });

  afterEach(() => {
    getRuleSpy.mockRestore();
    getDocSpy.mockRestore();
    putSpy.mockRestore();
    resolveSpy.mockRestore();
  });

  test("requires at least one mutation flag", async () => {
    const context = createContext();
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(context, { json: true }, "test-org/9")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("merges advanced fields and validates trigger payload", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "event.type:error",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
    });
    putSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule Updated",
      status: 1,
      query: "event.type:error environment:prod",
      aggregate: "count()",
      dataset: "spans",
      timeWindow: 15,
      triggers: [{ alertThreshold: 200, actions: [{ id: "notify" }] }],
    });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        status: "disabled",
        query: "event.type:error environment:prod",
        aggregate: "count()",
        dataset: "spans",
        "time-window": 15,
        trigger: ['{"alertThreshold":200,"actions":[{"id":"notify"}]}'],
        json: true,
      },
      "test-org/9"
    );

    expect(putSpy).toHaveBeenCalledWith("test-org", "9", {
      id: "9",
      name: "Metric Rule",
      status: 1,
      query: "event.type:error environment:prod",
      aggregate: "count()",
      dataset: "spans",
      timeWindow: 15,
      triggers: [{ alertThreshold: 200, actions: [{ id: "notify" }] }],
    });
  });

  test("does not validate unedited API fields when renaming existing rule", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockResolvedValue({
      ...sampleRule,
      query: "",
    });
    getDocSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100 }],
    });
    putSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule Renamed",
      status: 0,
      query: "",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100 }],
    });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule Renamed",
        json: true,
      },
      "test-org/9"
    );

    expect(putSpy).toHaveBeenCalledWith(
      "test-org",
      "9",
      expect.objectContaining({
        name: "Metric Rule Renamed",
        query: "",
        triggers: [{ alertThreshold: 100 }],
      })
    );
  });

  test("allows explicitly clearing query to match all events", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "event.type:error",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
    });
    putSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
    });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        query: "",
        json: true,
      },
      "test-org/9"
    );

    expect(putSpy).toHaveBeenCalledWith(
      "test-org",
      "9",
      expect.objectContaining({ query: "" })
    );
  });

  test("routes --dataset transactions to spans with is_transaction:true and a tip", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue("test-org");
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "environment:prod",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
    });
    putSpy.mockResolvedValue({
      id: "9",
      name: "Metric Rule",
      status: 0,
      query: "environment:prod is_transaction:true",
      aggregate: "count()",
      dataset: "spans",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
    });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        dataset: "transactions",
        json: true,
      },
      "test-org/9"
    );

    expect(putSpy).toHaveBeenCalledWith(
      "test-org",
      "9",
      expect.objectContaining({
        dataset: "spans",
        query: "environment:prod is_transaction:true",
      })
    );
    expect(context.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("is_transaction:true")
    );
  });
});
