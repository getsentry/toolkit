import type { SentryContext } from "../../../context.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { openInBrowser } from "../../../lib/browser.js";
import { buildCommand } from "../../../lib/command.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { resolveOrgOnlyFromArg } from "../../../lib/resolve-target.js";
import { buildMetricAlertsUrl } from "../../../lib/sentry-urls.js";
import {
  type MetricRuleResolution,
  parseMetricRuleArg,
  resolveMetricAlertRule,
} from "./rule-resolve.js";
import { metricAlertStatusLabel } from "./status.js";

const USAGE_HINT = "sentry alert metrics view <org>/<rule-id-or-name>";

type ViewFlags = {
  readonly web: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type MetricAlertViewResult = MetricRuleResolution;

function formatMetricAlertView(data: MetricRuleResolution): string {
  const { orgSlug, rule } = data;
  const status = metricAlertStatusLabel(rule.status);
  return [
    `Metric alert rule in ${orgSlug}:`,
    "",
    `ID:           ${rule.id}`,
    `Name:         ${rule.name}`,
    `Status:       ${status}`,
    `Dataset:      ${rule.dataset}`,
    `Aggregate:    ${rule.aggregate}`,
    `Query:        ${rule.query || "(none)"}`,
    `Time Window:  ${rule.timeWindow}m`,
    `Projects:     ${rule.projects.join(", ") || "(all)"}`,
    `Environment:  ${rule.environment ?? "all"}`,
    `Owner:        ${rule.owner ?? "none"}`,
  ].join("\n");
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View a metric alert rule",
    fullDescription:
      "View a single metric alert rule by ID or name.\n\n" +
      "Examples:\n" +
      "  sentry alert metrics view 12345\n" +
      "  sentry alert metrics view my-org/12345\n" +
      "  sentry alert metrics view my-org/'p95 latency alert'",
  },
  output: {
    human: formatMetricAlertView,
    jsonTransform: (data: MetricAlertViewResult) => ({
      ...data.rule,
      org: data.orgSlug,
    }),
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
        "metric alert rules"
      );
      return;
    }

    const org = await resolveOrgOnlyFromArg(
      targetArg,
      cwd,
      "alert metrics view"
    );

    if (flags.web) {
      await openInBrowser(buildMetricAlertsUrl(org), "metric alert rules");
      return;
    }

    const result = await resolveMetricAlertRule([org], ref, USAGE_HINT);
    yield new CommandOutput(result);
  },
});
