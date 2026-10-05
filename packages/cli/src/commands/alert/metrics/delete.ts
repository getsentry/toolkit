/**
 * sentry alert metrics delete
 *
 * Permanently delete a metric (organization) alert rule.
 */

import type { SentryContext } from "../../../context.js";
import { deleteMetricAlertRule } from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { logger } from "../../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
  requireExplicitTarget,
} from "../../../lib/mutate-command.js";
import { resolveOrgOnlyFromArg } from "../../../lib/resolve-target.js";
import { parseMetricRuleArg, resolveMetricAlertRule } from "./rule-resolve.js";

const USAGE_HINT = "sentry alert metrics delete <org>/<rule-id-or-name>";

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type DeleteResult = {
  org: string;
  ruleId: string;
  name: string;
  dryRun?: boolean;
};

function formatDeleted(r: DeleteResult): string {
  if (r.dryRun) {
    return `Would delete metric alert rule '${r.name}' (id ${r.ruleId}) in ${r.org}.`;
  }
  return `Deleted metric alert rule '${r.name}' (id ${r.ruleId}) in ${r.org}.`;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete a metric alert rule",
    fullDescription:
      "Permanently remove a metric alert rule from an organization. " +
      "Type org/rule-id to confirm, or use --yes / --force, or --dry-run.\n\n" +
      "Examples:\n" +
      "  sentry alert metrics delete my-org/12345\n" +
      "  sentry alert metrics delete my-org/'P95 alert' --yes",
  },
  output: {
    human: formatDeleted,
    jsonTransform: (r: DeleteResult) =>
      r.dryRun
        ? { dryRun: true, org: r.org, id: r.ruleId, name: r.name }
        : { deleted: true, org: r.org, id: r.ruleId, name: r.name },
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
  },
  async *func(this: SentryContext, flags: DeleteFlags, arg: string) {
    const { cwd } = this;
    const { ref, targetArg } = parseMetricRuleArg(arg, USAGE_HINT);
    requireExplicitTarget(
      parseOrgProjectArg(targetArg),
      "Metric alert target",
      USAGE_HINT
    );
    const org = await resolveOrgOnlyFromArg(
      targetArg,
      cwd,
      "alert metrics delete"
    );
    const orgSlugs = [org];

    const { orgSlug, rule } = await resolveMetricAlertRule(
      orgSlugs,
      ref,
      USAGE_HINT
    );
    const key = `${orgSlug}/${rule.id}`;
    const name = rule.name;
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org: orgSlug,
        ruleId: rule.id,
        name,
        dryRun: true,
      } satisfies DeleteResult);
      return;
    }
    if (!isConfirmationBypassed(flags)) {
      const ok = await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this metric alert rule:`
      );
      if (!ok) {
        logger.info("Delete cancelled.");
        return;
      }
    }

    await deleteMetricAlertRule(orgSlug, rule.id);
    yield new CommandOutput({ org: orgSlug, ruleId: rule.id, name });
  },
});
