/**
 * sentry alert metrics create
 *
 * Create an organization-scoped metric alert rule.
 */

import type { SentryContext } from "../../../context.js";
import { createMetricAlertRule } from "../../../lib/api-client.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { warning } from "../../../lib/formatters/colors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../../lib/mutate-command.js";
import { resolveOrgOnlyFromArg } from "../../../lib/resolve-target.js";
import {
  normalizeProjectList,
  parseJsonObjectList,
  resolveMetricDataset,
  validateMetricDataset,
  validateMetricTimeWindow,
  validateMetricTriggers,
} from "../mutation-utils.js";
import { metricAlertStatusLabel } from "./status.js";

type CreateFlags = {
  readonly name: string;
  readonly query: string;
  readonly aggregate: string;
  readonly dataset: string;
  readonly "time-window": number;
  readonly trigger?: string[];
  readonly project?: string[];
  readonly environment?: string;
  readonly owner?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type CreateResult = {
  org: string;
  id?: string;
  name: string;
  status?: "active" | "disabled";
  dryRun?: boolean;
  body?: Record<string, unknown>;
};

function formatCreated(result: CreateResult): string {
  if (result.dryRun) {
    return `Would create metric alert rule '${result.name}' in ${result.org}.`;
  }
  return `Created metric alert rule ${result.id ?? "(unknown id)"} in ${result.org}: ${result.name} (${result.status ?? "active"}).`;
}

function resolveMetricCreateOrg(
  arg: string | undefined,
  cwd: string
): Promise<string> {
  return resolveOrgOnlyFromArg(
    arg,
    cwd,
    "alert metrics create",
    "sentry alert metrics create <org>/"
  );
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create a metric alert rule",
    fullDescription:
      "Create an organization-scoped metric alert rule.\n\n" +
      "Required fields:\n" +
      "  --name, --query, --aggregate, --dataset, --time-window, --trigger (>=1), --project\n\n" +
      "Optional fields:\n" +
      "  --environment, --owner\n\n" +
      "Examples:\n" +
      "  sentry alert metrics create my-org/ --name 'P95 latency' \\\n" +
      "    --query 'environment:prod' --aggregate 'p95(span.duration)' \\\n" +
      "    --dataset spans --time-window 5 \\\n" +
      '    --trigger \'{"alertThreshold":500,"actions":[{"id":"sentry.mail.actions.NotifyEmailAction","targetType":"Team","targetIdentifier":1}]}\'\n\n' +
      "  sentry alert metrics create my-org/ --name 'Error volume' \\\n" +
      "    --query 'event.type:error' --aggregate 'count()' --dataset errors \\\n" +
      '    --time-window 15 --trigger \'[{"alertThreshold":100,"actions":[{"id":"sentry.mail.actions.NotifyEmailAction","targetType":"Team","targetIdentifier":1}]}]\' \\\n' +
      "    --project my-app --dry-run",
  },
  output: {
    human: formatCreated,
    jsonTransform: (result: CreateResult) => result,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "target",
          brief: "Target project or organization",
          parse: String,
        },
      ],
    },
    flags: {
      name: {
        kind: "parsed",
        parse: String,
        brief: "Rule name",
      },
      query: {
        kind: "parsed",
        parse: String,
        brief: "Metric query filter string",
      },
      aggregate: {
        kind: "parsed",
        parse: String,
        brief: "Aggregate expression (for example count(), p95(span.duration))",
      },
      dataset: {
        kind: "parsed",
        parse: String,
        brief:
          "Dataset: errors (error-events), sessions, events, spans, metrics (transaction(s) routes to spans)",
      },
      "time-window": {
        kind: "parsed",
        parse: numberParser,
        brief: "Evaluation window in minutes",
      },
      trigger: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        brief: "Trigger object JSON (repeatable, or pass one JSON array)",
      },
      project: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        brief: "Project slug filter (repeatable or comma-separated)",
      },
      environment: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Environment filter",
      },
      owner: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Owner value accepted by Sentry API",
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, t: "trigger", p: "project" },
  },
  async *func(this: SentryContext, flags: CreateFlags, arg: string) {
    const { cwd } = this;
    if (!flags.name.trim()) {
      throw new ValidationError("Rule name cannot be empty.", "name");
    }
    if (!flags.query.trim()) {
      throw new ValidationError("query cannot be empty.", "query");
    }
    if (!flags.aggregate.trim()) {
      throw new ValidationError("aggregate cannot be empty.", "aggregate");
    }

    const {
      dataset,
      query,
      notice: datasetNotice,
    } = resolveMetricDataset(flags.dataset, flags.query);
    validateMetricDataset(dataset);
    validateMetricTimeWindow(flags["time-window"]);
    if (datasetNotice) {
      this.stderr.write(`${warning(`Tip: ${datasetNotice}`)}\n`);
    }

    const triggers = parseJsonObjectList(flags.trigger, "trigger");
    validateMetricTriggers(triggers);
    const projects = normalizeProjectList(flags.project);
    if (!projects || projects.length === 0) {
      throw new ValidationError(
        "A project is required to create a metric alert rule (pass --project).",
        "project"
      );
    }

    const orgSlug = await resolveMetricCreateOrg(arg, cwd);

    const body: Record<string, unknown> = {
      name: flags.name,
      query,
      aggregate: flags.aggregate,
      dataset,
      timeWindow: flags["time-window"],
      triggers,
    };
    if (projects && projects.length > 0) {
      body.projects = projects;
    }
    if (flags.environment !== undefined) {
      body.environment = flags.environment;
    }
    if (flags.owner !== undefined) {
      body.owner = flags.owner;
    }

    if (flags["dry-run"]) {
      yield new CommandOutput({
        org: orgSlug,
        name: flags.name,
        dryRun: true,
        body,
      } satisfies CreateResult);
      return { hint: "Dry run - no metric alert rule was created." };
    }

    const created = await createMetricAlertRule(orgSlug, body);
    yield new CommandOutput({
      org: orgSlug,
      id: String(created.id ?? ""),
      name: String(created.name ?? flags.name),
      status: metricAlertStatusLabel(created.status),
    } satisfies CreateResult);
  },
});
