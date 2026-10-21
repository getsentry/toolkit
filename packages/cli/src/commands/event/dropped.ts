/**
 * sentry event dropped
 *
 * Summarize events Sentry received but dropped (rate-limited, filtered,
 * invalid, abuse, client-discarded, cardinality-limited), grouped by outcome
 * and reason. Hits `GET /organizations/{org}/events-dropped/`; the accepted
 * volume comes back too so each slice's share of total volume is shown.
 *
 * `--json` and `--fields` are injected automatically by the output config, so
 * the same sectioned data serializes for agents and automation without a
 * separate code path. Each reason carries its drop classification tag
 * (intentional vs unintentional).
 */

import type { SentryContext } from "../../context.js";
import { getDroppedEvents, getProject } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { muted } from "../../lib/formatters/colors.js";
import {
  type DroppedEventsResult,
  DroppedEventsOutputSchema,
  formatDroppedEvents,
  outcomeLabel,
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

const COMMAND_NAME = "dropped";
const USAGE_HINT = "sentry event dropped <org>/<project>";

/** Dropped-data types accepted by the events-dropped endpoint. */
const DATASETS = ["errors", "spans", "logs", "metrics"] as const;

type DroppedFlags = {
  dataset: (typeof DATASETS)[number];
  period?: TimeRange;
  json?: boolean;
  fields?: string[];
};

export const droppedCommand = buildCommand({
  docs: {
    brief: "Summarize events Sentry dropped",
    fullDescription:
      "Summarize events Sentry received but dropped before storage, grouped by " +
      "outcome and reason, with each slice's share of total volume.\n\n" +
      "Drops are either intentional (user-configured, e.g. sampling or inbound " +
      "filters) or unintentional (e.g. quota, abuse) — shown in the Tags column " +
      "and the JSON `tags` field.\n\n" +
      "Target the project with <org>/<project>, or omit it to detect from your " +
      "config or a local DSN.\n\n" +
      "Examples:\n" +
      "  sentry event dropped my-org/my-project\n" +
      "  sentry event dropped my-org/my-project --dataset spans\n" +
      "  sentry event dropped my-org/my-project --period 24h\n" +
      "  sentry event dropped my-org/my-project --json",
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
  async *func(this: SentryContext, flags: DroppedFlags, target?: string) {
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
      return {
        hint: muted(`No dropped events for ${org}/${project}.`),
      };
    }
    return undefined;
  },
});

// Re-exported so the route and tests share the single source of truth.
export { outcomeLabel, USAGE_HINT };
