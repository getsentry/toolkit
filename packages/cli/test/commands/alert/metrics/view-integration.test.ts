import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../../src/commands/alert/metrics/view.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as browser from "../../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setAuthToken } from "../../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("alert-metrics-inspection-", {
  isolateProjectRoot: true,
});

const API_PATH = "/api/0/organizations/test-org";
const CREATED_AT = "2026-01-01T00:00:00Z";

/** Native shapes from Sentry's detector/workflow serializer tests, sanitized. */
function detector(overrides: Record<string, unknown> = {}) {
  return {
    id: "9",
    projectId: "1",
    name: "Error volume",
    description: "Detect elevated errors",
    type: "metric_issue",
    enabled: true,
    owner: null,
    createdBy: null,
    dateCreated: CREATED_AT,
    dateUpdated: CREATED_AT,
    workflowIds: ["42"],
    config: {
      detectionType: "percent",
      comparisonDelta: 3600,
      thresholdPeriod: 1,
    },
    dataSources: [
      {
        id: "10",
        organizationId: "1",
        type: "snuba_query_subscription",
        sourceId: "11",
        queryObj: {
          id: "11",
          status: 1,
          subscription: null,
          snubaQuery: {
            id: "12",
            aggregate: "count()",
            dataset: "events",
            eventTypes: ["error"],
            query: "level:error",
            timeWindow: 300,
            environment: "production",
            extrapolationMode: "unknown",
          },
        },
      },
    ],
    conditionGroup: {
      id: "13",
      organizationId: "1",
      logicType: "any",
      conditions: [
        { id: "14", type: "gt", comparison: 100, conditionResult: 75 },
        { id: "15", type: "lte", comparison: 50, conditionResult: 0 },
      ],
      actions: [],
    },
    ...overrides,
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "42",
    name: "Notify on-call",
    organizationId: "1",
    createdBy: null,
    dateCreated: CREATED_AT,
    dateUpdated: CREATED_AT,
    enabled: false,
    environment: "production",
    config: { frequency: 30 },
    owner: "team:1",
    lastTriggered: null,
    detectorIds: ["9"],
    triggers: {
      id: "21",
      organizationId: "1",
      logicType: "any-short",
      conditions: [
        {
          id: "22",
          type: "first_seen_event",
          comparison: true,
          conditionResult: true,
        },
      ],
      actions: [],
    },
    actionFilters: [
      {
        id: "23",
        organizationId: "1",
        logicType: "all",
        conditions: [
          {
            id: "24",
            type: "issue_priority_greater_or_equal",
            comparison: 75,
            conditionResult: true,
          },
        ],
        actions: [
          {
            id: "25",
            type: "slack",
            integrationId: "2",
            config: {
              targetType: "specific",
              targetDisplay: "#alerts",
              targetIdentifier: "C123EXAMPLE",
            },
            data: { tags: "environment", notes: "Investigate elevated errors" },
            status: "disabled",
          },
          {
            id: "26",
            type: "pagerduty",
            integrationId: "3",
            config: { targetType: "specific", targetIdentifier: "service-1" },
            data: { priority: "critical" },
            status: "active",
          },
        ],
      },
    ],
    ...overrides,
  };
}

type ViewFunc = (
  this: unknown,
  flags: {
    readonly web: boolean;
    readonly json: boolean;
    readonly fields?: string[];
  },
  arg: string,
) => Promise<void>;

function createContext() {
  const stdout = {
    output: "",
    write(text: string) {
      stdout.output += text;
    },
  };
  return {
    context: {
      process,
      stdout,
      stderr: { write: vi.fn() },
      cwd: getConfigDir(),
    },
    stdout,
  };
}

