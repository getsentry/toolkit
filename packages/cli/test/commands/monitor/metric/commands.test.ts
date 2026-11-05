import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../../src/commands/monitor/metric/create.js";
import { editCommand } from "../../../../src/commands/monitor/metric/edit.js";
import { deleteCommand } from "../../../../src/commands/monitor/metric/delete.js";
import { viewCommand } from "../../../../src/commands/monitor/metric/view.js";
import { listCommand } from "../../../../src/commands/monitor/metric/list.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setAuthToken } from "../../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../../src/lib/sentry-client.js";
import {
  metricMonitor,
  nativeMonitorCreateBody,
} from "../../../fixtures/metric-monitors.js";
import { mockFetch, useTestConfigDir } from "../../../helpers.js";

const configDir = useTestConfigDir("monitor-metric-commands-", {
  isolateProjectRoot: true,
});
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

async function invoke(
  command: typeof createCommand,
  verb: string,
  flags: Record<string, unknown>,
  target: string,
) {
  const chunks: string[] = [];
  const context = {
    cwd: configDir(),
    commandPrefix: ["sentry", "monitor", "metric", verb],
    stdout: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
    stderr: { write: vi.fn(() => true) },
  };
  const func = (await command.loader()) as unknown as (
    this: typeof context,
    flags: Record<string, unknown>,
    target: string,
  ) => Promise<void>;
  await func.call(context, { json: true, "dry-run": false, ...flags }, target);
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

const createFlags = {
  name: "Error volume",
  query: "",
  aggregate: "count()",
  dataset: "errors",
  "time-window": 5,
  critical: 100,
};

describe("native metric monitor commands", () => {
  test("create dry-run contains the exact native request and permits an empty query", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("Dry run must not send a request");
    });
    const result = await invoke(
      createCommand,
      "create",
      { ...createFlags, "dry-run": true },
      "test-org/web",
    );
    expect(result).toEqual({
      org: "test-org",
      project: "web",
      dryRun: true,
      body: nativeMonitorCreateBody,
    });
  });

  test("create sends the same native body and outputs enabled, not legacy status", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual(nativeMonitorCreateBody);
      return Response.json(metricMonitor(), { status: 201 });
    });
    const result = await invoke(
      createCommand,
      "create",
      createFlags,
      "test-org/web",
    );
    expect(result).toMatchObject({
      org: "test-org",
      enabled: true,
      dataSources: metricMonitor().dataSources,
    });
    expect(result).not.toHaveProperty("status");
  });

  test("create rejects multiple project targets instead of truncating", async () => {
    await expect(
      invoke(
        createCommand,
        "create",
        { ...createFlags, "dry-run": true },
        "test-org/web,api",
      ),
    ).rejects.toThrow();
    await expect(
      invoke(
        createCommand,
        "create",
        { ...createFlags, "dry-run": true },
        "test-org/",
      ),
    ).rejects.toThrow();
  });

  test("dynamic monitors accept distinct warning and critical anomaly conditions", async () => {
    const condition = {
      type: "anomaly_detection",
      comparison: {
        sensitivity: "medium",
        seasonality: "auto",
        thresholdType: 0,
      },
      conditionResult: 75,
    };
    const warning = {
      ...condition,
      comparison: { ...condition.comparison, sensitivity: "high" },
      conditionResult: 50,
    };
    const conditions = [warning, condition];
    const { critical: _critical, ...flags } = createFlags;
    const result = await invoke(
      createCommand,
      "create",
      {
        ...flags,
        config: '{"detectionType":"dynamic"}',
        condition: conditions.map((value) => JSON.stringify(value)),
        "dry-run": true,
      },
      "test-org/web",
    );
    expect(result.body).toMatchObject({
      conditionGroup: { logicType: "any", conditions },
      config: { detectionType: "dynamic" },
    });
  });

  test("threshold shorthand builds warning and inverse resolution conditions and conflicts clearly", async () => {
    const result = await invoke(
      createCommand,
      "create",
      {
        ...createFlags,
        warning: 80,
        resolve: 70,
        comparison: "lt",
        "dry-run": true,
      },
      "test-org/web",
    );
    expect(result.body).toMatchObject({
      conditionGroup: {
        conditions: [
          { type: "lt", comparison: 100, conditionResult: 75 },
          { type: "lt", comparison: 80, conditionResult: 50 },
          { type: "gte", comparison: 70, conditionResult: 0 },
        ],
      },
    });
    await expect(
      invoke(
        createCommand,
        "create",
        {
          ...createFlags,
          condition: ['{"type":"gt","comparison":1,"conditionResult":75}'],
          "dry-run": true,
        },
        "test-org/web",
      ),
    ).rejects.toThrow("not both");
  });

  test("edit preserves stored query fields and percent mode while converting minutes exactly once", async () => {
    const current = metricMonitor();
    const writes: unknown[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      if (request.method === "PUT") writes.push(await request.json());
      return Response.json(current);
    });
    const dry = await invoke(
      editCommand,
      "edit",
      { "time-window": 10, alert: ["7", "8"], "dry-run": true },
      "test-org/9",
    );
    expect(dry.body).toEqual({
      workflowIds: [7, 8],
      dataSources: [
        {
          aggregate: "count()",
          dataset: "events",
          eventTypes: ["error"],
          query: "level:error",
          timeWindow: 600,
          environment: "production",
          extrapolationMode: "client_and_server_weighted",
        },
      ],
    });
    await invoke(
      editCommand,
      "edit",
      { "time-window": 10, alert: ["7", "8"] },
      "test-org/9",
    );
    expect(writes).toEqual([dry.body]);
    expect(dry.body).not.toHaveProperty("config");
    expect(dry.body).not.toHaveProperty("conditionGroup");
  });

  test("metadata-only edits do not rewrite any dynamic detector settings", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(metricMonitor({ config: { detectionType: "dynamic" } })),
    );
    const result = await invoke(
      editCommand,
      "edit",
      { enabled: false, description: "Pause", "dry-run": true },
      "test-org/9",
    );
    expect(result.body).toEqual({ enabled: false, description: "Pause" });
  });

  test("view preserves native documents and marks inaccessible alerts without hiding the monitor", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      return new URL(request.url).pathname.endsWith("/workflows/42/")
        ? Response.json({ detail: "denied" }, { status: 403 })
        : Response.json(metricMonitor());
    });
    const result = await invoke(
      viewCommand,
      "view",
      { web: false },
      "test-org/9",
    );
    expect(result).toMatchObject({
      ...metricMonitor(),
      org: "test-org",
      workflows: [],
      workflowErrors: [{ id: "42", status: 403 }],
    });
  });

  test("name resolution exhausts pages and reports same-org ambiguity", async () => {
    const cursors: (string | null)[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      cursors.push(url.searchParams.get("cursor"));
      return Response.json(
        [metricMonitor({ id: cursors.length === 1 ? "9" : "10" })],
        cursors.length === 1
          ? {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/test-org/detectors/?cursor=next>; rel="next"; results="true"; cursor="next"',
              },
            }
          : {},
      );
    });
    await expect(
      invoke(viewCommand, "view", { web: false }, "test-org/Error volume"),
    ).rejects.toThrow("ambiguous");
    expect(cursors).toEqual([null, "next"]);
  });

  test("list returns native detector documents and passes query to the filtered endpoint", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input!, init).url);
      expect(url.searchParams.get("query")).toBe(
        "type:metric_issue name:Latency",
      );
      expect(url.searchParams.getAll("project")).toEqual(["-1"]);
      return Response.json([metricMonitor()]);
    });
    const result = await invoke(
      listCommand,
      "list",
      { limit: 10, fresh: false, web: false, query: "name:Latency" },
      "test-org/",
    );
    expect(result.data).toEqual([
      expect.objectContaining({ ...metricMonitor(), orgSlug: "test-org" }),
    ]);
  });

  test("delete previews and deletes only a metric detector", async () => {
    const methods: string[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const request = new Request(input!, init);
      methods.push(request.method);
      return request.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(metricMonitor());
    });
    expect(
      await invoke(deleteCommand, "delete", { "dry-run": true }, "test-org/9"),
    ).toMatchObject({ dryRun: true, id: "9" });
    expect(
      await invoke(
        deleteCommand,
        "delete",
        { yes: true, force: false },
        "test-org/9",
      ),
    ).toMatchObject({ deleted: true, id: "9" });
    expect(methods.filter((method) => method === "DELETE")).toHaveLength(1);
  });
});

test("native percent config edits preserve omitted settings and native source fields", async () => {
  globalThis.fetch = mockFetch(async () => Response.json(metricMonitor()));
  const result = await invoke(
    editCommand,
    "edit",
    { config: '{"comparisonDelta":7200}', "dry-run": true },
    "test-org/9",
  );
  expect(result.body).toEqual({
    config: {
      detectionType: "percent",
      comparisonDelta: 7200,
      thresholdPeriod: 1,
    },
  });
});

test("connected alert IDs reject zero instead of sending a nonexistent workflow", async () => {
  await expect(
    invoke(
      createCommand,
      "create",
      { ...createFlags, alert: ["0"], "dry-run": true },
      "test-org/web",
    ),
  ).rejects.toThrow("positive safe integer");
});
