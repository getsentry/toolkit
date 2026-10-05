import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { prepareToolParams } from "../catalog-runtime/availability";
import getAlertRule from "./get-alert-rule.js";
import updateAlertRule from "./update-alert-rule.js";

const context = {
  constraints: { organizationSlug: null },
  accessToken: "access-token",
  userId: "1",
};

const params = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  projectSlug: null,
  ruleIdOrName: "123",
};

const endpoint =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/123/";
const detectorsEndpoint =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/detectors/";
const detector = {
  id: "456",
  projectId: "100",
  name: "Project issue stream",
  type: "issue_stream",
  enabled: true,
  config: {},
  conditionGroup: null,
  dataSources: [],
  workflowIds: [],
  dateCreated: "2026-01-01T00:00:00Z",
  dateUpdated: "2026-01-01T00:00:00Z",
};

const slackAction = {
  id: "21",
  type: "slack",
  integrationId: "5",
  data: { tags: "environment" },
  config: {
    targetType: "specific",
    targetDisplay: "#old-channel",
    targetIdentifier: "COLD",
  },
};
const alertRule = {
  id: "123",
  name: "Notify backend team",
  enabled: false,
  config: { frequency: 30 },
  environment: "production",
  owner: "team:7",
  triggers: null,
  detectorIds: ["789"],
  actionFilters: [
    {
      id: "20",
      logicType: "all" as const,
      conditions: [],
      actions: [slackAction],
    },
  ],
};

function updateRule(
  changes: Partial<Parameters<typeof updateAlertRule.handler>[0]> = {},
  toolContext: Parameters<typeof updateAlertRule.handler>[1] = context,
) {
  return updateAlertRule.handler({ ...params, ...changes }, toolContext);
}

function useAlertRuleHandlers(workflow: Record<string, unknown> = alertRule) {
  const reads: string[] = [];
  const writes: Record<string, unknown>[] = [];
  mswServer.use(
    http.get(endpoint, ({ request }) => {
      reads.push(request.url);
      return HttpResponse.json(workflow);
    }),
    http.put(endpoint, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      return HttpResponse.json({ ...workflow, ...body });
    }),
  );
  return { reads, writes };
}

function useProjectScope(projectIds: string[], includesAllProjects = false) {
  mswServer.use(
    http.get(
      "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
      () =>
        HttpResponse.json({
          id: "100",
          slug: "cloudflare-mcp",
          name: "Cloudflare MCP",
        }),
    ),
    http.get(`${endpoint}project-scope/`, () =>
      HttpResponse.json({ projectIds, includesAllProjects }),
    ),
  );
}

