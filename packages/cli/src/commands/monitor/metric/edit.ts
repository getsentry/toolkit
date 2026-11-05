import type { SentryContext } from "../../../context.js";
import { updateMetricMonitor } from "../../../lib/api/detectors.js";
import { buildCommand } from "../../../lib/command.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { DRY_RUN_ALIASES } from "../../../lib/mutate-command.js";
import { MetricMonitorMutationSchema } from "../../../generated/output-schemas/monitor.js";
import type { MetricMonitorMutation } from "../../../output-schemas/monitor.js";
import { monitorFlags } from "./flags.js";
import { buildMonitorBody, type MonitorFlags } from "./mutation-utils.js";
import {
  type MonitorArgument,
  monitorParameter,
  resolveMonitor,
} from "./resolve.js";

export const editCommand = buildCommand({
  docs: {
    brief: "Edit a metric monitor",
    fullDescription:
      "Update native metric detector fields. Omitted fields are preserved, including detection mode, source signal, environment and conditions. Repeated --condition replaces all conditions; --alert replaces connected workflowIds. --config merges native config fields. --dry-run prints the exact native partial PUT body.",
    examples: [
      {
        description: "Disable a monitor",
        command: "sentry monitor metric edit my-org/123 --enabled false",
      },
    ],
  },
  output: {
    schema: MetricMonitorMutationSchema,
    human: (data: MetricMonitorMutation) =>
      data.dryRun
        ? `Would update monitor ${data.id} in ${data.org}:\n${JSON.stringify(data.body, null, 2)}`
        : `Updated monitor ${data.id} in ${data.org}: ${data.name}.`,
  },
  parameters: {
    positional: { kind: "tuple", parameters: [monitorParameter("edit")] },
    flags: monitorFlags,
    aliases: DRY_RUN_ALIASES,
  },
  async *func(
    this: SentryContext,
    flags: MonitorFlags,
    argument: MonitorArgument,
  ) {
    const { org, monitor: current } = await resolveMonitor(
      argument,
      this.cwd,
      "edit",
    );
    const body = buildMonitorBody(flags, current);
    if (flags["dry-run"]) {
      yield new CommandOutput({ org, id: current.id, dryRun: true, body });
      return;
    }
    const monitor = await updateMetricMonitor(org, current.id, body);
    yield new CommandOutput({ ...monitor, org });
  },
});
