import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils/context";
import { metricMonitor } from "../../test-utils/metric-monitor";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import { executeToolHandler } from "../catalog-runtime/availability";
import createAlertRule from "./create-alert-rule";

const context = createTestContext();
const endpoint =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/";
const detectorsEndpoint = endpoint.replace("workflows/", "detectors/");
const projectId = "4509109104082945";
const scopedContext = createTestContext({
  constraints: { projectSlug: "cloudflare-mcp" },
});
const triggerCondition = {
  type: "first_seen_event",
  comparison: true,
  conditionResult: true,
};

function createRule(
  changes: Record<string, unknown>,
  toolContext: Parameters<typeof createAlertRule.handler>[1] = context,
) {
  return executeToolHandler({
    tool: createAlertRule,
    params: {
      organizationSlug: "sentry-mcp-evals",
      name: "Backend notifications",
      actionFilters: [],
      ...changes,
    },
    context: toolContext,
  });
}

function useCreateHandler() {
  const writes: Record<string, unknown>[] = [];
  mswServer.use(
    http.post(endpoint, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      return HttpResponse.json(
        { id: "123", environment: null, owner: null, triggers: null, ...body },
        { status: 201 },
      );
    }),
  );
  return writes;
}

describe("create_alert_rule", () => {
  it("copies configuration without component IDs and connects project and monitor sources", async () => {
    const writes = useCreateHandler();
    mswServer.use(
      http.get(detectorsEndpoint, () =>
        HttpResponse.json([
          { ...metricMonitor, id: "456", projectId, type: "issue_stream" },
        ]),
      ),
      http.get(`${detectorsEndpoint}789/`, () =>
        HttpResponse.json({ ...metricMonitor, id: "789", projectId }),
      ),
    );
    const action = {
      type: "msteams",
      status: "disabled",
      integrationId: "5",
      data: {},
      config: { targetDisplay: "Incidents", targetIdentifier: "19:channel" },
    };
    const triggers = { logicType: "any-short", conditions: [triggerCondition] };
    const filterCondition = {
      ...triggerCondition,
      type: "issue_priority_greater_or_equal",
      comparison: 75,
    };
    const actionFilters = [
      { logicType: "all", conditions: [filterCondition], actions: [action] },
    ];
    const result = await createRule(
      {
        status: "disabled",
        frequencyMinutes: 0,
        owner: "team:7",
        environment: "production",
        projectSlugs: ["cloudflare-mcp"],
        detectorIds: ["789"],
        triggers: {
          ...triggers,
          id: "10",
          conditions: [{ ...triggerCondition, id: "11" }],
        },
        actionFilters: [
          {
            ...actionFilters[0],
            id: "20",
            conditions: [{ ...filterCondition, id: "21" }],
            actions: [{ ...action, id: "22" }],
          },
        ],
      },
      scopedContext,
    );

    expect(writes).toEqual([
      {
        name: "Backend notifications",
        enabled: false,
        config: { frequency: 0 },
        owner: "team:7",
        environment: "production",
        detectorIds: ["456", "789"],
        triggers,
        actionFilters,
      },
    ]);
    expect(getStructuredContent(result)).toMatchObject({
      alertRule: { id: "123", ...writes[0] },
    });
  });

  it("creates explicitly detached Alerts with defaults and connection guidance", async () => {
    const writes = useCreateHandler();
    const result = await createRule({
      detectorIds: [],
      triggers: { id: "10", logicType: "any", conditions: [] },
    });

    expect(writes[0]).not.toHaveProperty("triggers");
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "alertRule": {
          "actionFilters": [],
          "config": {
            "frequency": 30,
          },
          "detectorIds": [],
          "enabled": true,
          "environment": null,
          "id": "123",
          "name": "Backend notifications",
          "owner": null,
          "triggers": null,
          "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/alerts/123/",
        },
        "guidance": "This Alert has no sources and will not send notifications until connected using update_alert_rule.",
      }
    `);
  });

  it.each([
    [{}, "Specify projectSlugs or detectorIds"],
    [
      {
        detectorIds: [],
        triggers: {
          logicType: "any",
          conditions: [triggerCondition],
        },
      },
      "any-short",
    ],
  ])(
    "rejects incomplete or invalid creation arguments %j",
    async (changes, message) => {
      const writes = useCreateHandler();
      await expect(createRule(changes)).rejects.toThrow(message);
      expect(writes).toEqual([]);
    },
  );

  it.each([
    ["200", ["789"], "outside the active project constraint"],
    [null, ["789"], "outside the active project constraint"],
    [projectId, [], "requires an organization-wide session"],
  ])(
    "rejects foreign, all-project or detached sources in project sessions: %s %j",
    async (sourceProjectId, detectorIds, message) => {
      const writes = useCreateHandler();
      mswServer.use(
        http.get(`${detectorsEndpoint}789/`, () =>
          HttpResponse.json({
            ...metricMonitor,
            id: "789",
            projectId: sourceProjectId,
          }),
        ),
      );
      await expect(createRule({ detectorIds }, scopedContext)).rejects.toThrow(
        message,
      );
      expect(writes).toEqual([]);
    },
  );

  it("reports saved Slack destinations that Sentry did not resolve", async () => {
    const writes = useCreateHandler();
    await expect(
      createRule({
        detectorIds: [],
        actionFilters: [
          {
            logicType: "all",
            conditions: [],
            actions: [
              {
                type: "slack",
                integrationId: "5",
                data: {},
                config: { targetDisplay: "#incidents" },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/Alert 123 was created.*Do not create another Alert/);
    expect(writes).toHaveLength(1);
  });
});
