/**
 * sentry alert issues delete
 *
 * Permanently delete an issue alert rule in a project.
 */

import type { SentryContext } from "../../../context.js";
import { deleteIssueAlertRule } from "../../../lib/api-client.js";
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
import type { AlertRuleArgument } from "../arguments.js";
import { issueRuleParameter, resolveIssueAlertRule } from "./rule-resolve.js";
import type { IssueAlertDeleteOutput } from "../../../output-schemas/alert.js";
import { IssueAlertDeleteOutputSchema } from "../../../generated/output-schemas/alert.js";
import { sentry } from "../../../lib/app-identity.js";

const usageHint = () =>
  sentry`alert issues delete <org>/<project>/<rule-id-or-name>`;

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

function formatDeleted(r: IssueAlertDeleteOutput): string {
  if (r.dryRun) {
    return `Would delete issue alert rule '${r.name}' (id ${r.id}) in ${r.org}/${r.project}.`;
  }
  return `Deleted issue alert rule '${r.name}' (id ${r.id}) in ${r.org}/${r.project}.`;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete an issue alert rule",
    fullDescription:
      "Permanently remove an issue alert rule from a project. This cannot be undone.\n\n" +
      "You will be asked to type org/project/rule-id to confirm, unless you pass " +
      "--yes or --force, or use --dry-run to preview only.",
    examples: [
      {
        description: "Delete an issue alert rule (prompts for confirmation)",
        run: "alert issues delete my-org/my-project/12345",
      },
      {
        description: "Delete a rule selected by name without prompting",
        run: "alert issues delete my-org/my-project/'My Rule' --yes",
      },
      {
        description: "Preview the deletion",
        run: "alert issues delete my-org/my-project/12345 --dry-run",
      },
    ],
  },
  output: {
    human: formatDeleted,
    schema: IssueAlertDeleteOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        issueRuleParameter(usageHint, "Rule id or name (same as view)"),
      ],
    },
  },
  async *func(
    this: SentryContext,
    flags: DeleteFlags,
    ruleArg: AlertRuleArgument,
  ) {
    const { cwd } = this;
    const { ref, target: parsed } = await ruleArg.resolved;
    requireExplicitTarget(parsed, "Issue alert target", usageHint());
    if (parsed.type !== "explicit") {
      throw new ValidationError(
        "Issue alert delete requires an explicit <org>/<project>/<rule-id-or-name> target.",
        "target",
      );
    }

    const { targets } = await resolveProjectBoundTargets(parsed, {
      cwd,
      usageHint: usageHint(),
    });
    if (targets.length === 0) {
      throw new ContextError("Organization and project", usageHint());
    }

    const { target, rule } = await resolveIssueAlertRule(
      targets,
      ref,
      usageHint(),
    );

    const key = `${target.org}/${target.project}/${rule.id}`;
    const name = rule.name;
    if (flags["dry-run"]) {
      yield new CommandOutput({
        dryRun: true,
        org: target.org,
        project: target.project,
        id: rule.id,
        name,
      } satisfies IssueAlertDeleteOutput);
      return;
    }

    if (!isConfirmationBypassed(flags)) {
      const ok = await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this issue alert rule:`,
      );
      if (!ok) {
        logger.info("Delete cancelled.");
        return;
      }
    }

    await deleteIssueAlertRule(target.org, rule.id);
    yield new CommandOutput({
      deleted: true,
      org: target.org,
      project: target.project,
      id: rule.id,
      name,
    } satisfies IssueAlertDeleteOutput);
  },
});