function mockEndpoints(
  document: Record<string, unknown> = detector(),
  workflowReplies: Record<string, unknown> = { "42": workflow() },
) {
  const requests: string[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url.pathname);
    expect(request.method).toBe("GET");

    if (url.pathname === `${API_PATH}/detectors/`) {
      expect(url.searchParams.get("query")).toBe("type:metric_issue");
      // A list result is not the detail response: resolving by name must still
      // fetch the detector before reading its linked workflows and thresholds.
      return Response.json([
        { id: "9", name: "Error volume", type: "metric_issue" },
      ]);
    }
    if (url.pathname === `${API_PATH}/detectors/9/`) {
      return Response.json(document);
    }
    const workflowId = url.pathname.match(/\/workflows\/(\d+)\/$/)?.[1];
    if (workflowId && Object.hasOwn(workflowReplies, workflowId)) {
      const reply = workflowReplies[workflowId];
      if (reply instanceof Error) {
        throw reply;
      }
      if (typeof reply === "number") {
        return Response.json(
          { detail: "Workflow unavailable" },
          { status: reply },
        );
      }
      return Response.json(reply);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return requests;
}

describe("alert metrics view inspection through the API", () => {
  let originalFetch: typeof fetch;
  let func: ViewFunc;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    resetAuthenticatedFetch();
    setAuthToken("test-token");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    func = (await viewCommand.loader()) as unknown as ViewFunc;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAuthenticatedFetch();
    vi.restoreAllMocks();
  });

  test.each(["9", "Error volume"])(
    "preserves detection and notification settings when viewing %s",
    async (ref) => {
      const document = detector();
      const linkedWorkflow = workflow();
      const requests = mockEndpoints(document, { "42": linkedWorkflow });
      const { context, stdout } = createContext();

      await func.call(context, { web: false, json: true }, `test-org/${ref}`);

      const result = JSON.parse(stdout.output);
      expect(result).toMatchObject({
        id: "9",
        org: "test-org",
        aggregate: "count()",
        query: "level:error",
        timeWindow: 5,
        environment: "production",
        workflowIds: ["42"],
        config: document.config,
        conditionGroup: document.conditionGroup,
      });
      expect(result.workflows).toEqual([linkedWorkflow]);
      expect(requests).toEqual([
        ...(ref === "9" ? [] : [`${API_PATH}/detectors/`]),
        `${API_PATH}/detectors/9/`,
        `${API_PATH}/workflows/42/`,
      ]);
    },
  );

  test("--fields retains structured anomaly thresholds and complete workflow documents", async () => {
    const document = detector({
      config: { detectionType: "dynamic" },
      conditionGroup: {
        id: "13",
        organizationId: "1",
        logicType: "any",
        conditions: [
          {
            id: "14",
            type: "anomaly_detection",
            comparison: {
              sensitivity: "medium",
              thresholdType: 0,
              seasonality: "auto",
            },
            conditionResult: 75,
          },
        ],
        actions: [],
      },
    });
    const linkedWorkflow = workflow();
    mockEndpoints(document, { "42": linkedWorkflow });
    const { context, stdout } = createContext();

    await func.call(
      context,
      {
        web: false,
        json: true,
        fields: ["id", "config", "conditionGroup", "workflows"],
      },
      "test-org/9",
    );

    expect(JSON.parse(stdout.output)).toEqual({
      id: "9",
      config: document.config,
      conditionGroup: document.conditionGroup,
      workflows: [linkedWorkflow],
    });
  });

  test("keeps readable workflows and reports inaccessible or missing linked workflows", async () => {
    const linkedWorkflow = workflow();
    const requests = mockEndpoints(
      detector({ workflowIds: ["42", "43", "44", "42"] }),
      { "42": linkedWorkflow, "43": 403, "44": 404 },
    );
    const { context, stdout } = createContext();

    await func.call(context, { web: false, json: true }, "test-org/9");

    const result = JSON.parse(stdout.output);
    expect(result.id).toBe("9");
    expect(result.workflows).toEqual([linkedWorkflow]);
    expect(result.workflowErrors).toEqual([
      { id: "43", status: 403 },
      { id: "44", status: 404 },
    ]);
    expect(
      requests.filter((path) => path === `${API_PATH}/workflows/42/`),
    ).toHaveLength(1);
  });

  test.each([[], null, undefined])(
    "does not invent workflow connections when workflowIds is %j",
    async (workflowIds) => {
      const requests = mockEndpoints(detector({ workflowIds }), {});
      const { context, stdout } = createContext();

      await func.call(context, { web: false, json: true }, "test-org/9");

      const result = JSON.parse(stdout.output);
      expect(result.workflowIds).toEqual(workflowIds);
      expect(result.workflows).toEqual([]);
      expect(requests).toEqual([`${API_PATH}/detectors/9/`]);
    },
  );

  test.each([
    { name: "authentication", reply: 401, status: 401 },
    { name: "server", reply: 500, status: 500 },
    { name: "network", reply: new Error("Connection reset"), status: 0 },
  ])(
    "propagates $name failures instead of claiming inspection succeeded",
    async ({ reply, status }) => {
      mockEndpoints(detector(), { "42": reply });
      const { context, stdout } = createContext();

      await expect(
        func.call(context, { web: false, json: true }, "test-org/9"),
      ).rejects.toMatchObject({ name: "ApiError", status });
      expect(stdout.output).toBe("");
    },
  );

  test("--web opens the browser without fetching detector or workflow details", async () => {
    const requests = mockEndpoints();
    const open = vi
      .spyOn(browser, "openInBrowser")
      .mockResolvedValue(undefined);
    const { context } = createContext();

    await func.call(context, { web: true, json: false }, "test-org/9");

    expect(requests).toEqual([]);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("test-org"),
      "metric alert rules",
    );
  });
});
