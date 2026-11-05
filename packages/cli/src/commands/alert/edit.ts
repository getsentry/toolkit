import type { SentryContext } from "../../context.js";
import { updateAlert } from "../../lib/api/alerts.js";
import { buildCommand } from "../../lib/command.js";
import { formatAlertMutation } from "../../lib/formatters/alerts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import { AlertMutationOutputSchema } from "../../generated/output-schemas/alert.js";
import type { AlertMutationOutput } from "../../output-schemas/alert.js";
import {
  type AlertArgument,
  alertParameter,
  resolveAlert,
} from "./arguments.js";
import {
  ALERT_MUTATION_FLAGS,
  type AlertMutationFlags,
  buildAlertUpdateBody,
} from "./mutation-utils.js";

export const editCommand = buildCommand({
  docs: {
    brief: "Edit an alert",
    fullDescription:
      "Edit an organization alert by ID or exact name. Names are resolved across every page; ambiguous names require an ID. " +
      "Unchanged configuration, trigger groups, action-filter groups, monitor links, and enabled state are preserved. " +
      "--action, --filter, and --filter-match modify only the first action-filter group, retaining all others. " +
      "--trigger replaces trigger conditions, or accepts a complete native trigger group. " +
      "--action-filter replaces all action-filter groups; --config replaces config. --frequency changes only config.frequency. " +
      "--monitor replaces monitor links (an empty string disconnects all monitors). --enabled takes true or false. " +
      "--dry-run prints the exact PUT body without writing.",
    examples: [
      {
        description: "Rename a disabled alert without re-enabling it",
        command: 'sentry alert edit my-org/123 --name "Production latency"',
      },
      {
        description: "Connect an alert to two monitors",
        command: "sentry alert edit my-org/123 --monitor 456,789",
      },
      {
        description: "Preview disabling an alert selected by name",
        command: 'sentry alert edit "my-org/Latency" --enabled false --dry-run',
      },
    ],
  },
  output: {
    human: (alert: AlertMutationOutput) => formatAlertMutation("edit", alert),
    schema: AlertMutationOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [alertParameter("sentry alert edit <org>/<id-or-name>")],
    },
    flags: { ...ALERT_MUTATION_FLAGS, "dry-run": DRY_RUN_FLAG },
    aliases: { ...DRY_RUN_ALIASES, a: "action", t: "trigger" },
  },
  async *func(
    this: SentryContext,
    flags: AlertMutationFlags,
    arg: AlertArgument,
  ) {
    const { org, ref } = await arg.resolved;
    const current = await resolveAlert(org, ref);
    const body = buildAlertUpdateBody(flags, current);
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org,
        id: current.id,
        name: body.name,
        dryRun: true,
        body,
      } satisfies AlertMutationOutput);
      return;
    }
    const updated = await updateAlert(org, current.id, body);
    yield new CommandOutput({ ...updated, org } satisfies AlertMutationOutput);
  },
});
