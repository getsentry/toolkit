import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editCommand } from "../../../../src/commands/alert/issues/edit.js";
import type { IssueAlertRule } from "../../../../src/lib/api-client.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import { ValidationError } from "../../../../src/lib/errors.js";
import type { ResolvedTarget } from "../../../../src/lib/resolve-target.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-issues-edit-", {
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

type EditFlags = {
  readonly name?: string;
  readonly status?: "active" | "disabled";
  readonly condition?: string[];
  readonly action?: string[];
  readonly json: boolean;
};

function createContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: getConfigDir(),
  };
}

describe("alert issues edit", () => {
  let getRuleSpy: ReturnType<typeof vi.spyOn>;
  let getDocSpy: ReturnType<typeof vi.spyOn>;
  let putSpy: ReturnType<typeof vi.spyOn>;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getRuleSpy = vi.spyOn(apiClient, "getIssueAlertRule");
    getDocSpy = vi.spyOn(apiClient, "getIssueAlertWorkflowDocument");
    putSpy = vi.spyOn(apiClient, "updateIssueAlertRule");
    resolveSpy = vi.spyOn(resolveTarget, "resolveProjectBoundTargets");
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
      func.call(context, { json: true }, "test-org/test-project/42")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("merges additional fields into full workflow update body", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "42",
      name: "Rule Alpha",
      enabled: true,
      config: { frequency: 30 },
      triggers: {
        logicType: "any-short",
        conditions: [{ id: "old-condition" }],
      },
      actionFilters: [
        { logicType: "all", conditions: [], actions: [{ id: "old-action" }] },
      ],
    });
    putSpy.mockResolvedValue({
      id: "42",
      name: "Rule Beta",
      enabled: false,
    });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Rule Beta",
        status: "disabled",
        condition: ['{"id":"new-condition"}'],
        action: ['{"id":"new-action"}'],
        json: true,
      },
      "test-org/test-project/42"
    );

    expect(putSpy).toHaveBeenCalledWith("test-org", "42", {
      id: "42",
      name: "Rule Beta",
      enabled: false,
      config: { frequency: 30 },
      triggers: {
        logicType: "any-short",
        conditions: [{ id: "new-condition" }],
      },
      actionFilters: [
        { logicType: "all", conditions: [], actions: [{ id: "new-action" }] },
      ],
    });
  });

  test("seeds logicType and conditions when the rule has no action filter yet", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "42",
      name: "Rule Alpha",
      enabled: true,
      config: { frequency: 30 },
      triggers: {
        logicType: "any-short",
        conditions: [{ id: "old-condition" }],
      },
    });
    putSpy.mockResolvedValue({ id: "42", name: "Rule Alpha", enabled: true });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      { action: ['{"id":"new-action"}'], json: true },
      "test-org/test-project/42"
    );

    expect(putSpy).toHaveBeenCalledWith("test-org", "42", {
      id: "42",
      name: "Rule Alpha",
      enabled: true,
      config: { frequency: 30 },
      triggers: {
        logicType: "any-short",
        conditions: [{ id: "old-condition" }],
      },
      actionFilters: [
        { logicType: "all", conditions: [], actions: [{ id: "new-action" }] },
      ],
    });
  });

  test("maps the workflow enabled field to a status label in output", async () => {
    const context = createContext();
    resolveSpy.mockResolvedValue({ targets: [sampleTarget] });
    getRuleSpy.mockResolvedValue(sampleRule);
    getDocSpy.mockResolvedValue({
      id: "42",
      name: "Rule Alpha",
      enabled: true,
    });
    putSpy.mockResolvedValue({ id: "42", name: "Rule Alpha", enabled: false });
    const func = (await editCommand.loader()) as unknown as (
      this: unknown,
      flags: EditFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      { status: "disabled", json: true },
      "test-org/test-project/42"
    );

    const output = context.stdout.write.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toMatchObject({ id: "42", status: "disabled" });
  });
});
