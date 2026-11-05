import type { SentryContext } from "../../context.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { formatAlertView } from "../../lib/formatters/alerts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildAlertsUrl } from "../../lib/sentry-web-urls.js";
import { AlertViewOutputSchema } from "../../generated/output-schemas/alert.js";
import type { AlertViewOutput } from "../../output-schemas/alert.js";
import {
  type AlertArgument,
  alertParameter,
  resolveAlert,
} from "./arguments.js";

export const viewCommand = buildCommand({
  docs: {
    brief: "View an alert",
    fullDescription:
      "View a native organization alert, including config, triggers, action filters, actions, and connected monitor IDs. Select by ID, exact name, or alert URL. Detached alerts are supported.",
    examples: [
      { description: "View an alert", command: "sentry alert view my-org/123" },
      {
        description: "View by name",
        command: 'sentry alert view "my-org/Latency notifications"',
      },
    ],
  },
  output: { human: formatAlertView, schema: AlertViewOutputSchema },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [alertParameter("sentry alert view <org>/<id-or-name>")],
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open the alert in a browser",
        default: false,
      },
    },
    aliases: { w: "web" },
  },
  async *func(
    this: SentryContext,
    flags: { readonly web: boolean },
    arg: AlertArgument,
  ) {
    const { org, ref } = await arg.resolved;
    const alert = await resolveAlert(org, ref);
    if (flags.web) {
      await openInBrowser(buildAlertsUrl(org, alert.id), "alert");
      return;
    }
    yield new CommandOutput({ ...alert, org } satisfies AlertViewOutput);
  },
});
