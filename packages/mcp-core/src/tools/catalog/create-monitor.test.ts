import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestContext } from "../../test-utils/context.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import createMonitor, { createMonitorOutputSchema } from "./create-monitor.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};
const endpoint =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/cloudflare-mcp/detectors/";
const baseParams = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  projectSlug: "cloudflare-mcp",
  name: "Nightly Import",
};

// Sentry answers with the created detector and serializes the Monitor as
// `dataSources[0].queryObj` (MonitorIncidentDetectorValidator).
function monitorResponse(
  config: Record<string, unknown>,
  {
    status = "active",
    workflowIds = [],
  }: { status?: string; workflowIds?: string[] } = {},
) {
  return {
    id: "8812",
    projectId: "4509062593708032",
    name: "Nightly Import",
    type: "monitor_check_in_failure",
    enabled: status === "active",
    config: {},
    conditionGroup: null,
    workflowIds,
    owner: null,
    createdBy: "1",
    dateCreated: "2026-11-03T12:00:00Z",
    dateUpdated: "2026-11-03T12:00:00Z",
    dataSources: [
      {
        id: "991",
        organizationId: "1",
        type: "cron_monitor",
        sourceId: "77",
        queryObj: {
          id: "c5f2a1b0-0000-4000-8000-000000000001",
          slug: "nightly-import",
          name: "Nightly Import",
          status,
          isMuted: false,
          project: {
            id: "4509062593708032",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          },
          owner: null,
          config,
          environments: [],
        },
      },
    ],
  };
}

