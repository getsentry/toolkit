/**
 * sentry alert metrics delete
 *
 * Permanently delete a metric (organization) alert rule.
 */

import type { SentryContext } from "../../../context.js";
import { deleteMetricAlertRule } from "../../../lib/api-client.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { logger } from "../../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
  requireExplicitTarget,
} from "../../../lib/mutate-command.js";
import { resolveOrgOnlyTarget } from "../../../lib/resolve-target.js";
import type { AlertRuleArgument } from "../arguments.js";
import { metricRuleParameter, resolveMetricAlertRule } from "./rule-resolve.js";
import type { MetricAlertDeleteOutput } from "../../../output-schemas/alert.js";
import { MetricAlertDeleteOutputSchema } from "../../../generated/output-schemas/alert.js";
import { sentry } from "../../../lib/app-identity.js";

const usageHint = () => sentry`alert metrics delete <org>/<rule-id-or-name>`;

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

function formatDeleted(r: MetricAlertDeleteOutput): string {
  if (r.dryRun) {
    return `Would delete metric alert rule '${r.name}' (id ${r.id}) in ${r.org}.`;
  }
  return `Deleted metric alert rule '${r.name}' (id ${r.id}) in ${r.org}.`;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete a metric alert rule",
    fullDescription:
      "Permanently remove a metric alert rule from an organization. " +
      "Type org/rule-id to confirm, or use --yes / --force, or --dry-run.",
    examples: [
      {
        description: "Delete a metric alert rule (prompts for confirmation)",
        run: "alert metrics delete my-org/12345",
      },
      {
        description: "Delete a rule selected by name without prompting",
        run: "alert metrics delete my-org/'P95 alert' --yes",
      },
    ],
  },
  output: {
    human: formatDeleted,
    schema: MetricAlertDeleteOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        metricRuleParameter(usageHint, "Rule id or name (same as view)"),
      ],
    },
  },
  async *func(
    this: SentryContext,
    flags: DeleteFlags,
    ruleArg: AlertRuleArgument,
  ) {
    const { cwd } = this;
    const { ref, target } = await ruleArg.resolved;
    requireExplicitTarget(target, "Metric alert target", usageHint());
    const org = await resolveOrgOnlyTarget(target, cwd, "alert metrics delete");
    const orgSlugs = [org];

    const { orgSlug, rule } = await resolveMetricAlertRule(
      orgSlugs,
      ref,
      usageHint(),
    );
    const key = `${orgSlug}/${rule.id}`;
    const name = rule.name;
    if (flags["dry-run"]) {
      yield new CommandOutput({
        dryRun: true,
        org: orgSlug,
        id: rule.id,
        name,
      } satisfies MetricAlertDeleteOutput);
      return;
    }
    if (!isConfirmationBypassed(flags)) {
      const ok = await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this metric alert rule:`,
      );
      if (!ok) {
        logger.info("Delete cancelled.");
        return;
      }
    }

    await deleteMetricAlertRule(orgSlug, rule.id);
    yield new CommandOutput({
      deleted: true,
      org: orgSlug,
      id: rule.id,
      name,
    } satisfies MetricAlertDeleteOutput);
  },
});
