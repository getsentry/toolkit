/**
 * sentry status show
 *
 * Report the current status of Sentry's services by querying the public
 * Statuspage backend at https://status.sentry.io. Useful when the Sentry API
 * is degraded and you want to know whether the problem is on Sentry's side.
 */

import type { SentryContext } from "../../context.js";
import {
  fetchSentryStatus,
  SENTRY_STATUS_PAGE_URL,
} from "../../lib/api/status-page.js";
import { buildCommand } from "../../lib/command.js";
import { formatSentryStatus } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";

type ShowFlags = {
  readonly json: boolean;
  readonly url: string;
  readonly fields?: string[];
};

export const showCommand = buildCommand({
  // Checking the public status page requires no Sentry credentials.
  auth: false,
  docs: {
    brief: "Show Sentry service status",
    fullDescription:
      "Report the current status of Sentry's services using the public " +
      "status page (https://status.sentry.io) as the backend.\n\n" +
      "This works even when the Sentry API is degraded or unreachable, so " +
      "you can tell whether an issue is on Sentry's side. Point `--url` at a " +
      "different Statuspage instance to check a self-hosted or regional page.",
  },
  output: { human: formatSentryStatus },
  parameters: {
    flags: {
      url: {
        kind: "parsed",
        parse: String,
        brief: "Status page base URL to query",
        default: SENTRY_STATUS_PAGE_URL,
      },
    },
  },
  async *func(this: SentryContext, flags: ShowFlags) {
    const status = await fetchSentryStatus(flags.url);
    yield new CommandOutput(status);

    if (status.indicator !== "none") {
      return {
        hint: `Run \`sentry status\` again to refresh, or open ${status.url}`,
      };
    }
  },
});
