/**
 * sentry alert issues delete
 *
 * Permanently delete an issue alert rule in a project.
 */

import type { SentryContext } from "../../../context.js";
import { deleteIssueAlertRule } from "../../../lib/api-client.js";
import { parseOrgProjectArg } from "../../../lib/arg-parsing.js";
import { ContextError, ValidationError } from "../../../lib/errors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { logger } from "../../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
  requireExplicitTarget,
} from "../../../lib/mutate-command.js";
import { resolveProjectBoundTargets } from "../../../lib/resolve-target.js";
import { parseIssueRuleArg, resolveIssueAlertRule } from "./rule-resolve.js";

const USAGE_HINT =
  "sentry alert issues delete <org>/<project>/<rule-id-or-name>";

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type DeleteResult = {
  org: string;
  project: string;
  ruleId: string;
  name: string;
  dryRun?: boolean;
};

function formatDeleted(r: DeleteResult): string {
  if (r.dryRun) {
    return `Would delete issue alert rule '${r.name}' (id ${r.ruleId}) in ${r.org}/${r.project}.`;
  }
  return `Deleted issue alert rule '${r.name}' (id ${r.ruleId}) in ${r.org}/${r.project}.`;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete an issue alert rule",
    fullDescription:
      "Permanently remove an issue alert rule from a project. This cannot be undone.\n\n" +
      "You will be asked to type org/project/rule-id to confirm, unless you pass " +
      "--yes or --force, or use --dry-run to preview only.\n\n" +
      "Examples:\n" +
      "  sentry alert issues delete my-org/my-app/12345\n" +
      "  sentry alert issues delete my-org/my-app/'My Rule' --yes\n" +
      "  sentry alert issues delete my-org/my-app/12345 --dry-run",
  },
  output: {
    human: formatDeleted,
    jsonTransform: (r: DeleteResult) =>
      r.dryRun
        ? {
            dryRun: true,
            org: r.org,
            project: r.project,
            id: r.ruleId,
            name: r.name,
          }
        : {
            deleted: true,
            org: r.org,
            project: r.project,
            id: r.ruleId,
            name: r.name,
          },
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project/rule-id-or-name",
          brief: "Rule id or name (same as view)",
          parse: String,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: DeleteFlags, arg: string) {
    const { cwd } = this;
    const { ref, targetArg } = parseIssueRuleArg(arg, USAGE_HINT);
    const parsed = parseOrgProjectArg(targetArg);
    requireExplicitTarget(parsed, "Issue alert target", USAGE_HINT);
    if (parsed.type !== "explicit") {
      throw new ValidationError(
        "Issue alert delete requires an explicit <org>/<project>/<rule-id-or-name> target.",
        "target"
      );
    }

    const { targets } = await resolveProjectBoundTargets(parsed, {
      cwd,
      usageHint: USAGE_HINT,
    });
    if (targets.length === 0) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    const { target, rule } = await resolveIssueAlertRule(
      targets,
      ref,
      USAGE_HINT
    );

    const key = `${target.org}/${target.project}/${rule.id}`;
    const name = rule.name;
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org: target.org,
        project: target.project,
        ruleId: rule.id,
        name,
        dryRun: true,
      } satisfies DeleteResult);
      return;
    }

    if (!isConfirmationBypassed(flags)) {
      const ok = await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this issue alert rule:`
      );
      if (!ok) {
        logger.info("Delete cancelled.");
        return;
      }
    }

    await deleteIssueAlertRule(target.org, rule.id);
    yield new CommandOutput({
      org: target.org,
      project: target.project,
      ruleId: rule.id,
      name,
    } satisfies DeleteResult);
  },
});
