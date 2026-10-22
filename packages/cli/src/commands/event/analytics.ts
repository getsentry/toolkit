import type { SentryContext } from "../../context.js";
import { getDroppedEvents, getProject } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  type DroppedEventsResult,
  DroppedEventsOutputSchema,
  formatDroppedEvents,
  summarizeDroppedEvents,
} from "../../lib/formatters/dropped-events.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { withProgress } from "../../lib/polling.js";
import { resolveProjectBoundFromArg } from "../../lib/resolve-target.js";
import {
  PERIOD_BRIEF,
  parsePeriod,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import type { DroppedEventsResponse } from "../../types/index.js";

const COMMAND_NAME = "event analytics";

const DATASETS = ["errors", "spans", "logs", "metrics"] as const;

type AnalyticsFlags = {
  dataset: (typeof DATASETS)[number];
  period?: TimeRange;
  json?: boolean;
  fields?: string[];
};

export const analyticsCommand = buildCommand({
  docs: {
    brief: "Analytics for events Sentry dropped",
    fullDescription:
      "Aggregate analytics for events Sentry received but dropped before " +
      "storage (rate-limited, filtered, invalid, abuse, client-discarded, " +
      "cardinality-limited), grouped by outcome and reason with each slice's " +
      "share of total volume.\n\n" +
      "Unlike 'event list', which returns individual stored events, this shows " +
      "only aggregate counts — dropped events have no stored detail to list.\n\n" +
      "Drops are either intentional (user-configured, e.g. sampling or inbound " +
      "filters) or unintentional (e.g. quota, abuse) — shown in the Tags column " +
      "and the JSON `tags` field.\n\n" +
      "Target the project with <org>/<project>, or omit it to detect from your " +
      "config or a local DSN.\n\n" +
      "Examples:\n" +
      "  sentry event analytics my-org/my-project\n" +
      "  sentry event analytics my-org/my-project --dataset spans\n" +
      "  sentry event analytics my-org/my-project --period 24h\n" +
      "  sentry event analytics my-org/my-project --json",
  },
  output: {
    human: formatDroppedEvents,
    schema: DroppedEventsOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: "<org>/<project> (omit to auto-detect)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      dataset: {
        kind: "enum",
        values: [...DATASETS],
        brief: "Dropped-data type: errors, spans, logs, or metrics",
        default: "errors",
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        optional: true,
      },
    },
    aliases: { t: "period" },
  },
  async *func(this: SentryContext, flags: AnalyticsFlags, target?: string) {
    const { org, project } = await resolveProjectBoundFromArg(
      target,
      this.cwd,
      COMMAND_NAME,
    );

    // The events-dropped `project` param is a numeric ID. Resolve the slug so
    // the summary scopes to the project instead of every project the token
    // can read.
    const projectData = await getProject(org, project);

    const timeRange = flags.period;
    const response: DroppedEventsResponse = await withProgress(
      { message: "Fetching dropped events...", json: flags.json },
      () =>
        getDroppedEvents(org, {
          dataset: flags.dataset,
          projectId: String(projectData.id),
          ...(timeRange ? timeRangeToApiParams(timeRange) : {}),
        }),
    );

    const result: DroppedEventsResult = summarizeDroppedEvents(response);
    yield new CommandOutput(result);
    if (result.outcomes.length === 0) {
      // Plain string: buildCommand's writeFooter applies plainSafeMuted, which
      // mutes on a TTY and stays plain under SENTRY_PLAIN_OUTPUT=1.
      return {
        hint: `No dropped events for ${org}/${project}.`,
      };
    }
    return undefined;
  },
});