describe("update_alert_rule", () => {
  it("reports when Sentry saves a Slack destination without resolving its channel ID", async () => {
    const { writes } = useAlertRuleHandlers();
    const actionFilters = structuredClone(alertRule.actionFilters);
    actionFilters[0].actions[0].config.targetDisplay = "#new-channel";
    actionFilters[0].actions[0].config.targetIdentifier = "";

    await expect(updateRule({ actionFilters })).rejects.toThrow(
      "The alert was saved, but Sentry did not resolve a Slack destination.",
    );
    expect(writes[0]).toMatchObject({ enabled: false, actionFilters });
  });

  it("preserves a disabled alert and untouched configuration while clearing optional fields", async () => {
    const { writes } = useAlertRuleHandlers();

    const result = await updateRule({
      frequencyMinutes: 0,
      environment: null,
      owner: null,
    });

    expect(writes).toEqual([
      {
        name: alertRule.name,
        enabled: false,
        config: { frequency: 0 },
        environment: null,
        owner: null,
      },
    ]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "alertRule": {
          "actionFilters": [
            {
              "actions": [
                {
                  "config": {
                    "targetDisplay": "#old-channel",
                    "targetIdentifier": "COLD",
                    "targetType": "specific",
                  },
                  "data": {
                    "tags": "environment",
                  },
                  "id": "21",
                  "integrationId": "5",
                  "type": "slack",
                },
              ],
              "conditions": [],
              "id": "20",
              "logicType": "all",
            },
          ],
          "config": {
            "frequency": 0,
          },
          "detectorIds": [
            "789",
          ],
          "enabled": false,
          "environment": null,
          "id": "123",
          "name": "Notify backend team",
          "owner": null,
          "triggers": null,
          "webUrl": "https://sentry-mcp-evals.sentry.io/monitors/alerts/123/",
        },
      }
    `);
  });

  it.each([
    { source: "copied", inputId: "COLD", expectedId: undefined },
    { source: "explicit", inputId: "CNEW", expectedId: "CNEW" },
    {
      source: "changed workspace",
      inputId: "COLD",
      expectedId: undefined,
      integrationId: "6",
      targetDisplay: "#old-channel",
    },
  ])(
    "handles a $source Slack channel ID while preserving other actions and groups",
    async ({
      inputId,
      expectedId,
      integrationId = "5",
      targetDisplay = "#new-channel",
    }) => {
      const { writes } = useAlertRuleHandlers();
      const actionFilters: Parameters<
        typeof updateAlertRule.handler
      >[0]["actionFilters"] = structuredClone(alertRule.actionFilters);
      actionFilters[0].actions.push({
        id: "22",
        type: "email",
        integrationId: null,
        data: {},
        config: {
          targetType: "team",
          targetDisplay: null,
          targetIdentifier: "7",
        },
      });
      actionFilters.push({
        ...actionFilters[0],
        id: "30",
        actions: [{ ...slackAction, id: "31" }],
      });
      actionFilters[0].actions[0].config = {
        ...slackAction.config,
        targetDisplay,
        targetIdentifier: inputId,
      };
      actionFilters[0].actions[0].integrationId = integrationId;
      const savedFilters = structuredClone(actionFilters);
      savedFilters[0].actions[0].config.targetIdentifier = "CNEW";
      mswServer.use(
        http.put(endpoint, async ({ request }) => {
          writes.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            ...alertRule,
            actionFilters: savedFilters,
          });
        }),
      );

      const result = await updateRule({ actionFilters });
      const expectedFilters = structuredClone(actionFilters);
      const expectedConfig: Record<string, unknown> =
        expectedFilters[0].actions[0].config;
      if (expectedId === undefined) delete expectedConfig.targetIdentifier;
      else expectedConfig.targetIdentifier = expectedId;
      expect(writes).toEqual([
        {
          name: alertRule.name,
          enabled: false,
          actionFilters: expectedFilters,
        },
      ]);
      expect(getStructuredContent(result)).toMatchObject({
        alertRule: { actionFilters: savedFilters },
      });
    },
  );

  it.each([
    ["msteams", "specific", "19:old@thread.tacv2", {}, "5"],
    ["discord", "specific", "1234567890", { tags: "environment" }, "5"],
    ["pagerduty", "specific", "42", { priority: "critical" }, "5"],
    ["opsgenie", "specific", "42", { priority: "P1" }, "5"],
    ["email", "team", "7", {}, null],
    ["webhook", null, "notification-app", {}, null],
    [
      "sentry_app",
      "sentry_app",
      "42",
      { settings: [{ name: "channel", value: "Incidents" }] },
      null,
    ],
  ] as const)(
    "roundtrips %s notification settings through read and argument validation",
    async (type, targetType, targetIdentifier, data, integrationId) => {
      const action = {
        id: "21",
        type,
        integrationId,
        data,
        config: {
          ...(targetType ? { targetType } : {}),
          targetIdentifier,
          ...(type === "msteams" ? { targetDisplay: "Incidents" } : {}),
        },
      };
      const currentAction = {
        ...action,
        config: {
          ...action.config,
          ...(type === "msteams"
            ? { targetDisplay: "Previous" }
            : { targetIdentifier: "1" }),
        },
      };
      const otherAction = { ...slackAction, id: "22" };
      const group = {
        ...alertRule.actionFilters[0],
        actions: [currentAction, otherAction],
      };
      const { writes } = useAlertRuleHandlers({
        ...alertRule,
        detectorIds: [],
        actionFilters: [group],
      });
      useProjectScope([]);
      const { alertRule: inspected } = getStructuredContent<{
        alertRule: { actionFilters: (typeof group)[] };
      }>(await getAlertRule.handler({ ...params, kind: "issue" }, context));
      const actionFilters = inspected.actionFilters;
      actionFilters[0].actions[0].config = action.config;
      // Teams always resolves the supplied name, replacing even an old channel ID.
      const savedAction =
        type === "msteams"
          ? {
              ...action,
              config: {
                ...action.config,
                targetIdentifier: "19:new@thread.tacv2",
              },
            }
          : action;
      mswServer.use(
        http.put(endpoint, async ({ request }) => {
          writes.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            ...alertRule,
            actionFilters: [{ ...group, actions: [savedAction, otherAction] }],
          });
        }),
      );

      const validatedParams = prepareToolParams({
        tool: updateAlertRule,
        params: { ...params, actionFilters },
        context,
      }) as Parameters<typeof updateAlertRule.handler>[0];
      const result = await updateAlertRule.handler(validatedParams, context);
      expect(writes).toEqual([
        {
          name: alertRule.name,
          enabled: false,
          actionFilters: [{ ...group, actions: [action, otherAction] }],
        },
      ]);
      expect(getStructuredContent(result)).toMatchObject({
        alertRule: {
          actionFilters: [{ ...group, actions: [savedAction, otherAction] }],
        },
      });
    },
  );

  it("preserves native trigger and action-filter conditions through argument validation and update", async () => {
    const changes = {
      triggers: {
        id: "10",
        logicType: "any",
        conditions: [
          {
            id: "11",
            type: "first_seen_event",
            comparison: true,
            conditionResult: true,
          },
        ],
      },
      actionFilters: [
        {
          ...alertRule.actionFilters[0],
          conditions: [
            {
              id: "23",
              type: "issue_priority_greater_or_equal",
              comparison: 75,
              conditionResult: true,
            },
          ],
        },
      ],
    };
    const { writes } = useAlertRuleHandlers({
      ...alertRule,
      triggers: { ...changes.triggers, logicType: "all" },
      actionFilters: [
        {
          ...changes.actionFilters[0],
          conditions: [
            { ...changes.actionFilters[0].conditions[0], comparison: 25 },
          ],
        },
      ],
    });
    const validatedParams = prepareToolParams({
      tool: updateAlertRule,
      params: { ...params, ...changes },
      context,
    }) as Parameters<typeof updateAlertRule.handler>[0];

    const result = await updateAlertRule.handler(validatedParams, context);

    expect(writes).toEqual([
      { name: alertRule.name, enabled: false, ...changes },
    ]);
    expect(getStructuredContent(result)).toMatchObject({ alertRule: changes });
  });

  it("replaces action filters when an explicit empty array is supplied", async () => {
    const { writes } = useAlertRuleHandlers();

    await updateRule({ actionFilters: [] });

    expect(writes).toEqual([
      { name: alertRule.name, enabled: false, actionFilters: [] },
    ]);
  });

  it("combines connection changes across issue stream pages while preserving untouched monitors", async () => {
    const { writes } = useAlertRuleHandlers({
      ...alertRule,
      detectorIds: ["789", "321", "654"],
    });
    useProjectScope(["100"]);
    const queries: URL[] = [];
    mswServer.use(
      http.get(detectorsEndpoint, ({ request }) => {
        const url = new URL(request.url);
        queries.push(url);
        return HttpResponse.json(
          url.searchParams.has("cursor") ? [detector] : [],
          {
            headers: url.searchParams.has("cursor")
              ? {}
              : {
                  Link: `<${detectorsEndpoint}?cursor=next>; rel="next"; results="true"; cursor="next"`,
                },
          },
        );
      }),
      http.get(`${detectorsEndpoint}:id/`, ({ params: path }) =>
        HttpResponse.json({ ...detector, id: path.id, type: "metric_issue" }),
      ),
    );

    const result = await updateRule({
      addProjectSlugs: ["cloudflare-mcp"],
      addDetectorIds: ["654"],
      removeDetectorIds: ["321"],
    });

    expect(
      queries.map((url) => [
        url.searchParams.get("project"),
        url.searchParams.getAll("type"),
        url.searchParams.get("cursor"),
      ]),
    ).toEqual([
      ["100", ["issue_stream"], null],
      ["100", ["issue_stream"], "next"],
    ]);
    expect(writes).toEqual([
      {
        name: alertRule.name,
        enabled: false,
        detectorIds: ["789", "654", "456"],
      },
    ]);
    expect(getStructuredContent(result)).toMatchObject({
      alertRule: {
        id: "123",
        detectorIds: ["789", "654", "456"],
        actionFilters: alertRule.actionFilters,
      },
    });
  });

  it.each([null, "cloudflare-mcp"])(
    "disconnects an attached unavailable monitor under project constraint %s",
    async (projectSlug) => {
      const { writes } = useAlertRuleHandlers({
        ...alertRule,
        detectorIds: ["789", "321"],
      });
      useProjectScope(["100"]);
      mswServer.use(
        http.get(`${detectorsEndpoint}321/`, () =>
          HttpResponse.json({ detail: "Unavailable monitor" }, { status: 404 }),
        ),
      );

      const result = await updateRule(
        { removeDetectorIds: ["321"] },
        { ...context, constraints: { ...context.constraints, projectSlug } },
      );

      expect(writes).toEqual([
        { name: alertRule.name, enabled: false, detectorIds: ["789"] },
      ]);
      expect(getStructuredContent(result)).toMatchObject({
        alertRule: { detectorIds: ["789"] },
      });
    },
  );

  it.each([
    { field: "addDetectorIds", id: "456", status: 403, method: "GET" },
    { field: "addDetectorIds", id: "456", status: 404, method: "GET" },
    { field: "removeDetectorIds", id: "456", status: 404, method: "GET" },
    { field: "removeDetectorIds", id: "789", status: 403, method: "PUT" },
  ])(
    "propagates $method $status for $field without bypassing authorization",
    async ({ field, id, status, method }) => {
      const { writes } = useAlertRuleHandlers();
      mswServer.use(
        http.get(`${detectorsEndpoint}${id}/`, () =>
          HttpResponse.json(
            { detail: "Unavailable monitor" },
            { status: method === "GET" ? status : 404 },
          ),
        ),
        http.put(endpoint, async ({ request }) => {
          writes.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ detail: "Forbidden update" }, { status });
        }),
      );

      await expect(updateRule({ [field]: [id] })).rejects.toMatchObject({
        status,
        message: expect.stringContaining(
          method === "GET" ? "Unavailable monitor" : "Forbidden update",
        ),
      });
      expect(writes).toHaveLength(method === "PUT" ? 1 : 0);
    },
  );

  it.each([
    {
      type: "error",
      removeDetectorIds: undefined,
      message: "No issue_stream monitor was found",
    },
    {
      type: "issue_stream",
      removeDetectorIds: ["456"],
      message: "cannot be added and removed",
    },
  ])(
    "rejects unresolved or contradictory project connections: $message",
    async ({ type, removeDetectorIds, message }) => {
      const { writes } = useAlertRuleHandlers();
      useProjectScope(["100"]);
      mswServer.use(
        http.get(detectorsEndpoint, () =>
          HttpResponse.json([{ ...detector, type }]),
        ),
        http.get(`${detectorsEndpoint}456/`, () => HttpResponse.json(detector)),
      );

      await expect(
        updateRule({ addProjectSlugs: ["cloudflare-mcp"], removeDetectorIds }),
      ).rejects.toThrow(message);
      expect(writes).toEqual([]);
    },
  );

  it.each([
    {
      projectId: "200",
      changes: { addDetectorIds: ["456"] },
      message: "outside the active project constraint",
    },
    {
      projectId: null,
      changes: { addDetectorIds: ["456"] },
      message: "outside the active project constraint",
    },
    {
      projectId: "100",
      changes: { removeDetectorIds: ["789"] },
      message: "Disconnecting every Alert source",
    },
  ])(
    "rejects connection changes outside a project session: $projectId $changes",
    async ({ projectId, changes, message }) => {
      const { writes } = useAlertRuleHandlers();
      useProjectScope(["100"]);
      mswServer.use(
        http.get(`${detectorsEndpoint}:id/`, ({ params: path }) =>
          HttpResponse.json({ ...detector, id: path.id, projectId }),
        ),
      );

      await expect(
        updateRule(changes, {
          ...context,
          constraints: { projectSlug: "cloudflare-mcp" },
        }),
      ).rejects.toThrow(message);
      expect(writes).toEqual([]);
    },
  );

  it("does not fall back to a numeric name when the workflow ID is missing", async () => {
    const { writes } = useAlertRuleHandlers();
    const searches: string[] = [];
    mswServer.use(
      http.get(endpoint, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 }),
      ),
      http.get(endpoint.replace("123/", ""), ({ request }) => {
        searches.push(request.url);
        return HttpResponse.json([{ ...alertRule, id: "999", name: "123" }]);
      }),
    );

    await expect(updateRule({ status: "active" })).rejects.toMatchObject({
      name: "ApiNotFoundError",
    });
    expect(searches).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("resolves an exact name and permits an update within the constrained project", async () => {
    const { reads, writes } = useAlertRuleHandlers();
    useProjectScope(["100"]);
    const queries: URL[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
        ({ request }) => {
          queries.push(new URL(request.url));
          return HttpResponse.json([
            { id: "123", name: alertRule.name, detectorIds: ["789"] },
          ]);
        },
      ),
    );

    await updateRule(
      {
        projectSlug: "cloudflare-mcp",
        ruleIdOrName: alertRule.name,
        name: "Renamed alert",
        status: "active",
      },
      { ...context, constraints: { projectSlug: "cloudflare-mcp" } },
    );

    expect(queries[0].searchParams.get("projectSlug")).toBe("cloudflare-mcp");
    expect(reads).toHaveLength(1);
    expect(writes).toEqual([{ name: "Renamed alert", enabled: true }]);
  });

  it("rejects an empty update before reading or writing the API", async () => {
    const { reads, writes } = useAlertRuleHandlers();

    await expect(updateRule()).rejects.toThrow(
      "Provide at least one field to update",
    );

    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each(["duplicate names", "remaining search pages"])(
    "rejects ambiguous name lookup with %s before reading detail or writing",
    async (reason) => {
      const { reads, writes } = useAlertRuleHandlers();
      const hasMore = reason === "remaining search pages";
      const rules = hasMore
        ? Array.from({ length: 100 }, (_, index) => ({
            ...alertRule,
            id: String(index + 123),
            name: index === 0 ? alertRule.name : `${alertRule.name} ${index}`,
          }))
        : [alertRule, { ...alertRule, id: "456" }];
      mswServer.use(
        http.get(
          "https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/",
          () =>
            HttpResponse.json(rules, {
              headers: hasMore
                ? {
                    Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/workflows/?cursor=next-page>; rel="next"; results="true"; cursor="next-page"',
                  }
                : {},
            }),
        ),
      );

      await expect(
        updateRule({
          projectSlug: "cloudflare-mcp",
          ruleIdOrName: alertRule.name,
          name: "Renamed alert",
        }),
      ).rejects.toThrow(
        hasMore
          ? "Alert name search is incomplete"
          : "cannot be resolved unambiguously",
      );

      expect(reads).toEqual([]);
      expect(writes).toEqual([]);
    },
  );

  it.each([
    { projectIds: ["100", "200"], includesAllProjects: false },
    { projectIds: ["100"], includesAllProjects: true },
    { projectIds: [], includesAllProjects: false },
  ])("rejects unsafe project scope %j before writing", async (scope) => {
    const { writes } = useAlertRuleHandlers();
    useProjectScope(scope.projectIds, scope.includesAllProjects);

    await expect(
      updateRule(
        { projectSlug: "cloudflare-mcp", status: "active" },
        { ...context, constraints: { projectSlug: "cloudflare-mcp" } },
      ),
    ).rejects.toThrow("outside the active project constraint");

    expect(writes).toEqual([]);
  });
});
