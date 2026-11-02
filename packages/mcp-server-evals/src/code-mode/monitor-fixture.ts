import assert from "node:assert/strict";
import { z } from "zod";
import { startApiFixture } from "./api-fixture";
import { parseEvalJsonAnswer } from "./json-answer";

const ORGANIZATION = "monitor-evals";
const MONITOR_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_MONITOR_ID = "a0000000-0000-4000-8000-000000000002";
const SCHEDULE = "30 9 * * 1-5";
const TIMEZONE = "Europe/Madrid";
const project = {
  id: "101",
  slug: "billing",
  name: "Billing",
  platform: "python",
};
const owner = { type: "team", id: "42", name: "Billing on-call" };

const configSchema = z.object({
  schedule_type: z.enum(["crontab", "interval"]).optional(),
  schedule: z
    .union([
      z.string(),
      z.tuple([
        z.number().int().positive(),
        z.enum(["year", "month", "week", "day", "hour", "minute"]),
      ]),
    ])
    .optional(),
  timezone: z
    .string()
    .refine((value) => {
      if (!value) return true;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
  checkin_margin: z.number().int().min(1).max(40320).nullable().optional(),
  max_runtime: z.number().int().min(1).max(10080).nullable().optional(),
  failure_issue_threshold: z
    .number()
    .int()
    .min(1)
    .max(720)
    .nullable()
    .optional(),
  recovery_threshold: z.number().int().min(1).max(720).nullable().optional(),
});
const updateSchema = z.object({
  project: z.union([z.string(), z.number().int()]).optional(),
  name: z.string().min(1).max(128).optional(),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^(?![0-9]+$)[a-z0-9_-]+$/)
    .optional(),
  status: z.enum(["active", "disabled"]).optional(),
  owner: z
    .string()
    .regex(/^(team|user):\d+$/)
    .nullable()
    .optional(),
  is_muted: z.boolean().optional(),
  config: configSchema.optional(),
  alert_rule: z
    .object({
      environment: z.string().nullable().optional(),
      targets: z.array(
        z.object({
          target_identifier: z.number().int(),
          target_type: z.string(),
        }),
      ),
    })
    .optional(),
});
const answerSchema = z.object({
  slug: z.string(),
  schedule: z.string(),
  timezone: z.string(),
});

// Grade the requested days, not one spelling of an equivalent crontab.
function isRequestedSchedule(schedule: Monitor["config"]["schedule"]) {
  if (typeof schedule !== "string") return false;
  const [minute, hour, day, month, weekdays, extra] = schedule
    .trim()
    .split(/\s+/);
  if (
    extra ||
    !/^0*30$/.test(minute) ||
    !/^0*9$/.test(hour) ||
    day !== "*" ||
    month !== "*" ||
    !weekdays
  )
    return false;
  const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const asDay = (value: string) =>
    /^\d+$/.test(value) ? Number(value) : names.indexOf(value.toUpperCase());
  const days = new Set<number>();
  for (const part of weekdays.split(",")) {
    const [range, stepText, extraStep] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    const [first, last = first, extraDay] = range.split("-");
    const start = asDay(first),
      end = asDay(last);
    if (
      extraStep ||
      extraDay ||
      !Number.isInteger(step) ||
      step < 1 ||
      start < 0 ||
      end > 7 ||
      end < start
    )
      return false;
    for (let value = start; value <= end; value += step) days.add(value % 7);
  }
  return days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day));
}

// This fixture models the free-text and name filters used for this scenario,
// including quoted phrases; other query-language fields are outside its scope.
function matchesQuery(monitor: Monitor, query: string) {
  const names: string[] = [];
  const words: string[] = [];
  for (const token of query.match(/(?:\w+:)?"[^"]*"|\S+/g) ?? []) {
    if (token.startsWith("name:"))
      names.push(token.slice(5).replace(/^"|"$/g, ""));
    else if (token.includes(":")) return false;
    else words.push(token.replace(/^"|"$/g, ""));
  }
  const text = words.join(" ");
  return (
    (!names.length || names.includes(monitor.name.toLowerCase())) &&
    (!text ||
      monitor.name.toLowerCase().includes(text) ||
      monitor.slug.toLowerCase().includes(text))
  );
}

