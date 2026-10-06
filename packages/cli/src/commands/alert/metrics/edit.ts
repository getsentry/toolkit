/**
 * sentry alert metrics edit
 *
 * Update a metric alert rule (name and/or enabled status).
 */

import type { SentryContext } from "../../../context.js";
import {
  getMetricAlertRuleDocument,
  putMetricAlertRule,
} from "../../../lib/api-client.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { warning } from "../../../lib/formatters/colors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { resolveOrgOnlyFromArg } from "../../../lib/resolve-target.js";
import {
  normalizeMetricDataset,
  normalizeProjectList,
  parseJsonObjectList,
  parseStatusFlag,
  resolveMetricDataset,
  statusToMetricValue,
  validateMetricDataset,
  validateMetricTimeWindow,
  validateMetricTriggers,
} from "../mutation-utils.js";
import { parseMetricRuleArg, resolveMetricAlertRule } from "./rule-resolve.js";
import { metricAlertStatusLabel } from "./status.js";

const USAGE_HINT =
  "sentry alert metrics edit <org>/<rule-id-or-name> --name <n> | --status active|disabled";

type EditFlags = {
  readonly name?: string;
  readonly status?: "active" | "disabled" | undefined;
  readonly query?: string;
  readonly aggregate?: string;
  readonly dataset?: string;
  readonly "time-window"?: number;
  readonly trigger?: string[];
  readonly project?: string[];
  readonly environment?: string;
  readonly owner?: string;
  readonly json: boolean;
  readonly fields?: string[];
};

type EditResult = Record<string, unknown> & {
  org: string;
  id: string;
};

function hasMetricMutations(flags: EditFlags): boolean {
  return (
    flags.name !== undefined ||
    flags.status !== undefined ||
    flags.query !== undefined ||
    flags.aggregate !== undefined ||
    flags.dataset !== undefined ||
    flags["time-window"] !== undefined ||
    flags.trigger !== undefined ||
    flags.project !== undefined ||
    flags.environment !== undefined ||
    flags.owner !== undefined
  );
}

function validateMetricEditFlags(flags: EditFlags): void {
  if (!hasMetricMutations(flags)) {
    throw new ValidationError(
      "Pass at least one editable field (for example --name or --status).",
      "name"
    );
  }
}

function applyMetricCoreFields(
  body: Record<string, unknown>,
  flags: EditFlags
): string | undefined {
  let notice: string | undefined;
  if (flags.name !== undefined) {
    body.name = flags.name;
  }
  if (flags.status !== undefined) {
    body.status = statusToMetricValue(flags.status);
  }
  if (flags.query !== undefined) {
    body.query = flags.query;
  }
  if (flags.aggregate !== undefined) {
    if (!flags.aggregate.trim()) {
      throw new ValidationError("aggregate cannot be empty.", "aggregate");
    }
    body.aggregate = flags.aggregate;
  }
  if (flags.dataset !== undefined) {
    // Resolve against the effective query (the just-applied --query flag, or the
    // rule's existing query) so a `transaction(s)` request routes to `spans`
    // with `is_transaction:true` added even when --query is not also passed.
    const currentQuery = typeof body.query === "string" ? body.query : "";
    const resolved = resolveMetricDataset(flags.dataset, currentQuery);
    validateMetricDataset(resolved.dataset);
    body.dataset = resolved.dataset;
    body.query = resolved.query;
    notice = resolved.notice;
  }
  if (flags["time-window"] !== undefined) {
    validateMetricTimeWindow(flags["time-window"]);
    body.timeWindow = flags["time-window"];
  }
  return notice;
}

function applyMetricOptionalFields(
  body: Record<string, unknown>,
  flags: EditFlags
): Record<string, unknown> {
  if (flags.trigger !== undefined) {
    body.triggers = parseJsonObjectList(flags.trigger, "trigger");
  }
  if (flags.project !== undefined) {
    body.projects = normalizeProjectList(flags.project) ?? [];
  }
  if (flags.environment !== undefined) {
    body.environment =
      flags.environment.trim() === "" ? null : flags.environment;
  }
  if (flags.owner !== undefined) {
    body.owner = flags.owner.trim() === "" ? null : flags.owner;
  }
  return body;
}

