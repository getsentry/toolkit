import type { SentryContext } from "../../../context.js";
import { getAlert } from "../../../lib/api/alerts.js";
import { openInBrowser } from "../../../lib/browser.js";
import { buildCommand } from "../../../lib/command.js";
import { ApiError } from "../../../lib/errors.js";
import {
  formatMetricMonitorView,
  type MetricMonitorView,
} from "../../../lib/formatters/detectors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { buildMonitorsUrl } from "../../../lib/sentry-web-urls.js";
import { MetricMonitorViewSchema } from "../../../generated/output-schemas/monitor.js";
import {
  type MonitorArgument,
  monitorParameter,
  resolveMonitor,
} from "./resolve.js";

export const viewCommand = buildCommand({
  docs: {
    brief: "View a metric monitor",
    fullDescription:
      "Inspect a native metric detector and connected alerts by ID or exact name. JSON retains dataSources, config, conditionGroup, enabled, projectId and workflowIds. Inaccessible alerts are reported in workflowErrors; this is configuration, not notification delivery history.",
    examples: [
      {
        description: "Inspect monitor configuration",
        command: "sentry monitor metric view my-org/123 --json",
      },
    ],
  },
  output: { schema: MetricMonitorViewSchema, human: formatMetricMonitorView },
  parameters: {
    positional: { kind: "tuple", parameters: [monitorParameter("view")] },
    flags: {
      web: {
        kind: "boolean",
        default: false,
        brief: "Open this monitor in the browser",
      },
    },
    aliases: { w: "web" },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly web: boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    argument: MonitorArgument,
  ) {
    const { org, monitor } = await resolveMonitor(argument, this.cwd, "view");
    if (flags.web) {
      await openInBrowser(buildMonitorsUrl(org, monitor.id), "monitor");
      return;
    }
    const data: MetricMonitorView = {
      ...monitor,
      org,
      workflows: [],
      workflowErrors: [],
    };
    for (const id of new Set(monitor.workflowIds ?? [])) {
      try {
        data.workflows.push(await getAlert(org, id));
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        )
          data.workflowErrors.push({ id, status: error.status });
        else throw error;
      }
    }
    yield new CommandOutput(data);
  },
});
