import type { SentryContext } from "../../context.js";
import { deleteMetricMonitor } from "../../lib/api/detectors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
  requireExplicitTarget,
} from "../../lib/mutate-command.js";
import { MetricMonitorDeleteSchema } from "../../generated/output-schemas/monitor.js";
import type { MetricMonitorDelete } from "../../output-schemas/monitor.js";
import {
  type MonitorArgument,
  monitorParameter,
  resolveMonitor,
} from "./resolve.js";

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete a metric monitor",
    fullDescription:
      "Permanently delete a metric detector. Requires an explicit organization. Type org/id to confirm, or pass --yes / --force. --dry-run previews without deleting.",
    examples: [
      {
        description: "Delete a monitor without prompting",
        command: "sentry monitor delete my-org/123 --yes",
      },
    ],
  },
  output: {
    schema: MetricMonitorDeleteSchema,
    human: (data: MetricMonitorDelete) =>
      `${data.dryRun ? "Would delete" : "Deleted"} monitor '${data.name}' (${data.org}/${data.id}).`,
  },
  parameters: {
    positional: { kind: "tuple", parameters: [monitorParameter("delete")] },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly yes: boolean;
      readonly force: boolean;
      readonly "dry-run": boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    argument: MonitorArgument,
  ) {
    const { target } = await argument.resolved;
    requireExplicitTarget(
      target,
      "Monitor target",
      "sentry monitor delete <org>/<monitor-id-or-name>",
    );
    const { org, monitor } = await resolveMonitor(argument, this.cwd, "delete");
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org,
        id: monitor.id,
        name: monitor.name,
        dryRun: true,
      });
      return;
    }
    const key = `${org}/${monitor.id}`;
    if (
      !isConfirmationBypassed(flags) &&
      !(await confirmByTyping(
        key,
        `Type '${key}' to permanently delete this monitor:`,
      ))
    ) {
      logger.info("Delete cancelled.");
      return;
    }
    await deleteMetricMonitor(org, monitor.id);
    yield new CommandOutput({
      org,
      id: monitor.id,
      name: monitor.name,
      deleted: true,
    });
  },
});