// MonitorValidator accepts camelCase aliases recursively and rejects collisions.
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    if (Object.hasOwn(result, converted))
      throw new SyntaxError(`Duplicate field ${converted}`);
    result[converted] = snakeKeys(item);
  }
  return result;
}

function sourceMonitor(id: string, slug: string, name: string) {
  return {
    id,
    slug,
    name,
    status: "disabled" as "active" | "disabled",
    isMuted: false,
    isUpserting: false,
    dateCreated: "2026-10-20T02:00:00.000Z",
    project,
    owner: owner as typeof owner | null,
    config: {
      schedule_type: "crontab" as "crontab" | "interval",
      schedule: "0 2 * * *" as string | [number, string],
      timezone: "UTC",
      checkin_margin: 10 as number | null,
      max_runtime: 45 as number | null,
      failure_issue_threshold: 3 as number | null,
      recovery_threshold: 2 as number | null,
      alert_rule_id: 501,
    },
    environments: [
      {
        name: "production",
        status: "ok",
        isMuted: false,
        dateCreated: "2026-10-20T02:00:00.000Z",
        lastCheckIn: "2026-10-25T02:00:00.000Z",
        activeIncident: null,
      },
      {
        name: "staging",
        status: "ok",
        isMuted: true,
        dateCreated: "2026-10-20T02:00:00.000Z",
        lastCheckIn: "2026-10-25T02:00:00.000Z",
        activeIncident: null,
      },
    ],
    alertRule: {
      environment: "production" as string | null,
      targets: [{ targetIdentifier: 42, targetType: "Team" }],
    },
  };
}
type Monitor = ReturnType<typeof sourceMonitor>;

/**
 * Synthetic monitor GET/PUT state based on MonitorValidator's partial update.
 * Models config merging and mute propagation, not quotas, actor permissions,
 * crontab execution, next-check-in recomputation or notification delivery.
 */
