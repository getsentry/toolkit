import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../../src/commands/alert/issues/create.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import { ValidationError } from "../../../../src/lib/errors.js";
import type { ResolvedTarget } from "../../../../src/lib/resolve-target.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-issues-create-", {
  isolateProjectRoot: true,
});

const sampleTarget: ResolvedTarget = {
  org: "test-org",
  project: "test-project",
  orgDisplay: "test-org",
  projectDisplay: "test-project",
};

type CreateFlags = {
  readonly name: string;
  readonly condition?: string[];
  readonly action?: string[];
  readonly frequency: number;
  readonly environment?: string;
  readonly filter?: string[];
  readonly "filter-match"?: "all" | "any";
  readonly owner?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
};

function createContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    stdout: { write: stdoutWrite },
    stderr: { write: vi.fn(() => true) },
    cwd: getConfigDir(),
    stdoutWrite,
  };
}

describe("alert issues create", () => {
  let resolveSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;
  let detectorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTargets");
    createSpy = vi.spyOn(apiClient, "createIssueAlertRule");
    detectorSpy = vi.spyOn(apiClient, "resolveErrorDetectorId");
    detectorSpy.mockResolvedValue(100);
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    createSpy.mockRestore();
    detectorSpy.mockRestore();
  });

  test("rejects blank rule name", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: "   ",
          condition: ['{"id":"condition-a"}'],
          action: ['{"id":"action-a"}'],
          frequency: 30,
          "dry-run": true,
          json: true,
        },
        "test-org/test-project"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects nonpositive frequency", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: "Rule A",
          condition: ['{"id":"condition-a"}'],
          action: ['{"id":"action-a"}'],
          frequency: 0,
          "dry-run": true,
          json: true,
        },
        "test-org/test-project"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("dry run does not call create API", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Rule A",
        condition: ['{"id":"condition-a"}'],
        action: ['{"id":"action-a"}'],
        frequency: 30,
        "dry-run": true,
        json: true,
      },
      "test-org/test-project"
    );

    expect(createSpy).not.toHaveBeenCalled();
  });

  test("dry run JSON includes optional fields and default filterMatch", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Rule A",
        condition: ['{"id":"condition-a"}'],
        action: ['{"id":"action-a"}'],
        frequency: 30,
        environment: "prod",
        filter: ['{"id":"filter-a"}'],
        owner: "team:ops",
        "dry-run": true,
        json: true,
      },
      "test-org/test-project"
    );

    const parsed = JSON.parse(
      context.stdoutWrite.mock.calls.map((c) => c[0]).join("")
    );
    expect(parsed).toEqual({
      org: "test-org",
      project: "test-project",
      name: "Rule A",
      dryRun: true,
      body: {
        name: "Rule A",
        detectorIds: [100],
        config: { frequency: 30 },
        triggers: {
          logicType: "any-short",
          conditions: [{ id: "condition-a" }],
        },
        actionFilters: [
          {
            logicType: "all",
            conditions: [{ id: "filter-a" }],
            actions: [{ id: "action-a" }],
          },
        ],
        environment: "prod",
        owner: "team:ops",
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("rejects targets that resolve to multiple projects", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({
      targets: [
        sampleTarget,
        {
          ...sampleTarget,
          project: "other-project",
          projectDisplay: "other-project",
        },
      ],
    });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: "Rule A",
          condition: ['{"id":"condition-a"}'],
          action: ['{"id":"action-a"}'],
          frequency: 30,
          "dry-run": true,
          json: true,
        },
        "test-org/"
      )
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("calls create API with parsed body", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    createSpy.mockResolvedValue({
      id: "99",
      name: "Rule A",
      status: "active",
    });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Rule A",
        condition: ['{"id":"condition-a"}'],
        action: ['{"id":"action-a"}'],
        frequency: 15,
        "dry-run": false,
        json: true,
      },
      "test-org/test-project"
    );

    expect(createSpy).toHaveBeenCalledWith("test-org", {
      name: "Rule A",
      detectorIds: [100],
      config: { frequency: 15 },
      triggers: { logicType: "any-short", conditions: [{ id: "condition-a" }] },
      actionFilters: [
        { logicType: "all", conditions: [], actions: [{ id: "action-a" }] },
      ],
    });
  });
});
