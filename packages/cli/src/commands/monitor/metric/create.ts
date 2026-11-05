import type { SentryContext } from "../../../context.js";
import { createMetricMonitor } from "../../../lib/api/detectors.js";
import { buildCommand } from "../../../lib/command.js";
import { ValidationError } from "../../../lib/errors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { DRY_RUN_ALIASES } from "../../../lib/mutate-command.js";
import {
  type ProjectBoundTarget,
  projectBoundTarget,
} from "../../../lib/target-positional.js";
import { MetricMonitorMutationSchema } from "../../../generated/output-schemas/monitor.js";
import type { MetricMonitorMutation } from "../../../output-schemas/monitor.js";
import { monitorFlags } from "./flags.js";
import { buildMonitorCreateBody, type MonitorFlags } from "./mutation-utils.js";

export const createCommand = buildCommand({
  docs: {
    brief: "Create a metric monitor",
    fullDescription:
      "Create a metric detector in exactly one project. Requires --name, --query (may be empty), --aggregate, --dataset and --time-window. Use --critical with optional --warning, --resolve and --comparison gt|lt for thresholds, or repeated --condition native JSON. Static detection is the default; --config accepts native percent or dynamic configuration. Connect notification alerts with --alert ID. --dry-run prints the exact native request body.",
    examples: [
      {
        description: "Create an error volume monitor",
        command:
          "sentry monitor metric create my-org/my-project --name 'Error volume' --query '' --aggregate 'count()' --dataset errors --time-window 5 --critical 100",
      },
      {
        description:
          "Preview warning and critical thresholds connected to an alert",
        command:
          "sentry monitor metric create my-org/my-project --name 'Error volume' --query '' --aggregate 'count()' --dataset errors --time-window 5 --critical 100 --warning 80 --resolve 70 --alert 123 --dry-run",
      },
    ],
  },
  output: {
    schema: MetricMonitorMutationSchema,
    human: (data: MetricMonitorMutation) =>
      data.dryRun
        ? `Would create monitor in ${data.org}/${data.project}.`
        : `Created monitor ${data.id} in ${data.org}/${data.project}: ${data.name}.`,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "Exactly one target project",
          parse: projectBoundTarget,
        },
      ],
    },
    flags: monitorFlags,
    aliases: DRY_RUN_ALIASES,
  },
  async *func(
    this: SentryContext,
    flags: MonitorFlags,
    target: ProjectBoundTarget,
  ) {
    const body = buildMonitorCreateBody(flags);
    const { org, project } = await target.resolved;
    if (!project || project.includes(",") || /[*?]/.test(project)) {
      throw new ValidationError(
        "Create requires exactly one project. Use <org>/<project>.",
        "project",
      );
    }
    if (flags["dry-run"]) {
      yield new CommandOutput({ org, project, dryRun: true, body });
      return;
    }
    const monitor = await createMetricMonitor(org, project, body);
    yield new CommandOutput({ ...monitor, org, project });
  },
});
