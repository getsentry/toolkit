import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { UserInputError } from "../../errors";
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
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/monitors/";
const baseParams = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  projectSlug: "cloudflare-mcp",
  name: "Nightly Import",
};

function monitorResponse(config: Record<string, unknown>) {
  return {
    id: "c5f2a1b0-0000-4000-8000-000000000001",
    slug: "nightly-import",
    name: "Nightly Import",
    status: "active",
    isMuted: false,
    project: {
      id: "4509062593708032",
      slug: "cloudflare-mcp",
      name: "cloudflare-mcp",
    },
    owner: null,
    config,
    environments: [],
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
        crontab: "0 3 * * *",
        timezone: "America/Los_Angeles",
        checkInMargin: 5,
        maxRuntime: 30,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
      },
      context,
    );

    expect(requestBody).toEqual({
      project: "cloudflare-mcp",
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
      { ...baseParams, interval: { value: 15, unit: "minute" } },
      context,
    );

    expect(requestBody).toMatchObject({
      config: { schedule_type: "interval", schedule: [15, "minute"] },
    });
    expect(getStructuredContent(result)).toMatchObject({
      monitor: { scheduleType: "interval", schedule: "15 minute" },
    });
  });

  it.each([
    ["neither", {}],
    [
      "both",
      { crontab: "@daily", interval: { value: 1, unit: "day" as const } },
    ],
  ])("rejects %s crontab and interval", async (_label, schedule) => {
    await expect(
      createMonitor.handler({ ...baseParams, ...schedule }, context),
    ).rejects.toThrow(UserInputError);
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

  it("forwards slug, status, and owner", async () => {
    let requestBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(endpoint, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          monitorResponse({ schedule_type: "crontab", schedule: "@daily" }),
          { status: 201 },
        );
      }),
    );

    await createMonitor.handler(
      {
        ...baseParams,
        crontab: "@daily",
        slug: "nightly-import",
        status: "disabled",
        owner: "team:456",
      },
      context,
    );

    expect(requestBody).toMatchObject({
      slug: "nightly-import",
      status: "disabled",
      owner: "team:456",
    });
  });

  it("surfaces Sentry validation errors", async () => {
    mswServer.use(
      http.post(endpoint, () =>
        HttpResponse.json(
          {
            config: { schedule: ["Only 5 field crontab syntax is supported"] },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      createMonitor.handler({ ...baseParams, crontab: "0 0 3 * * *" }, context),
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
    const parsed = z
      .object(createMonitor.inputSchema)
      .parse({ ...baseParams, crontab: "@daily" });

    await expect(
      createMonitor.handler(
        parsed,
        createTestContext({ constraints: { projectSlug: "other-project" } }),
      ),
    ).rejects.toThrow("outside the active project constraint");
    expect(writes).toBe(0);
  });
});
