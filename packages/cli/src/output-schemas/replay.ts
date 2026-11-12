/**
 * Output schemas of the `sentry replay` commands.
 */

import {
  array,
  description,
  nullable,
  nullish,
  number,
  object,
  optional,
  pipe,
  record,
  string,
} from "valibot";
import {
  buildReplayListItemShape,
  ReplayClickSchema,
  ReplayOtaUpdatesSchema,
  replayStringArray,
} from "../types/replay.js";

/**
 * Documentation-oriented replay list schema used for `--help` and SKILL docs.
 *
 * Keeps the field types explicit even though the runtime parser accepts a few
 * legacy/nullish payload variants from archived replay rows.
 */
const ReplayListItemOutputSchemaBase = object(
  buildReplayListItemShape({
    errorIds: replayStringArray(),
    infoIds: replayStringArray(),
    otaUpdates: nullish(ReplayOtaUpdatesSchema),
    projectId: optional(nullable(string())),
    releases: replayStringArray(),
    tags: record(string(), array(string())),
    traceIds: replayStringArray(),
    urls: replayStringArray(),
    warningIds: replayStringArray(),
  }),
);
export const ReplayListItemOutputSchema = pipe(
  ReplayListItemOutputSchemaBase,
  description("Replay list row"),
);

/** Documentation-oriented replay detail schema used for command metadata. */
export const ReplayDetailsOutputSchema = pipe(
  object({
    ...ReplayListItemOutputSchemaBase.entries,
    clicks: pipe(
      optional(array(ReplayClickSchema)),
      description("Replay click summaries"),
    ),
    replay_type: pipe(optional(nullable(string())), description("Replay type")),
  }),
  description("Replay details"),
);

/** A summarized replay activity event extracted from recording segments. */
export const ReplayActivityEventSchema = pipe(
  object({
    timestampMs: pipe(
      nullable(number()),
      description("Milliseconds since UNIX epoch for the activity event"),
    ),
    label: pipe(string(), description("Activity label")),
    details: pipe(
      array(string()),
      description("Supplemental activity details"),
    ),
  }),
  description("Summarized replay activity event"),
);

/** Related issue metadata extracted from replay-linked event IDs. */
export const ReplayRelatedIssueSchema = pipe(
  object({
    eventId: pipe(string(), description("Replay-linked event ID")),
    issueId: pipe(
      optional(nullable(string())),
      description("Resolved issue ID"),
    ),
    shortId: pipe(
      optional(nullable(string())),
      description("Resolved issue short ID"),
    ),
    title: pipe(
      optional(nullable(string())),
      description("Resolved issue title"),
    ),
  }),
  description("Replay-related issue"),
);

/** Related trace metadata extracted from replay trace IDs. */
export const ReplayRelatedTraceSchema = pipe(
  object({
    traceId: pipe(string(), description("Replay-linked trace ID")),
    errorCount: pipe(
      optional(nullable(number())),
      description("Trace error count"),
    ),
    logCount: pipe(
      optional(nullable(number())),
      description("Trace log count"),
    ),
    performanceIssueCount: pipe(
      optional(nullable(number())),
      description("Trace performance issue count"),
    ),
    spanCount: pipe(
      optional(nullable(number())),
      description("Trace span count"),
    ),
  }),
  description("Replay-related trace"),
);

/**
 * Fields `replay view` adds to the replay in its JSON output. The command's
 * data type (`ReplayViewData`) is derived from them.
 */
export const ReplayViewOutputFields = object({
  org: pipe(string(), description("Organization slug")),
  activity: pipe(
    array(ReplayActivityEventSchema),
    description("Summarized replay activity"),
  ),
  relatedIssues: pipe(
    array(ReplayRelatedIssueSchema),
    description("Replay-related issues"),
  ),
  relatedTraces: pipe(
    array(ReplayRelatedTraceSchema),
    description("Replay-related traces"),
  ),
});

/** Replay view output with related context and summarized activity. */
export const ReplayViewOutputSchema = pipe(
  object({
    ...ReplayDetailsOutputSchema.entries,
    ...ReplayViewOutputFields.entries,
  }),
  description("Replay view output"),
);
