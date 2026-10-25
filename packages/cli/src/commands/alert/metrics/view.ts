import type { SentryContext } from "../../../context.js";
import {
  getIssueAlertWorkflowDocument,
  getMetricAlertRule,
} from "../../../lib/api-client.js";
import { METRIC_ALERT_API } from "../../../lib/api/alerts.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { openInBrowser } from "../../../lib/browser.js";
import { buildCommand } from "../../../lib/command.js";
import { ApiError } from "../../../lib/errors.js";
import {
  formatMetricAlertView,
  type MetricAlertViewResult,
} from "../../../lib/formatters/alerts.js";
import { filterFields } from "../../../lib/formatters/json.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { resolveOrgOnlyFromArg } from "../../../lib/resolve-target.js";
import { buildMetricAlertsUrl } from "../../../lib/sentry-web-urls.js";
import { isAllDigits } from "../../../lib/utils.js";
import { parseMetricRuleArg, resolveMetricAlertRule } from "./rule-resolve.js";

const USAGE_HINT = "sentry alert metrics view <org>/<rule-id-or-name>";

type ViewFlags = {
  readonly web: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export const viewCommand = buildCommand({
  docs: {
    relatedApi: [METRIC_ALERT_API.get],
    brief: "View a metric alert rule",
    fullDescription:
      "View a metric alert rule by ID or name, including detection settings, " +
      "threshold conditions, and linked notification workflows.\n\n" +
      "JSON preserves native config, conditionGroup, workflowIds, and workflow " +
      "documents. Workflows that cannot be read (403/404) are listed in " +
      "workflowErrors. This shows current configuration, not delivery history.",
    examples: [
      {
        description:
          "View a metric alert rule by ID (organization auto-detected)",
        command: "sentry alert metrics view 12345",
      },
      {
        description: "View by ID in an explicit organization",
        command: "sentry alert metrics view my-org/12345",
      },
      {
        description: "View by name",
        command: "sentry alert metrics view my-org/'P95 latency alert'",
      },
      {
        description: "Inspect native thresholds and notification workflows",
        command: "sentry alert metrics view my-org/12345 --json",
      },
    ],
  },
  output: {
    human: formatMetricAlertView,
    jsonTransform: (data: MetricAlertViewResult, fields) => {
      const result = {
        ...data.rule,
        org: data.orgSlug,
        workflows: data.workflows,
        workflowErrors: data.workflowErrors,
      };
      return fields?.length ? filterFields(result, fields) : result;
    },
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/rule-id-or-name",
          brief: "Metric alert rule ID or name",
          parse: String,
        },
      ],
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open metric alert rules page in browser",
        default: false,
      },
    },
    aliases: { w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, arg: string) {
    const { cwd } = this;
    const { ref, targetArg } = parseMetricRuleArg(arg, USAGE_HINT);
    const parsed = parseOrgProjectArg(targetArg);

    if (flags.web && parsed.type === "org-all") {
      await openInBrowser(
        buildMetricAlertsUrl(parsed.org),
        "metric alert rules",
      );
      return;
    }

    const org = await resolveOrgOnlyFromArg(
      targetArg,
      cwd,
      "alert metrics view",
    );

    if (flags.web) {
      await openInBrowser(buildMetricAlertsUrl(org), "metric alert rules");
      return;
    }

    const result = await resolveMetricAlertRule([org], ref, USAGE_HINT);
    // Name resolution uses the compact list projection; inspect the detail
    // document so it has the same conditions and links as an ID lookup.
    const rule = isAllDigits(ref)
      ? result.rule
      : await getMetricAlertRule(result.orgSlug, result.rule.id);
    const data: MetricAlertViewResult = {
      orgSlug: result.orgSlug,
      rule,
      workflows: [],
      workflowErrors: [],
    };
    for (const id of new Set(rule.workflowIds ?? [])) {
      try {
        data.workflows.push(
          await getIssueAlertWorkflowDocument(result.orgSlug, id),
        );
      } catch (error) {
        // A missing or inaccessible link must not hide the readable detector
        // or be mistaken for an alert with no notification configuration.
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          data.workflowErrors.push({ id, status: error.status });
        } else {
          throw error;
        }
      }
    }
    yield new CommandOutput(data);
  },
});
