import tools from "@sentry/mcp-core/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMonitorFixture } from "./monitor-fixture";

const { find_monitors: findMonitors, get_monitor_details: getMonitorDetails } =
  tools;
type Fixture = Awaited<ReturnType<typeof createMonitorFixture>>;
const active: Fixture[] = [];
const accessToken = "local-monitor-test-token";
const edit = {
  config: { schedule: "30 9 * * 1-5", timezone: "Europe/Madrid" },
};
const finalAnswer = JSON.stringify({ slug: "nightly-billing", ...edit.config });

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.close()));
});

async function fixture() {
  const instance = await createMonitorFixture({ accessToken });
  active.push(instance);
  return instance;
}

function request(
  instance: Fixture,
  body?: unknown,
  reference = "nightly-billing",
  projectScoped = false,
) {
  const prefix = projectScoped
    ? `projects/${instance.organizationSlug}/billing`
    : `organizations/${instance.organizationSlug}`;
  return fetch(`${instance.baseUrl}/api/0/${prefix}/monitors/${reference}/`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("cron monitor Code Mode eval fixture", () => {
  it("runs the real catalog monitor handlers against the fixture", async () => {
    const instance = await fixture();
    const context = {
      accessToken,
      sentryHost: new URL(instance.baseUrl).host,
      sentryProtocol: "http" as const,
      constraints: {},
    };
    const list = await findMonitors.handler(
      z.object(findMonitors.inputSchema).parse({
        organizationSlug: instance.organizationSlug,
        projectSlug: "billing",
        query: "weekday",
      }),
      context,
    );
    expect(list).toMatchObject({
      structuredContent: {
        hasMore: false,
        monitors: [
          {
            slug: "nightly-billing",
            status: "disabled",
            projectSlug: "billing",
          },
        ],
      },
    });
    const detail = await getMonitorDetails.handler(
      z.object(getMonitorDetails.inputSchema).parse({
        organizationSlug: instance.organizationSlug,
        projectSlugOrId: "billing",
        monitorSlug: "nightly-billing",
      }),
      context,
    );
    expect(detail).toContain("**Slug**: nightly-billing");
    expect(detail).toContain("**Status**: disabled");
    expect(detail).toContain("**timezone**: UTC");
    expect(
      instance.snapshot().requests.every((request) => request.status === 200),
    ).toBe(true);
    expect(instance.snapshot().writes).toEqual([]);
  });

  it("serves discovery and the supplementary reads used by ordinary monitor tools", async () => {
    const instance = await fixture();
    const paths = [
      "/api/0/organizations/monitor-evals/monitors/?projectSlug=billing&query=weekday&per_page=11",
      "/api/0/projects/monitor-evals/billing/",
      "/api/0/projects/monitor-evals/billing/monitors/nightly-billing/",
      "/api/0/projects/monitor-evals/billing/monitors/nightly-billing/checkins/",
      "/api/0/organizations/monitor-evals/monitors/nightly-billing/stats/",
      "/api/0/organizations/monitor-evals/monitors/nightly-billing/?expand=alertRule",
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        fetch(`${instance.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    const [list, project, monitor, checkins, stats, expanded] =
      await Promise.all(responses.map((response) => response.json()));
    expect(list).toEqual([monitor]);
    expect(project).toMatchObject({ id: "101", slug: "billing" });
    expect(monitor).toMatchObject({
      slug: "nightly-billing",
      status: "disabled",
      isMuted: false,
    });
    expect(monitor).not.toHaveProperty("alertRule");
    expect(expanded).toEqual(instance.snapshot().monitors[0]);
    expect(checkins).toEqual([]);
    expect(stats).toEqual([]);
    expect(instance.snapshot().writes).toEqual([]);
  });

  it("merges a partial config without applying omitted defaults or changing mixed environment mute state", async () => {
    const instance = await fixture();
    const before = instance.snapshot();
    expect(
      (await request(instance, edit, "nightly-billing", true)).status,
    ).toBe(200);
    const updated = await (await request(instance)).json();
    expect(updated).toMatchObject({
      status: "disabled",
      owner: before.monitors[0].owner,
      config: { ...before.monitors[0].config, ...edit.config },
      environments: before.monitors[0].environments,
    });
    expect(instance.verify(finalAnswer)).toMatchObject({
      success: true,
      ...edit.config,
    });
    expect(instance.snapshot().monitors[1]).toEqual(before.monitors[1]);
    expect(instance.snapshot().writes).toHaveLength(1);
    instance.reset();
    expect(instance.snapshot()).toEqual(before);
  });

  it("finds monitors using backend-supported quoted phrases and name filters", async () => {
    const instance = await fixture();
    for (const query of [
      '"Billing weekday import"',
      'name:"Billing weekday import"',
      'weekday name:"Billing weekday import"',
    ]) {
      const response = await fetch(
        `${instance.baseUrl}/api/0/organizations/monitor-evals/monitors/?${new URLSearchParams({ query })}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        { slug: "nightly-billing" },
      ]);
    }
  });

  it("accepts equivalent weekday expressions and requires the answer to reflect the actual saved schedule", async () => {
    const instance = await fixture();
    for (const schedule of [
      "30 9 * * 1,2,3,4,5",
      "30 09 * * MON-FRI",
      "30 9 * * MON,TUE,WED,THU,FRI",
      "30 9 * * 1-5/1",
    ]) {
      expect(
        (await request(instance, { config: { ...edit.config, schedule } }))
          .status,
      ).toBe(200);
      expect(
        instance.verify(
          JSON.stringify({
            slug: "nightly-billing",
            schedule,
            timezone: "Europe/Madrid",
          }),
        ),
      ).toMatchObject({ success: true, schedule });
      expect(() => instance.verify(finalAnswer)).toThrow(
        "Final answer does not match the saved monitor values",
      );
    }
    expect(
      (await request(instance, { config: { schedule: "30 9 * * 1-6" } }))
        .status,
    ).toBe(200);
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Target monitor schedule is incorrect",
    );
  });

  it("rejects GET-shaped owner/project objects while accepting scalar references and camelCase config", async () => {
    const instance = await fixture();
    const before = instance.snapshot().monitors[0];
    expect(
      (
        await request(instance, {
          ...before,
          config: { ...before.config, ...edit.config },
        })
      ).status,
    ).toBe(400);
    expect(instance.snapshot().writes).toEqual([]);
    expect(
      (
        await request(instance, {
          project: "101",
          owner: "team:42",
          config: { ...edit.config, scheduleType: "crontab", maxRuntime: 45 },
        })
      ).status,
    ).toBe(200);
    expect(instance.verify(finalAnswer).success).toBe(true);
  });

  it("detects the side effect of resending aggregate isMuted on mixed environments", async () => {
    const instance = await fixture();
    expect((await request(instance, { ...edit, isMuted: false })).status).toBe(
      200,
    );
    expect(
      instance.snapshot().monitors[0].environments.map((env) => env.isMuted),
    ).toEqual([false, false]);
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Unrequested monitor settings changed",
    );
  });

  it("rejects temporarily clearing a threshold even if restored before the final answer", async () => {
    const instance = await fixture();
    expect(
      (
        await request(instance, {
          config: { ...edit.config, failure_issue_threshold: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(instance, { config: { failure_issue_threshold: 3 } }))
        .status,
    ).toBe(200);
    expect(instance.snapshot().monitors[0].config.failure_issue_threshold).toBe(
      3,
    );
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Write 1: unrequested monitor settings changed during the operation",
    );
  });

  it("rejects changes to another monitor and incorrect reported saved values", async () => {
    const instance = await fixture();
    expect((await request(instance, edit)).status).toBe(200);
    expect(() =>
      instance.verify(
        JSON.stringify({
          slug: "nightly-billing",
          schedule: "0 2 * * *",
          timezone: "UTC",
        }),
      ),
    ).toThrow("Final answer does not match the saved monitor values");
    expect(() => instance.verify("Done")).toThrow(
      "Final answer must include the saved values as JSON",
    );
    expect(
      (await request(instance, { status: "active" }, "billing-export")).status,
    ).toBe(200);
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Unrelated monitor changed",
    );
  });

  it("rejects invented success and invalid writes without changing fixture state", async () => {
    const instance = await fixture();
    const before = instance.snapshot().monitors;
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Target monitor schedule is incorrect",
    );
    for (const body of [
      { config: { timezone: "Invalid/Timezone" } },
      { project: "different-project" },
      { isMuted: false, is_muted: true },
    ])
      expect((await request(instance, body)).status).toBe(400);
    expect(instance.snapshot().monitors).toEqual(before);
    expect(instance.snapshot().writes).toEqual([]);
  });
});
