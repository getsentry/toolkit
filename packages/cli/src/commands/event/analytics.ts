import type { SentryContext } from "../../context.js";
import { getDroppedEvents } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { choiceParser } from "../../lib/completion-target.js";
import { buildDatasetParser } from "../../lib/datasets.js";
import {
  LIST_PERIOD_FLAG,
  PERIOD_ALIASES,
  PROJECT_TARGET_BRIEF,
} from "../../lib/list-command.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  ACCEPTED_OUTCOME,
  type EventOutcomeRow,
  formatEventOutcomes,
  summarizeEventOutcomes,
} from "../../lib/formatters/event-outcomes.js";
import { EventOutcomeRowSchema } from "../../generated/output-schemas/event.js";
import { withProgress } from "../../lib/polling.js";
import { fetchProjectId } from "../../lib/resolve-target.js";
import {
  type ProjectBoundTarget,
  projectBoundTarget,
} from "../../lib/target-positional.js";
import { type TimeRange, timeRangeToApiParams } from "../../lib/time-range.js";

const { parse: parseDataset, names: DATASET_NAMES } = buildDatasetParser([
  "errors",
  "spans",
  "logs",
  "tracemetrics",
]);

type AnalyticsFlags = {
  dataset: ReturnType<typeof parseDataset>;
  period: TimeRange;
  json?: boolean;
  fields?: string[];
};

export const analyticsCommand = buildCommand({
  docs: {
    brief: "Analytics for events Sentry accepted and dropped",
    fullDescription:
      "Aggregate analytics for events Sentry received: the accepted volume, " +
      "then the events dropped before storage (rate-limited, filtered, " +
      "invalid, abuse, client-discarded, cardinality-limited), one row per " +
      "outcome and reason with each slice's share of total volume.\n\n" +
      "Unlike 'event list', which returns individual stored events, this shows " +
      "only aggregate counts — dropped events have no stored detail to list.\n\n" +
      "Drops are either intentional (user-configured, e.g. sampling or inbound " +
      "filters) or unintentional (e.g. quota, abuse) — shown in the Tags column " +
      "and the JSON `tags` field.\n\n" +
      "Target the project with <org>/<project>, or omit it to detect from your " +
      "config or a local DSN.",
    examples: [
      {
        description: "Accepted and dropped event analytics for a project",
        run: "event analytics my-org/my-project",
      },
      {
        description: "Analytics for a different dataset",
        run: "event analytics my-org/my-project --dataset spans",
      },
      {
        description: "Widen the time range",
        run: "event analytics my-org/my-project --period 7d",
      },
      {
        description: "Select specific JSON fields",
        run: "event analytics my-org/my-project --json --fields outcome,reason,events",
      },
    ],
  },
  output: {
    human: formatEventOutcomes,
    schema: EventOutcomeRowSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/project",
          brief: PROJECT_TARGET_BRIEF,
          parse: projectBoundTarget,
          optional: true,
        },
      ],
    },
    flags: {
      dataset: {
        kind: "parsed",
        parse: choiceParser(DATASET_NAMES, parseDataset),
        brief: `Dropped-data type: ${DATASET_NAMES.join(", ")}`,
        default: "errors",
      },
      period: LIST_PERIOD_FLAG,
    },
    aliases: { ...PERIOD_ALIASES, d: "dataset" },
  },
  async *func(
    this: SentryContext,
    flags: AnalyticsFlags,
    target: ProjectBoundTarget,
  ) {
    const { org, project } = await target.resolved;

    // The events-dropped `project` param takes a numeric ID, and the command
    // sends no query — a missing ID would widen the request to every project.
    // strict resolution errors on a bad lookup instead of silently doing that.
    const projectId = await fetchProjectId(org, project, { strict: true });

    const response = await withProgress(
      { message: "Fetching event analytics...", json: flags.json },
      () =>
        getDroppedEvents(org, {
          dataset: flags.dataset,
          projectId: projectId === undefined ? undefined : String(projectId),
          ...timeRangeToApiParams(flags.period),
        }),
    );

    const rows: EventOutcomeRow[] = summarizeEventOutcomes(response);
    yield new CommandOutput(rows);
    if (rows.every((row) => row.outcome === ACCEPTED_OUTCOME)) {
      return { hint: `No dropped events for ${org}/${project}.` };
    }
    return undefined;
  },
});
