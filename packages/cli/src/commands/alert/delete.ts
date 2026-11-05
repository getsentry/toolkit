import type { SentryContext } from "../../context.js";
import { deleteAlert } from "../../lib/api/alerts.js";
import { formatAlertDelete } from "../../lib/formatters/alerts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { AlertDeleteOutputSchema } from "../../generated/output-schemas/alert.js";
import type { AlertDeleteOutput } from "../../output-schemas/alert.js";
import {
  type AlertArgument,
  alertParameter,
  resolveAlert,
} from "./arguments.js";

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete an alert",
    fullDescription:
      "Permanently delete a native organization alert, including a detached alert. Requires an explicit organization and confirmation by typing org/id, or --yes/--force. Connected monitors are not deleted. Use --dry-run to preview.",
    examples: [
      {
        description: "Preview deleting an alert",
        command: "sentry alert delete my-org/123 --dry-run",
      },
      {
        description: "Delete by exact name",
        command: 'sentry alert delete "my-org/Latency notifications" --yes',
      },
    ],
  },
  output: { human: formatAlertDelete, schema: AlertDeleteOutputSchema },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [alertParameter("sentry alert delete <org>/<id-or-name>")],
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly yes: boolean;
      readonly force: boolean;
      readonly "dry-run": boolean;
    },
    arg: AlertArgument,
  ) {
    const { org, ref } = await arg.resolved;
    const alert = await resolveAlert(org, ref);
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org,
        id: alert.id,
        name: alert.name,
        dryRun: true,
      } satisfies AlertDeleteOutput);
      return;
    }
    const key = `${org}/${alert.id}`;
    if (
      !isConfirmationBypassed(flags) &&
      !(await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this alert:`,
      ))
    ) {
      logger.info("Delete cancelled.");
      return;
    }
    await deleteAlert(org, alert.id);
    yield new CommandOutput({
      org,
      id: alert.id,
      name: alert.name,
      deleted: true,
    } satisfies AlertDeleteOutput);
  },
});
