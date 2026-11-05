import type { Command } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveAlert } from "../../../src/commands/alert/arguments.js";
import { createCommand } from "../../../src/commands/alert/create.js";
import { deleteCommand } from "../../../src/commands/alert/delete.js";
import { editCommand } from "../../../src/commands/alert/edit.js";
import { listCommand } from "../../../src/commands/alert/list.js";
import { viewCommand } from "../../../src/commands/alert/view.js";
import type { SentryContext } from "../../../src/context.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- public API spies keep command orchestration real
import * as alertsApi from "../../../src/lib/api/alerts.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { workflow } from "../../fixtures/workflow.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("native-alert-commands-", {
  isolateProjectRoot: true,
});

async function run(
  command: Command<SentryContext>,
  name: string,
  flags: Record<string, unknown>,
  arg: string,
) {
  const stdout = vi.fn<(text: string) => boolean>(() => true);
  const context = {
    stdout: { write: stdout },
    stderr: { write: vi.fn(() => true) },
    cwd: getConfigDir(),
    commandPrefix: ["sentry", "alert", name],
  };
  const func = (await command.loader()) as unknown as (
    this: unknown,
    flags: Record<string, unknown>,
    arg: string,
  ) => Promise<void>;
  await func.call(
    context,
    { json: true, "dry-run": false, web: false, ...flags },
    arg,
  );
  return JSON.parse(stdout.mock.calls.map(([text]) => text).join(""));
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
  vi.restoreAllMocks();
});

