import type { SentryContext } from "../../context.js";
import { createAlert } from "../../lib/api/alerts.js";
import { buildCommand } from "../../lib/command.js";
import { parseText } from "../../lib/completion-target.js";
import { formatAlertMutation } from "../../lib/formatters/alerts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import { type OrgTarget, orgTarget } from "../../lib/target-positional.js";
import { AlertMutationOutputSchema } from "../../generated/output-schemas/alert.js";
import type { AlertMutationOutput } from "../../output-schemas/alert.js";
import {
  ALERT_MUTATION_FLAGS,
  type AlertMutationFlags,
  buildAlertCreateBody,
  resolveAlertMonitorFlags,
} from "./mutation-utils.js";

export const createCommand = buildCommand({
  docs: {
    brief: "Create an alert",
    fullDescription:
      "Create a native organization alert (workflow). Alerts may be detached or connected to any monitor with --monitor. " +
      "Use --project to select a project's issues and issue activity, or --monitor for explicit monitor IDs; do not combine them. No monitor is selected implicitly.\n\n" +
      "--trigger accepts names such as first-seen and regression, native condition JSON, or a complete native trigger group. " +
      "--action and --filter populate the first action-filter group. --action-filter accepts complete native groups, including actions, for advanced configuration. " +
      "--config sets the complete native configuration; --frequency sets config.frequency in minutes, including zero. " +
      "--enabled takes true or false. --dry-run prints the exact native request without writing.",
    examples: [
      {
        description: "Create an alert connected to a metric monitor",
        command:
          'sentry alert create my-org/ --name "Latency notifications" --monitor 123 --action \'{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}\'',
      },
      {
        description: "Create an alert for a project's new issues",
        command:
          'sentry alert create my-org/ --project my-project --name "New issues" --trigger first-seen --frequency 30 --action \'{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"7"}}\'',
      },
      {
        description: "Preview a detached alert with native configuration",
        command:
          'sentry alert create my-org/ --name "New issues" --trigger first-seen --config \'{"frequency":0}\' --dry-run',
      },
    ],
  },
  output: {
    human: (alert: AlertMutationOutput) => formatAlertMutation("create", alert),
    schema: AlertMutationOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (auto-detected if omitted)",
          parse: orgTarget,
          optional: true as const,
        },
      ],
    },
    flags: {
      ...ALERT_MUTATION_FLAGS,
      name: { kind: "parsed", parse: parseText, brief: "Alert name" },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, a: "action", t: "trigger" },
  },
  async *func(
    this: SentryContext,
    flags: AlertMutationFlags,
    target: OrgTarget,
  ) {
    const { org } = await target.resolved;
    const body = buildAlertCreateBody(
      await resolveAlertMonitorFlags(org, flags),
    );
    if (flags["dry-run"]) {
      yield new CommandOutput({
        org,
        name: body.name,
        dryRun: true,
        body,
      } satisfies AlertMutationOutput);
      return;
    }
    const created = await createAlert(org, body);
    yield new CommandOutput({ ...created, org } satisfies AlertMutationOutput);
  },
});
