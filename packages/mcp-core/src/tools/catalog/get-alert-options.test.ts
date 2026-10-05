import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getStructuredContent } from "../../test-utils/structured-content";
import getAlertOptions, {
  getAlertOptionsOutputSchema,
} from "./get-alert-options";

const context = {
  accessToken: "access-token",
  userId: "1",
  constraints: { organizationSlug: null },
};
const orgUrl = "https://sentry.io/api/0/organizations/test-org";
const project = { id: "10", slug: "backend", name: "Backend" };
const detector = {
  id: "20",
  name: "Backend issues",
  type: "issue_stream",
  projectId: project.id,
  enabled: true,
  workflowIds: ["30"],
  config: { privateMetadata: "excluded" },
  conditionGroup: null,
  dataSources: null,
  dateCreated: "2026-01-01T00:00:00Z",
  dateUpdated: "2026-01-01T00:00:00Z",
};
const condition = {
  type: "first_seen_event",
  handlerGroup: "workflow_trigger",
  comparisonJsonSchema: { type: "boolean" },
};
const nextPage = {
  headers: {
    Link: '<https://sentry.io/api/0/?cursor=next>; rel="next"; results="true"; cursor="next"',
  },
};

function getOptions(
  params: Partial<Parameters<typeof getAlertOptions.handler>[0]> = {},
  toolContext: Parameters<typeof getAlertOptions.handler>[1] = context,
) {
  return getAlertOptions.handler(
    z.object(getAlertOptions.inputSchema).parse({
      organizationSlug: "test-org",
      section: "actions",
      ...params,
    }),
    toolContext,
  );
}