describe("native alert commands", () => {
  test("list retains detached alerts and complete nested workflow state", async () => {
    const detached = workflow({ detectorIds: [] });
    const list = vi
      .spyOn(alertsApi, "listAlertsPaginated")
      .mockResolvedValue({ data: [detached] });
    const output = await run(listCommand, "list", { limit: 10 }, "test-org/");
    expect(output.data).toEqual([{ ...detached, orgSlug: "test-org" }]);
    expect(output.hasMore).toBe(false);
    expect(list).toHaveBeenCalledWith(
      "test-org",
      expect.objectContaining({ perPage: 10 }),
    );
    expect(output.data[0]).not.toHaveProperty("status");
  });

  test("list forwards search and explicit monitor/project scope", async () => {
    const list = vi
      .spyOn(alertsApi, "listAlertsPaginated")
      .mockResolvedValue({ data: [] });
    await run(
      listCommand,
      "list",
      {
        limit: 10,
        monitor: ["9,10"],
        project: ["backend"],
        query: "action:slack",
      },
      "test-org/",
    );
    expect(list).toHaveBeenCalledWith(
      "test-org",
      expect.objectContaining({
        monitor: ["9", "10"],
        project: ["backend"],
        query: "action:slack",
      }),
    );
  });

  test("view returns a detached native workflow by ID", async () => {
    const document = workflow({ detectorIds: [] });
    const get = vi.spyOn(alertsApi, "getAlert").mockResolvedValue(document);
    expect(await run(viewCommand, "view", {}, "test-org/42")).toEqual({
      ...document,
      org: "test-org",
    });
    expect(get).toHaveBeenCalledWith("test-org", "42");
  });

  test("create links a metric monitor using the native org request", async () => {
    const create = vi
      .spyOn(alertsApi, "createAlert")
      .mockResolvedValue(workflow({ enabled: true }));
    const action = {
      type: "email",
      data: {},
      config: { targetType: "team", targetIdentifier: "7" },
    };
    const output = await run(
      createCommand,
      "create",
      {
        name: "Metric notifications",
        monitor: ["9"],
        frequency: 0,
        action: [JSON.stringify(action)],
      },
      "test-org/",
    );
    expect(create).toHaveBeenCalledWith("test-org", {
      name: "Metric notifications",
      enabled: true,
      detectorIds: [9],
      config: { frequency: 0 },
      actionFilters: [{ logicType: "all", conditions: [], actions: [action] }],
    });
    expect(output).toEqual({ ...workflow({ enabled: true }), org: "test-org" });
  });

  test("create supports an organization alert with no project or monitor", async () => {
    const create = vi
      .spyOn(alertsApi, "createAlert")
      .mockResolvedValue(workflow({ detectorIds: [] }));
    await run(createCommand, "create", { name: "Detached" }, "test-org/");
    expect(create).toHaveBeenCalledWith("test-org", {
      name: "Detached",
      enabled: true,
    });
  });

  test("project selection creates an alert on the issue stream, not an error or metric detector", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/detectors/")) {
        expect(url.searchParams.getAll("project")).toEqual(["backend"]);
        expect(url.searchParams.get("query")).toBe("type:issue_stream");
        return Response.json([
          { id: "90", type: "issue_stream", projectId: "1" },
        ]);
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        body: await request.json(),
      });
      return Response.json(
        workflow({ name: "New issues", detectorIds: ["90"] }),
        { status: 201 },
      );
    });
    await run(
      createCommand,
      "create",
      {
        name: "New issues",
        project: "backend",
        trigger: ["first-seen"],
        frequency: 30,
        action: [
          '{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"7"}}',
        ],
      },
      "test-org/",
    );
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/0/organizations/test-org/workflows/",
        body: {
          name: "New issues",
          enabled: true,
          detectorIds: [90],
          config: { frequency: 30 },
          triggers: {
            logicType: "any-short",
            conditions: [
              {
                type: "first_seen_event",
                comparison: true,
                conditionResult: true,
              },
            ],
          },
          actionFilters: [
            {
              logicType: "all",
              conditions: [],
              actions: [
                {
                  type: "email",
                  data: {},
                  config: { targetType: "team", targetIdentifier: "7" },
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  test("project-scoped edit previews replacement connections without changing the disabled state", async () => {
    const current = workflow();
    const methods: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      methods.push(request.method);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/detectors/")) {
        return Response.json([
          { id: "90", type: "issue_stream", projectId: "1" },
        ]);
      }
      return Response.json(current);
    });
    const preview = await run(
      editCommand,
      "edit",
      { project: "backend", trigger: ["resolved"], "dry-run": true },
      "test-org/42",
    );
    expect(preview.body).toEqual({
      name: current.name,
      enabled: false,
      detectorIds: [90],
      triggers: {
        ...current.triggers,
        logicType: "any-short",
        conditions: [
          {
            type: "issue_resolved_trigger",
            comparison: true,
            conditionResult: true,
          },
        ],
      },
    });
    expect(methods).toEqual(["GET", "GET"]);
  });

  test.each([[[]], [[{ id: "90" }, { id: "91" }]]])(
    "does not create a detached or arbitrarily scoped alert when project scope is unresolved (%j)",
    async (detectors) => {
      const methods: string[] = [];
      globalThis.fetch = mockFetch(async (input, init) => {
        methods.push(new Request(input!, init).method);
        return Response.json(detectors);
      });
      await expect(
        run(
          createCommand,
          "create",
          { name: "Scoped", project: "backend" },
          "test-org/",
        ),
      ).rejects.toThrow("Expected one issue stream");
      expect(methods).toEqual(["GET"]);
    },
  );

  test.each([{ project: "backend", monitor: ["9"] }, { project: "-1" }])(
    "rejects ambiguous project selection before making requests (%j)",
    async (selection) => {
      const requests: string[] = [];
      globalThis.fetch = mockFetch(async (input, init) => {
        requests.push(new Request(input!, init).method);
        return Response.json([]);
      });
      await expect(
        run(
          createCommand,
          "create",
          { name: "Scoped", ...selection },
          "test-org/",
        ),
      ).rejects.toThrow(/Use --project or --monitor|select one project/);
      expect(requests).toEqual([]);
    },
  );

  test("dry-run prints exactly the native create request, including full config and action groups", async () => {
    const create = vi.spyOn(alertsApi, "createAlert");
    const groups = [
      {
        logicType: "all",
        conditions: [],
        actions: [
          {
            type: "email",
            data: {},
            config: { targetType: "team", targetIdentifier: "7" },
          },
        ],
      },
    ];
    const flags = {
      name: "New issues",
      trigger: ["first-seen,regression"],
      config: '{"frequency":0}',
      "action-filter": [JSON.stringify(groups)],
      enabled: false,
    };
    const output = await run(
      createCommand,
      "create",
      { ...flags, "dry-run": true },
      "test-org/",
    );
    expect(output.body).toEqual({
      name: "New issues",
      enabled: false,
      config: { frequency: 0 },
      triggers: {
        logicType: "any-short",
        conditions: [
          { type: "first_seen_event", comparison: true, conditionResult: true },
          { type: "regression_event", comparison: true, conditionResult: true },
        ],
      },
      actionFilters: groups,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("renaming a disabled alert preserves native enabled state and leaves config/groups/links untouched", async () => {
    const current = workflow();
    vi.spyOn(alertsApi, "getAlert").mockResolvedValue(current);
    const update = vi
      .spyOn(alertsApi, "updateAlert")
      .mockResolvedValue(workflow({ name: "Renamed" }));
    const output = await run(
      editCommand,
      "edit",
      { name: "Renamed" },
      "test-org/42",
    );
    // WorkflowValidator requires name, defaults enabled to true, and preserves
    // omitted config, groups and detectorIds. Never send a flattened baseline.
    expect(update).toHaveBeenCalledWith("test-org", "42", {
      name: "Renamed",
      enabled: false,
    });
    expect(output).toEqual({ ...current, name: "Renamed", org: "test-org" });
  });

  test("editing first-group filters preserves native actions, group IDs, other groups and full config", async () => {
    const current = workflow({
      config: { frequency: 30, futureSetting: "preserved" },
    });
    vi.spyOn(alertsApi, "getAlert").mockResolvedValue(current);
    const update = vi.spyOn(alertsApi, "updateAlert");
    const filter = { type: "eq", comparison: 50, conditionResult: true };
    const output = await run(
      editCommand,
      "edit",
      { frequency: 0, filter: [JSON.stringify(filter)], "dry-run": true },
      "test-org/42",
    );
    expect(output.body).toEqual({
      name: current.name,
      enabled: false,
      config: { frequency: 0, futureSetting: "preserved" },
      actionFilters: [
        { ...current.actionFilters?.[0], conditions: [filter] },
        current.actionFilters?.[1],
      ],
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("delete removes the workflow, not the linked monitor", async () => {
    vi.spyOn(alertsApi, "getAlert").mockResolvedValue(workflow());
    const remove = vi
      .spyOn(alertsApi, "deleteAlert")
      .mockResolvedValue(undefined);
    expect(
      await run(deleteCommand, "delete", { yes: true }, "test-org/42"),
    ).toEqual({
      org: "test-org",
      id: "42",
      name: "Notify on-call",
      deleted: true,
    });
    expect(remove).toHaveBeenCalledWith("test-org", "42");
  });

  test("delete dry-run never writes and requires an explicit organization", async () => {
    vi.spyOn(alertsApi, "getAlert").mockResolvedValue(
      workflow({ detectorIds: [] }),
    );
    const remove = vi.spyOn(alertsApi, "deleteAlert");
    expect(
      await run(deleteCommand, "delete", { "dry-run": true }, "test-org/42"),
    ).toMatchObject({ dryRun: true, id: "42", org: "test-org" });
    await expect(
      run(deleteCommand, "delete", { "dry-run": true }, "42"),
    ).rejects.toThrow("explicit");
    expect(remove).not.toHaveBeenCalled();
  });

  test("resolves exact names across all pages including detached matches", async () => {
    const document = workflow({ id: "43", name: "Detached", detectorIds: [] });
    const list = vi
      .spyOn(alertsApi, "listAlertsPaginated")
      .mockResolvedValueOnce({ data: [workflow()], nextCursor: "page-two" })
      .mockResolvedValueOnce({ data: [document] });
    vi.spyOn(alertsApi, "getAlert").mockResolvedValue(document);
    expect(await resolveAlert("test-org", "detached")).toEqual(document);
    expect(list).toHaveBeenLastCalledWith("test-org", {
      perPage: 100,
      cursor: "page-two",
    });
  });

  test("rejects ambiguous names even when another match appears on a later page", async () => {
    vi.spyOn(alertsApi, "listAlertsPaginated")
      .mockResolvedValueOnce({ data: [workflow()], nextCursor: "page-two" })
      .mockResolvedValueOnce({ data: [workflow({ id: "43" })] });
    const get = vi.spyOn(alertsApi, "getAlert");
    await expect(resolveAlert("test-org", "Notify on-call")).rejects.toThrow(
      "ambiguous",
    );
    expect(get).not.toHaveBeenCalled();
  });

  test("refuses partial name resolution when pagination repeats a cursor", async () => {
    vi.spyOn(alertsApi, "listAlertsPaginated").mockResolvedValue({
      data: [workflow()],
      nextCursor: "same-page",
    });
    await expect(resolveAlert("test-org", "Notify on-call")).rejects.toThrow(
      "repeated a cursor",
    );
  });
});
