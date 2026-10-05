import type { SentryContext } from "../../../context.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { openInBrowser } from "../../../lib/browser.js";
import { buildCommand } from "../../../lib/command.js";
import { ContextError } from "../../../lib/errors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { resolveProjectBoundTargets } from "../../../lib/resolve-target.js";
import { buildIssueAlertsUrl } from "../../../lib/sentry-urls.js";
import {
  type IssueRuleResolution,
  parseIssueRuleArg,
  resolveIssueAlertRule,
} from "./rule-resolve.js";

const USAGE_HINT = "sentry alert issues view <org>/<project>/<rule-id-or-name>";

type ViewFlags = {
  readonly web: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type IssueAlertViewResult = IssueRuleResolution;

function formatIssueAlertView(data: IssueRuleResolution): string {
  const { target, rule } = data;
  return [
    `Issue alert rule in ${target.org}/${target.project}:`,
    "",
    `ID:           ${rule.id}`,
    `Name:         ${rule.name}`,
    `Status:       ${rule.status}`,
    `Action Match: ${rule.actionMatch}`,
    `Frequency:    ${rule.frequency}m`,
    `Conditions:   ${rule.conditions?.length ?? 0}`,
    `Actions:      ${rule.actions?.length ?? 0}`,
    `Environment:  ${rule.environment ?? "all"}`,
    `Owner:        ${rule.owner ?? "none"}`,
  ].join("\n");
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View an issue alert rule",
    fullDescription:
      "View a single issue alert rule by ID or name.\n\n" +
      "Examples:\n" +
      "  sentry alert issues view 12345\n" +
      "  sentry alert issues view my-org/my-project/12345\n" +
      "  sentry alert issues view my-org/my-project/'Error Spike'",
  },
  output: {
    human: formatIssueAlertView,
    jsonTransform: (data: IssueAlertViewResult) => ({
      ...data.rule,
      org: data.target.org,
      project: data.target.project,
    }),
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project/rule-id-or-name",
          brief: "Issue alert rule ID or name",
          parse: String,
        },
      ],
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open issue alert rules page in browser",
        default: false,
      },
    },
    aliases: { w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, arg: string) {
    const { cwd } = this;
    const { ref, targetArg } = parseIssueRuleArg(arg, USAGE_HINT);
    const parsed = parseOrgProjectArg(targetArg);

    if (flags.web && parsed.type === "explicit") {
      await openInBrowser(
        buildIssueAlertsUrl(parsed.org, parsed.project),
        "issue alert rules"
      );
      return;
    }

    const { targets } = await resolveProjectBoundTargets(parsed, {
      cwd,
      usageHint: "sentry alert issues view <org>/<project>/<rule-id-or-name>",
    });
    if (targets.length === 0) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    if (flags.web) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
      const t = targets[0]!;
      await openInBrowser(
        buildIssueAlertsUrl(t.org, t.project),
        "issue alert rules"
      );
      return;
    }

    const result = await resolveIssueAlertRule(targets, ref, USAGE_HINT);
    yield new CommandOutput(result);
  },
});