describe("create_monitor", () => {
  it("creates a crontab cron monitor with Sentry's config fields", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(endpoint, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          monitorResponse({
            schedule_type: "crontab",
            schedule: "0 3 * * *",
            timezone: "America/Los_Angeles",
            checkin_margin: 5,
            max_runtime: 30,
            failure_issue_threshold: 2,
            recovery_threshold: 1,
          }),
          { status: 201 },
        );
      }),
    );

    const result = await createMonitor.handler(
      {
        ...baseParams,
        schedule: { type: "crontab", crontab: "0 3 * * *" },
        timezone: "America/Los_Angeles",
        checkInMargin: 5,
        maxRuntime: 30,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      },
      context,
    );

    expect(requestBody).toEqual({
      type: "monitor_check_in_failure",
      name: "Nightly Import",
      dataSources: [
        {
          name: "Nightly Import",
          config: {
            schedule_type: "crontab",
            schedule: "0 3 * * *",
            timezone: "America/Los_Angeles",
            checkin_margin: 5,
            max_runtime: 30,
            failure_issue_threshold: 2,
            recovery_threshold: 1,
          },
        },
      ],
    });

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(createMonitorOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "monitor": {
          "checkInMargin": 5,
          "failureIssueThreshold": 2,
          "id": "c5f2a1b0-0000-4000-8000-000000000001",
          "maxRuntime": 30,
          "name": "Nightly Import",
          "projectSlug": "cloudflare-mcp",
          "recoveryThreshold": 1,
          "schedule": "0 3 * * *",
          "scheduleType": "crontab",
          "slug": "nightly-import",
          "status": "active",
          "timezone": "America/Los_Angeles",
          "webUrl": "https://sentry-mcp-evals.sentry.io/crons/cloudflare-mcp/nightly-import/",
          "workflowIds": [],
        },
      }
    `);
  });

  it("sends interval schedules as a [value, unit] tuple", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(endpoint, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          monitorResponse({
            schedule_type: "interval",
            schedule: [15, "minute"],
          }),
          { status: 201 },
        );
      }),
    );

    const result = await createMonitor.handler(
      {
        ...baseParams,
        schedule: { type: "interval", value: 15, unit: "minute" },
      },
      context,
    );

    expect(requestBody).toMatchObject({
      dataSources: [
        { config: { schedule_type: "interval", schedule: [15, "minute"] } },
      ],
    });
    expect(getStructuredContent(result)).toMatchObject({
      monitor: { scheduleType: "interval", schedule: "15 minute" },
    });
  });

  const scheduleSchema = createMonitor.inputSchema.schedule;

  it.each([
    ["crontab", { type: "crontab", crontab: "@daily" }],
    ["interval", { type: "interval", value: 15, unit: "minute" }],
  ])("accepts a %s schedule in the input schema", (_label, schedule) => {
    expect(scheduleSchema.safeParse(schedule).success).toBe(true);
  });

  it.each([
    ["neither", undefined],
    ["an empty", {}],
    ["both", { type: "crontab", crontab: "@daily", value: 1, unit: "day" }],
    [
      "interval fields under crontab type",
      { type: "crontab", value: 1, unit: "day" },
    ],
    ["crontab under interval type", { type: "interval", crontab: "@daily" }],
    [
      "both under interval type",
      { type: "interval", value: 15, unit: "minute", crontab: "@daily" },
    ],
  ])("rejects %s schedule in the input schema", (_label, schedule) => {
    expect(scheduleSchema.safeParse(schedule).success).toBe(false);
  });

  it("rejects a missing schedule when parsing the full input", () => {
    expect(
      z.object(createMonitor.inputSchema).safeParse(baseParams).success,
    ).toBe(false);
  });

  it("accepts checkInMargin=0 and forwards it for Sentry to coerce", async () => {
    expect(createMonitor.inputSchema.checkInMargin.safeParse(0).success).toBe(
      true,
    );
    expect(createMonitor.inputSchema.checkInMargin.safeParse(-1).success).toBe(
      false,
    );
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(endpoint, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          monitorResponse({
            schedule_type: "crontab",
            schedule: "@daily",
            checkin_margin: 1,
          }),
          { status: 201 },
        );
      }),
    );

    await createMonitor.handler(
      {
        ...baseParams,
        schedule: { type: "crontab", crontab: "@daily" },
        checkInMargin: 0,
      },
      context,
    );

    expect(requestBody).toMatchObject({
      dataSources: [{ config: { checkin_margin: 0 } }],
    });
  });

  it.each(["alice", "team:backend", "user:", "user:1:2"])(
    "rejects malformed owner %s in the input schema",
    (owner) => {
      expect(createMonitor.inputSchema.owner.safeParse(owner).success).toBe(
        false,
      );
    },
  );

  it.each([
    ["checkInMargin", 40_321],
    ["maxRuntime", 10_081],
    ["failureIssueThreshold", 721],
    ["recoveryThreshold", 0],
  ] as const)("rejects out-of-range %s=%d", (field, value) => {
    expect(createMonitor.inputSchema[field].safeParse(value).success).toBe(
      false,
    );
  });

  it("forwards slug, status, owner, and workflowIds", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(endpoint, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          monitorResponse(
            { schedule_type: "crontab", schedule: "@daily" },
            { status: "disabled", workflowIds: ["12"] },
          ),
          { status: 201 },
        );
      }),
    );

    const result = await createMonitor.handler(
      {
        ...baseParams,
        schedule: { type: "crontab", crontab: "@daily" },
        slug: "nightly-import",
        status: "disabled",
        owner: "team:456",
        workflowIds: ["12"],
      },
      context,
    );

    // The detector and its Monitor both carry the owner, matching what the
    // legacy monitor endpoint copied onto the detector.
    expect(requestBody).toEqual({
      type: "monitor_check_in_failure",
      name: "Nightly Import",
      owner: "team:456",
      workflowIds: ["12"],
      dataSources: [
        {
          name: "Nightly Import",
          config: { schedule_type: "crontab", schedule: "@daily" },
          slug: "nightly-import",
          status: "disabled",
          owner: "team:456",
        },
      ],
    });
    expect(getStructuredContent(result)).toMatchObject({
      monitor: { status: "disabled", workflowIds: ["12"] },
    });
  });

  it("reports a monitor Sentry disabled for lack of a seat", async () => {
    mswServer.use(
      http.post(endpoint, () =>
        HttpResponse.json(
          monitorResponse(
            { schedule_type: "crontab", schedule: "@daily" },
            { status: "disabled" },
          ),
          { status: 201 },
        ),
      ),
    );

    const result = await createMonitor.handler(
      { ...baseParams, schedule: { type: "crontab", crontab: "@daily" } },
      context,
    );

    expect(getStructuredContent(result)).toMatchObject({
      monitor: { status: "disabled" },
    });
  });

  it.each([["abc"], ["12a"]])(
    "rejects non-numeric workflow ID %s in the input schema",
    (id) => {
      expect(
        createMonitor.inputSchema.workflowIds.safeParse([id]).success,
      ).toBe(false);
    },
  );

  it("caps the number of workflow IDs in the input schema", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, i) => String(i + 1));
    expect(
      createMonitor.inputSchema.workflowIds.safeParse(ids(50)).success,
    ).toBe(true);
    expect(
      createMonitor.inputSchema.workflowIds.safeParse(ids(51)).success,
    ).toBe(false);
  });

  it("surfaces Sentry validation errors", async () => {
    mswServer.use(
      http.post(endpoint, () =>
        HttpResponse.json(
          {
            dataSources: {
              config: {
                schedule: ["Only 5 field crontab syntax is supported"],
              },
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      createMonitor.handler(
        {
          ...baseParams,
          schedule: { type: "crontab", crontab: "0 0 3 * * *" },
        },
        context,
      ),
    ).rejects.toThrow("Only 5 field crontab syntax is supported");
  });

  it("rejects a conflicting project before creating a monitor", async () => {
    let writes = 0;
    mswServer.use(
      http.post(endpoint, () => {
        writes += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const parsed = z.object(createMonitor.inputSchema).parse({
      ...baseParams,
      schedule: { type: "crontab", crontab: "@daily" },
    });

    await expect(
      createMonitor.handler(
        parsed,
        createTestContext({ constraints: { projectSlug: "other-project" } }),
      ),
    ).rejects.toThrow("outside the active project constraint");
    expect(writes).toBe(0);
  });
});