export async function createMonitorFixture({
  accessToken = "code-mode-eval-token",
}: {
  accessToken?: string;
} = {}) {
  const original = sourceMonitor(
    MONITOR_ID,
    "nightly-billing",
    "Billing weekday import",
  );
  const other = sourceMonitor(
    OTHER_MONITOR_ID,
    "billing-export",
    "Billing export",
  );
  const initial = [original, other];
  let monitors = new Map(
    initial.map((monitor) => [monitor.id, structuredClone(monitor)]),
  );
  const writes: Array<{ monitorId: string; monitors: Monitor[] }> = [];
  const organizationPath = `/api/0/organizations/${ORGANIZATION}/`;
  const collectionPath = `${organizationPath}monitors/`;
  const projectPaths = [project.slug, project.id].map(
    (id) => `/api/0/projects/${ORGANIZATION}/${id}/`,
  );

  const serialize = (monitor: Monitor, url: URL) => {
    const { alertRule, ...body } = structuredClone(monitor);
    const environments = url.searchParams.getAll("environment");
    if (environments.length)
      body.environments = body.environments.filter((env) =>
        environments.includes(env.name),
      );
    return url.searchParams.getAll("expand").includes("alertRule")
      ? { ...body, alertRule }
      : body;
  };
  const api = await startApiFixture(accessToken, ({ method, url, body }) => {
    if (method === "GET" && projectPaths.includes(url.pathname))
      return { body: project };
    if (method === "GET" && url.pathname === `${organizationPath}projects/`)
      return { body: [project] };
    if (method === "GET" && url.pathname === collectionPath) {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const projectFilter =
        url.searchParams.get("projectSlug") ?? url.searchParams.get("project");
      const ownerFilter = url.searchParams.get("owner");
      const items = [...monitors.values()].filter(
        (monitor) =>
          matchesQuery(monitor, query) &&
          (!projectFilter ||
            ["-1", project.id, project.slug].includes(projectFilter)) &&
          (!ownerFilter ||
            `${monitor.owner?.type}:${monitor.owner?.id}` === ownerFilter),
      );
      return {
        body: items
          .slice(0, Number(url.searchParams.get("per_page") ?? 100))
          .map((item) => serialize(item, url)),
      };
    }
    const prefix = [
      collectionPath,
      ...projectPaths.map((path) => `${path}monitors/`),
    ].find((path) => url.pathname.startsWith(path));
    if (!prefix) return undefined;
    const [reference, subresource] = url.pathname
      .slice(prefix.length)
      .split("/");
    const current = [...monitors.values()].find(
      (item) => item.id === reference || item.slug === reference,
    );
    if (!current) return { status: 404, body: { detail: "Monitor not found" } };
    // get_monitor_details reads these alongside the monitor even when the user
    // only needs configuration. Empty history is valid for a disabled monitor.
    if (method === "GET" && ["checkins", "stats"].includes(subresource))
      return { body: [] };
    if (subresource) return undefined;
    if (method === "GET") return { body: serialize(current, url) };
    if (method !== "PUT") return undefined;
    const input = updateSchema.parse(snakeKeys(body));
    if (
      input.project !== undefined &&
      ![project.slug, project.id].includes(String(input.project))
    ) {
      return {
        status: 400,
        body: { detail: "existing monitors may not be moved between projects" },
      };
    }
    if (
      input.slug &&
      [...monitors.values()].some(
        (item) => item.id !== current.id && item.slug === input.slug,
      )
    ) {
      return { status: 400, body: { slug: "The slug is already in use." } };
    }
    const updated = structuredClone(current);
    if (input.name !== undefined) updated.name = input.name;
    if (input.slug !== undefined) updated.slug = input.slug;
    if (input.status !== undefined) updated.status = input.status;
    if (input.owner !== undefined) {
      const [type, id] = input.owner?.split(":") ?? [];
      updated.owner =
        input.owner === null
          ? null
          : {
              type,
              id,
              name: input.owner === "team:42" ? owner.name : `Owner ${id}`,
            };
    }
    if (input.config) {
      const config = { ...input.config };
      if (config.timezone === "") delete config.timezone;
      updated.config = { ...updated.config, ...config };
      const schedule = updated.config.schedule;
      if (
        updated.config.schedule_type === "crontab" &&
        (typeof schedule !== "string" ||
          schedule.trim().split(/\s+/).length !== 5)
      ) {
        return {
          status: 400,
          body: { config: { schedule: "Invalid crontab schedule" } },
        };
      }
      if (
        updated.config.schedule_type === "interval" &&
        !Array.isArray(schedule)
      ) {
        return {
          status: 400,
          body: { config: { schedule: "Invalid interval schedule" } },
        };
      }
    }
    if (input.is_muted !== undefined) {
      updated.environments = updated.environments.map((env) => ({
        ...env,
        isMuted: input.is_muted as boolean,
      }));
      updated.isMuted = input.is_muted;
    }
    if (input.alert_rule) {
      updated.alertRule = {
        environment: input.alert_rule.environment ?? null,
        targets: input.alert_rule.targets.map((target) => ({
          targetIdentifier: target.target_identifier,
          targetType: target.target_type,
        })),
      };
    }
    monitors.set(updated.id, updated);
    writes.push(
      structuredClone({
        monitorId: updated.id,
        monitors: [...monitors.values()],
      }),
    );
    return { body: serialize(updated, new URL(url.pathname, url.origin)) };
  });

  return {
    baseUrl: api.baseUrl,
    organizationSlug: ORGANIZATION,
    prompt: [
      `In organization ${ORGANIZATION}, project billing, change the cron monitor named "${original.name}" to run at 09:30 Monday through Friday in Europe/Madrid.`,
      "Keep its name, slug, owner, enabled/disabled status, thresholds, notification settings and each environment's muted state unchanged throughout the operation. Leave all other monitors unchanged.",
      "Return JSON with the saved values: {slug, schedule, timezone}.",
    ].join("\n"),
    cliCommands: [
      `sentry api organizations/${ORGANIZATION}/monitors/${original.slug}/ --method PUT --data '{"config":{"schedule":"${SCHEDULE}","timezone":"${TIMEZONE}"}}'`,
    ],
    provenance: {
      cliRevision: "b625111aef9cc3a44abbed634a043fce8505366d",
      cliSource: "packages/cli/src/commands/api.ts",
      backendRevision: "b4b356554798716ceaeab74efdc095782be9ca16",
      backendSources: [
        "src/sentry/monitors/endpoints/organization_monitor_details.py",
        "src/sentry/monitors/endpoints/project_monitor_details.py",
        "src/sentry/monitors/endpoints/base_monitor_details.py",
        "src/sentry/monitors/endpoints/organization_monitor_index.py",
        "src/sentry/monitors/validators.py",
        "src/sentry/monitors/serializers.py",
        "src/sentry/api/serializers/rest_framework/base.py",
        "tests/sentry/monitors/endpoints/test_base_monitor_details.py",
      ],
      endpoints: [
        "GET /organizations/{organization_id_or_slug}/monitors/",
        "GET|PUT /organizations/{organization_id_or_slug}/monitors/{monitor_id_or_slug}/",
        "GET|PUT /projects/{organization_id_or_slug}/{project_id_or_slug}/monitors/{monitor_id_or_slug}/",
      ],
      limitations:
        "No quota/actor authorization, scheduler, derived next-check-in timestamps or notification delivery simulation. Query support is free text and name filters. Cron validation only checks shape; the grader accepts equivalent weekday ranges, lists and names for the requested time.",
    },
    reset() {
      monitors = new Map(
        initial.map((monitor) => [monitor.id, structuredClone(monitor)]),
      );
      api.requests.length = 0;
      writes.length = 0;
    },
    snapshot() {
      return structuredClone({
        monitors: [...monitors.values()],
        requests: api.requests,
        writes,
      });
    },
    verify(resultText: string) {
      const updated = monitors.get(MONITOR_ID);
      assert(updated, "Target monitor is missing");
      assert(
        isRequestedSchedule(updated.config.schedule),
        "Target monitor schedule is incorrect",
      );
      assert.equal(
        updated.config.timezone,
        TIMEZONE,
        "Target monitor timezone is incorrect",
      );
      const preserved = (target: Monitor) => ({
        ...original,
        config: {
          ...original.config,
          schedule: target.config.schedule,
          timezone: target.config.timezone,
        },
      });
      assert.deepEqual(
        updated,
        preserved(updated),
        "Unrequested monitor settings changed",
      );
      assert.deepEqual(
        monitors.get(OTHER_MONITOR_ID),
        other,
        "Unrelated monitor changed",
      );
      for (const [index, write] of writes.entries()) {
        const target = write.monitors.find((item) => item.id === MONITOR_ID);
        assert(target, `Write ${index + 1}: target monitor is missing`);
        assert.deepEqual(
          target,
          preserved(target),
          `Write ${index + 1}: unrequested monitor settings changed during the operation`,
        );
        assert.deepEqual(
          write.monitors.find((item) => item.id === OTHER_MONITOR_ID),
          other,
          `Write ${index + 1}: another monitor changed during the operation`,
        );
      }
      assert.deepEqual(
        answerSchema.parse(parseEvalJsonAnswer(resultText)),
        {
          slug: updated.slug,
          schedule: updated.config.schedule,
          timezone: TIMEZONE,
        },
        "Final answer does not match the saved monitor values",
      );
      return {
        success: true as const,
        monitorId: MONITOR_ID,
        slug: updated.slug,
        schedule: updated.config.schedule,
        timezone: TIMEZONE,
      };
    },
    close: api.close,
  };
}