function validateMetricBody(
  body: Record<string, unknown>,
  flags: EditFlags
): void {
  if (flags.trigger !== undefined) {
    validateMetricTriggers(
      body.triggers as Record<string, unknown>[] | undefined
    );
  }
  if (flags.dataset !== undefined) {
    validateMetricDataset(normalizeMetricDataset(String(body.dataset)));
  }
  if (flags["time-window"] !== undefined) {
    validateMetricTimeWindow(Number(body.timeWindow));
  }
  if (flags.query !== undefined && typeof body.query !== "string") {
    throw new ValidationError("query must be a string.", "query");
  }
  if (
    flags.aggregate !== undefined &&
    (typeof body.aggregate !== "string" || body.aggregate.trim() === "")
  ) {
    throw new ValidationError(
      "aggregate must be present and non-empty.",
      "aggregate"
    );
  }
}

function formatEdited(r: EditResult): string {
  return `Updated metric alert rule ${r.id} in ${r.org}: ${String(r.name)} (${String(r.status)}).`;
}

export const editCommand = buildCommand({
  docs: {
    brief: "Edit a metric alert rule",
    fullDescription:
      "Update a metric alert rule. Pass at least one of --name or --status. " +
      "Status 'active' enables the rule; 'disabled' sets it to disabled (API status 1).\n\n" +
      "Examples:\n" +
      "  sentry alert metrics edit my-org/9 --name 'Error budget'\n" +
      "  sentry alert metrics edit my-org/9 --status disabled\n" +
      "  sentry alert metrics edit my-org/9 --time-window 15 --dataset spans",
  },
  output: {
    human: formatEdited,
    jsonTransform: (r: EditResult) => r,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/rule-id-or-name",
          brief: "Rule id or name (same as view)",
          parse: String,
        },
      ],
    },
    flags: {
      name: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "New rule name",
      },
      status: {
        kind: "parsed",
        parse: parseStatusFlag,
        optional: true,
        brief: "active or disabled",
      },
      query: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Metric query filter",
      },
      aggregate: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Aggregate expression",
      },
      dataset: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief:
          "Dataset: errors (error-events), sessions, events, spans, metrics (transaction(s) routes to spans)",
      },
      "time-window": {
        kind: "parsed",
        parse: numberParser,
        optional: true,
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
        brief: "Environment value (pass empty string to clear)",
      },
      owner: {
        kind: "parsed",
        parse: String,
        optional: true,
        brief: "Owner value (pass empty string to clear)",
      },
    },
    aliases: {
      t: "trigger",
      p: "project",
    },
  },
  async *func(this: SentryContext, flags: EditFlags, arg: string) {
    const { cwd } = this;
    validateMetricEditFlags(flags);
    const { ref, targetArg } = parseMetricRuleArg(arg, USAGE_HINT);
    const org = await resolveOrgOnlyFromArg(
      targetArg,
      cwd,
      "alert metrics edit"
    );
    const orgSlugs = [org];
    const { orgSlug, rule } = await resolveMetricAlertRule(
      orgSlugs,
      ref,
      USAGE_HINT
    );
    const body = {
      ...(await getMetricAlertRuleDocument(orgSlug, rule.id)),
    } as Record<string, unknown>;
    const datasetNotice = applyMetricCoreFields(body, flags);
    applyMetricOptionalFields(body, flags);
    validateMetricBody(body, flags);
    if (datasetNotice) {
      this.stderr.write(`${warning(`Tip: ${datasetNotice}`)}\n`);
    }
    const updated = await putMetricAlertRule(orgSlug, rule.id, body);
    yield new CommandOutput({
      ...updated,
      org: orgSlug,
      id: String(updated.id ?? rule.id),
      status: metricAlertStatusLabel(updated.status),
    } satisfies EditResult);
  },
});
