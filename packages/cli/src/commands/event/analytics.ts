import type { SentryContext } from "../../context.js";
import { getDroppedEvents } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  type DroppedEventRow,
  DroppedEventRowSchema,
  formatDroppedEvents,
  summarizeDroppedEvents,
} from "../../lib/formatters/dropped-events.js";
import { ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { withProgress } from "../../lib/polling.js";
import {
  resolveLogProjectId,
  resolveProjectBoundFromArg,
} from "../../lib/resolve-target.js";
import {
  PERIOD_BRIEF,
  parsePeriod,
  type TimeRange,
  timeRangeToApiParams,
} from "../../lib/time-range.js";
import type { DroppedEventsResponse } from "../../types/index.js";

const COMMAND_NAME = "event analytics";

/**
 * Dataset aliases accepted for this command: user-facing name → API dataset.
 * Mirrors the subset of `explore`'s table, so `error`/`span`/`log` singulars
 * resolve the same way. Collapse into the shared dataset module when #1559 lands.
 */
const DATASET_ALIASES: Record<string, string> = {
  errors: "errors",
  error: "errors",
  spans: "spans",
  span: "spans",
  logs: "logs",
  log: "logs",
  metrics: "tracemetrics",
};

const VALID_DATASETS = ["errors", "spans", "logs", "metrics"] as const;

export function parseDataset(value: string): string {
  const resolved = DATASET_ALIASES[value.toLowerCase()];
  if (!resolved) {
    throw new ValidationError(
      `Invalid dataset "${value}". Must be one of: ${VALID_DATASETS.join(", ")}`,
      "dataset",
    );
  }
  return resolved;
}

type AnalyticsFlags = {
  dataset: string;
  period: TimeRange;
  json?: boolean;
  fields?: string[];
};

export const analyticsCommand = buildCommand({
  docs: {
    brief: "Analytics for events Sentry dropped",
    fullDescription:
      "Aggregate analytics for events Sentry received but dropped before " +
      "storage (rate-limited, filtered, invalid, abuse, client-discarded, " +
      "cardinality-limited), one row per outcome and reason with each slice's " +
      "share of total volume.\n\n" +
      "Unlike 'event list', which returns individual stored events, this shows " +
      "only aggregate counts — dropped events have no stored detail to list.\n\n" +
      "Drops are either intentional (user-configured, e.g. sampling or inbound " +
      "filters) or unintentional (e.g. quota, abuse) — shown in the Tags column " +
      "and the JSON `tags` field.\n\n" +
      "Target the project with <org>/<project>, or omit it to detect from your " +
      "config or a local DSN.",
    examples: [
      {
        description: "Dropped-event analytics for a project",
        command: "sentry event analytics my-org/my-project",
      },
      {
        description: "Analytics for a different dataset",
        command: "sentry event analytics my-org/my-project --dataset spans",
      },
      {
        description: "Narrow the time range",
        command: "sentry event analytics my-org/my-project --period 24h",
      },
      {
        description: "Select specific JSON fields",
        command:
          "sentry event analytics my-org/my-project --json --fields outcome,reason,events",
      },
    ],
  },
  output: {
    human: formatDroppedEvents,
    schema: DroppedEventRowSchema,
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
        kind: "parsed",
        parse: parseDataset,
        brief: "Dropped-data type: errors, spans, logs, or metrics",
        default: "errors",
      },
      period: {
        kind: "parsed",
        parse: parsePeriod,
        brief: PERIOD_BRIEF,
        // The events-dropped endpoint defaults to 90d server-side; declare it
        // here so --help shows it.
        default: "90d",
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
    // can read; resolveLogProjectId is cache-first and hints on a 404.
    const projectId = await resolveLogProjectId(org, project);

    const response: DroppedEventsResponse = await withProgress(
      { message: "Fetching dropped events...", json: flags.json },
      () =>
        getDroppedEvents(org, {
          dataset: flags.dataset,
          projectId: projectId === undefined ? undefined : String(projectId),
          ...timeRangeToApiParams(flags.period),
        }),
    );

    const rows: DroppedEventRow[] = summarizeDroppedEvents(response);
    yield new CommandOutput(rows);
    if (rows.length === 0) {
      // Plain string: buildCommand's writeFooter applies plainSafeMuted, which
      // mutes on a TTY and stays plain under SENTRY_PLAIN_OUTPUT=1.
      return {
        hint: `No dropped events for ${org}/${project}.`,
      };
    }
    return undefined;
  },
});
