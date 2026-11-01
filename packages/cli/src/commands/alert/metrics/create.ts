/**
 * sentry alert metrics create
 *
 * Create an organization-scoped metric alert rule.
 */

import type { SentryContext } from "../../../context.js";
import { createMetricAlertRule } from "../../../lib/api-client.js";
import type { ParsedOrgProject } from "../../../lib/arg-parsing.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import {
  aggregateParser,
  choiceParser,
  parseEnvironment,
  parseOwner,
  parseProjectList,
  parseText,
  parseWorkflowList,
} from "../../../lib/completion-target.js";
import { stringifyUnknown, ValidationError } from "../../../lib/errors.js";
import { warning } from "../../../lib/formatters/colors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../../lib/mutate-command.js";
import { resolveOrgOnlyTarget } from "../../../lib/resolve-target.js";
import {
  type OrgProjectTarget,
  orgProjectTarget,
} from "../../../lib/target-positional.js";
import {
  METRIC_ALERT_DATASET_BRIEF,
  METRIC_ALERT_DATASET_NAMES,
  parseMetricTriggers,
} from "../../../types/metric-alert.js";
import {
  METRIC_ALERT_FIELD_COMPLETION,
  METRIC_TIME_WINDOW_VALUES,
  normalizeProjectList,
  parseJsonObjectList,
  parseWorkflowIds,
  resolveMetricDataset,
  validateMetricDataset,
  validateMetricTimeWindow,
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
  readonly workflow?: string[];
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
  parsed: ParsedOrgProject,
  cwd: string,
): Promise<string> {
  return resolveOrgOnlyTarget(
    parsed,
    cwd,
    "alert metrics create",
    "sentry alert metrics create <org>/",
  );
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create a metric alert rule",
    fullDescription:
      "Create a metric alert rule (a metric monitor in the detectors API).\n\n" +
      "Required fields:\n" +
      "  --name, --query, --aggregate, --dataset, --time-window, --trigger (>=1), --project\n\n" +
      "Optional fields:\n" +
      "  --environment, --owner, --workflow\n\n" +
      "Triggers:\n" +
      '  {"alertThreshold":N, "label":"critical"|"warning", "resolveThreshold":N, "thresholdType":0|1}\n' +
      "  thresholdType 0 alerts above the threshold (default), 1 below. Without resolveThreshold\n" +
      "  the rule resolves at the critical threshold. Native detector conditions\n" +
      '  ({"type":"gt","comparison":N,"conditionResult":75}) are passed through as-is.\n' +
      "  Notifications are not part of triggers: pass --workflow with an existing alert id.",
    examples: [
      {
        description: "Alert when P95 span duration goes above 500ms",
        command:
          "sentry alert metrics create my-org/ --name 'P95 latency' --project my-project --query 'environment:prod' --aggregate 'p95(span.duration)' --dataset spans --time-window 5 --trigger '{\"alertThreshold\":500}'",
      },
      {
        description:
          "Preview an alert on any matching log line that notifies through an existing alert",
        command:
          "sentry alert metrics create my-org/ --name 'AI chat failures' --project my-project --query 'action:ai.chat result:error' --aggregate 'count()' --dataset logs --time-window 5 --trigger '{\"alertThreshold\":0,\"resolveThreshold\":0}' --workflow 12345 --dry-run",
      },
    ],
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
          parse: orgProjectTarget((parsed, { cwd }) =>
            resolveMetricCreateOrg(parsed, cwd),
          ),
        },
      ],
    },
    flags: {
      name: {
        kind: "parsed",
        parse: parseText,
        brief: "Rule name",
      },
      query: {
        kind: "parsed",
        parse: parseText,
        brief: "Metric query filter string",
      },
      aggregate: {
        kind: "parsed",
        parse: aggregateParser(METRIC_ALERT_FIELD_COMPLETION),
        brief: "Aggregate expression (for example count(), p95(span.duration))",
      },
      dataset: {
        kind: "parsed",
        parse: choiceParser(METRIC_ALERT_DATASET_NAMES),
        brief: METRIC_ALERT_DATASET_BRIEF,
      },
      "time-window": {
        kind: "parsed",
        parse: choiceParser(METRIC_TIME_WINDOW_VALUES, numberParser),
        brief: "Evaluation window in minutes",
      },
      trigger: {
        kind: "parsed",
        parse: parseText,
        variadic: true,
        optional: true,
        brief: "Trigger object JSON (repeatable, or pass one JSON array)",
      },
      project: {
        kind: "parsed",
        parse: parseProjectList,
        variadic: true,
        optional: true,
        brief: "Project slug filter (repeatable or comma-separated)",
      },
      environment: {
        kind: "parsed",
        parse: parseEnvironment,
        optional: true,
        brief: "Environment filter",
      },
      owner: {
        kind: "parsed",
        parse: parseOwner,
        optional: true,
        brief: "Owner value accepted by Sentry API",
      },
      workflow: {
        kind: "parsed",
        parse: parseWorkflowList,
        variadic: true,
        optional: true,
        brief: "Alert (workflow) id to notify (repeatable or comma-separated)",
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, t: "trigger", p: "project" },
  },
  async *func(
    this: SentryContext,
    flags: CreateFlags,
    target: OrgProjectTarget<string>,
  ) {
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

    const triggers = parseMetricTriggers(
      parseJsonObjectList(flags.trigger, "trigger"),
    );
    const projects = normalizeProjectList(flags.project);
    if (!projects || projects.length === 0) {
      throw new ValidationError(
        "A project is required to create a metric alert rule (pass --project).",
        "project",
      );
    }

    const orgSlug = await target.resolved;

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
    const workflowIds = parseWorkflowIds(flags.workflow);
    if (workflowIds) {
      body.workflowIds = workflowIds;
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
      id: stringifyUnknown(created.id ?? ""),
      name: stringifyUnknown(created.name ?? flags.name),
      status: metricAlertStatusLabel(created.status),
    } satisfies CreateResult);
  },
});