describe("get_alert_options", () => {
  it("returns paginated comparison schemas for the requested condition group", async () => {
    mswServer.use(
      http.get(`${orgUrl}/data-conditions/`, ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          group: "workflow_trigger",
          cursor: "previous",
          per_page: "5",
        });
        return HttpResponse.json([condition], nextPage);
      }),
    );
    const result = await getOptions({
      section: "conditions",
      conditionGroup: "workflow_trigger",
      cursor: "previous",
      limit: 5,
    });
    const content = getStructuredContent(result);
    expect(getAlertOptionsOutputSchema.parse(content)).toEqual(content);
    expect(result).toMatchInlineSnapshot(`
      {
        "structuredContent": {
          "conditionGroup": "workflow_trigger",
          "conditions": [
            {
              "comparisonJsonSchema": {
                "type": "boolean",
              },
              "handlerGroup": "workflow_trigger",
              "type": "first_seen_event",
            },
          ],
          "nextCursor": "next",
          "section": "conditions",
        },
      }
    `);
  });

  it("returns native action schemas, installed integrations, services and Sentry App fields", async () => {
    const actions = [
      {
        type: "slack",
        handlerGroup: "notification",
        configSchema: {
          properties: { target_type: { type: "integer", enum: [0] } },
        },
        dataSchema: {},
        integrations: [{ id: "40", name: "Workspace" }],
      },
      {
        type: "pagerduty",
        handlerGroup: "notification",
        configSchema: {},
        dataSchema: {
          properties: { priority: { enum: ["critical", "warning"] } },
        },
        integrations: [
          {
            id: "41",
            name: "On call",
            services: [{ id: "42", name: "Backend" }],
          },
        ],
      },
      {
        type: "webhook",
        handlerGroup: "other",
        configSchema: {},
        dataSchema: {},
        services: [{ slug: "my-app", name: "My app" }],
      },
      {
        type: "sentry_app",
        handlerGroup: "other",
        configSchema: {},
        dataSchema: {},
        sentryApp: {
          id: "43",
          name: "Ticket app",
          installationId: "44",
          installationUuid: "installation-uuid",
          status: "published",
          settings: {
            required_fields: [
              {
                name: "team",
                type: "select",
                choices: [["team-id", "Backend"]],
              },
              {
                name: "queue",
                type: "select",
                uri: "/queues",
                depends_on: ["team"],
              },
            ],
            optional_fields: [],
          },
        },
      },
    ];
    mswServer.use(
      http.get(`${orgUrl}/available-actions/`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect(query.getAll("type")).toEqual(
          actions.map((action) => action.type),
        );
        expect(query.get("cursor")).toBe("previous");
        expect(query.get("per_page")).toBe("5");
        return HttpResponse.json(actions, nextPage);
      }),
    );
    const result = getStructuredContent(
      await getOptions({
        actionTypes: actions.map((action) => action.type),
        cursor: "previous",
        limit: 5,
      }),
    );
    expect(getAlertOptionsOutputSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      section: "actions",
      actions,
      nextCursor: "next",
      inputGuide: {
        fieldNames: {
          target_identifier: "targetIdentifier",
          target_display: "targetDisplay",
          target_type: "targetType",
          fallthrough_type: "fallthroughType",
        },
        targetTypes: {
          "0": "specific",
          "1": "user",
          "2": "team",
          "3": "sentry_app",
          "4": "issue_owners",
        },
        notes: expect.arrayContaining([
          expect.stringContaining("Dynamic fields require explicit values"),
        ]),
      },
    });
  });

  it("discovers accessible sources with server-side type filters and compact output", async () => {
    mswServer.use(
      http.get(`${orgUrl}/detectors/`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect(query.get("project")).toBe("-1");
        expect(query.getAll("type")).toEqual(["issue_stream", "metric_issue"]);
        expect(query.get("query")).toBe("workflow:30");
        expect(query.get("cursor")).toBe("previous");
        expect(query.get("per_page")).toBe("5");
        return HttpResponse.json(
          [
            detector,
            {
              ...detector,
              id: "21",
              name: "All projects",
              projectId: null,
              workflowIds: null,
            },
          ],
          nextPage,
        );
      }),
    );
    expect(
      getStructuredContent(
        await getOptions({
          section: "sources",
          sourceTypes: ["issue_stream", "metric_issue"],
          query: "workflow:30",
          cursor: "previous",
          limit: 5,
        }),
      ),
    ).toEqual({
      section: "sources",
      sources: [
        {
          id: "20",
          name: "Backend issues",
          type: "issue_stream",
          projectId: "10",
          enabled: true,
          workflowIds: ["30"],
        },
        {
          id: "21",
          name: "All projects",
          type: "issue_stream",
          projectId: null,
          enabled: true,
          workflowIds: [],
        },
      ],
      nextCursor: "next",
    });
  });

  it.each([false, true])(
    "filters source responses by resolved project (session constraint: %s)",
    async (constrained) => {
      mswServer.use(
        http.get("https://sentry.io/api/0/projects/test-org/backend/", () =>
          HttpResponse.json(project),
        ),
        http.get(`${orgUrl}/detectors/`, ({ request }) => {
          expect(new URL(request.url).searchParams.get("project")).toBe(
            project.id,
          );
          return HttpResponse.json(
            [
              detector,
              {
                ...detector,
                id: "21",
                projectId: "99",
                name: "Other project's source",
              },
              { ...detector, id: "22", projectId: null, name: "All projects" },
            ],
            nextPage,
          );
        }),
      );
      const result = getStructuredContent(
        await getOptions(
          {
            section: "sources",
            projectSlug: constrained ? "all" : project.slug,
          },
          constrained
            ? {
                ...context,
                constraints: {
                  organizationSlug: null,
                  projectSlug: project.slug,
                },
              }
            : context,
        ),
      );
      expect(result).toEqual({
        section: "sources",
        sources: [
          {
            id: "20",
            name: "Backend issues",
            type: "issue_stream",
            projectId: "10",
            enabled: true,
            workflowIds: ["30"],
          },
        ],
        nextCursor: "next",
      });
    },
  );

  it("rejects an explicitly different project in a constrained session", async () => {
    await expect(
      getOptions(
        { section: "sources", projectSlug: "frontend" },
        {
          ...context,
          constraints: { organizationSlug: null, projectSlug: "backend" },
        },
      ),
    ).rejects.toThrow("outside the active project constraint");
  });

  it.each([
    { section: "conditions" as const },
    { section: "sources" as const, actionTypes: ["slack"] },
    { section: "actions" as const, conditionGroup: "action_filter" as const },
    { section: "conditions" as const, sourceTypes: ["issue_stream"] },
  ])("rejects missing or mismatched section parameters: %j", async (params) => {
    await expect(getOptions(params)).rejects.toThrow(/required|only be used/);
  });

  it.each([
    { section: "actions" as const, endpoint: "available-actions", status: 403 },
    {
      section: "conditions" as const,
      endpoint: "data-conditions",
      status: 500,
    },
    { section: "sources" as const, endpoint: "detectors", status: 401 },
  ])(
    "propagates $section API failures",
    async ({ section, endpoint, status }) => {
      mswServer.use(
        http.get(`${orgUrl}/${endpoint}/`, () =>
          HttpResponse.json({ detail: "Options unavailable" }, { status }),
        ),
      );
      await expect(
        getOptions({
          section,
          conditionGroup: section === "conditions" ? "workflow_trigger" : null,
        }),
      ).rejects.toMatchObject({
        status,
        message: expect.stringContaining("Options unavailable"),
      });
    },
  );
});
