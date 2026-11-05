/**
 * Output schemas of the `sentry event` commands, and of `sentry issue events`.
 */

import {
  vEventAttachmentDetailsResponse,
  vGroupEventsResponseDict,
  vIssueEventDetailsResponse,
  vListOrganizationEventsDroppedResponse,
} from "@sentry/api/valibot";
import {
  array,
  description,
  type InferOutput,
  looseObject,
  nullable,
  number,
  object,
  optional,
  partial,
  pipe,
  string,
  unknown,
  url,
} from "valibot";

/** Fields `event view` adds to each attachment of the event. */
export const EventViewAttachmentFields = object({
  download: pipe(
    string(),
    url(),
    description("Absolute authenticated API URL for the attachment bytes"),
  ),
});

const EventViewAttachmentSchema = looseObject({
  ...vEventAttachmentDetailsResponse.entries,
  ...EventViewAttachmentFields.entries,
});

/**
 * Fields `event view` adds to the event in its JSON output. The command's
 * data type (`SingleEventViewData`) is derived from them.
 */
export const EventViewOutputFields = object({
  trace: pipe(
    nullable(
      object({
        traceId: pipe(string(), description("Trace ID")),
        spans: pipe(array(unknown()), description("Span tree data")),
      }),
    ),
    description("Trace context, or null when unavailable"),
  ),
  attachments: pipe(
    array(EventViewAttachmentSchema),
    description(
      "Event attachments; each includes metadata and an absolute authenticated download URL",
    ),
  ),
});

/**
 * Documentation schema for the flattened `event view` JSON output.
 *
 * Event API fields remain optional because responses vary by event type. The
 * CLI always adds {@link EventViewOutputFields}; multi-event output is an
 * array of this shape.
 */
export const EventViewOutputSchema = pipe(
  looseObject({
    ...partial(vIssueEventDetailsResponse).entries,
    eventID: pipe(string(), description("UUID-format event ID")),
    ...EventViewOutputFields.entries,
  }),
  description("Event view output"),
);

/**
 * Valibot schema for {@link IssueEvent} — used for `--fields` documentation in `--help`.
 *
 * Derived from the auto-generated `vGroupEventsResponseDict` element schema.
 * All generated fields are widened to optional via `.partial()`, then the core
 * identifiers (id, event.type, eventID) are re-required via `.extend()`.
 */
const _IssueEventElement = vGroupEventsResponseDict.item;
export const IssueEventSchema = pipe(
  looseObject({
    ...partial(_IssueEventElement).entries,
    id: pipe(string(), description("Internal event ID")),
    "event.type": pipe(
      string(),
      description("Event type (error, default, transaction)"),
    ),
    groupID: optional(
      pipe(_IssueEventElement.entries.groupID, description("Group (issue) ID")),
    ),
    eventID: pipe(string(), description("UUID-format event ID")),
    projectID: optional(
      pipe(_IssueEventElement.entries.projectID, description("Project ID")),
    ),
    message: optional(
      pipe(_IssueEventElement.entries.message, description("Event message")),
    ),
    title: optional(
      pipe(_IssueEventElement.entries.title, description("Event title")),
    ),
    location: optional(
      pipe(
        _IssueEventElement.entries.location,
        description("Source location (file:line)"),
      ),
    ),
    culprit: optional(
      pipe(
        _IssueEventElement.entries.culprit,
        description("Culprit function/module"),
      ),
    ),
    user: optional(
      pipe(_IssueEventElement.entries.user, description("User context")),
    ),
    tags: optional(
      pipe(_IssueEventElement.entries.tags, description("Event tags")),
    ),
    platform: optional(
      pipe(
        _IssueEventElement.entries.platform,
        description("Platform (python, javascript, etc.)"),
      ),
    ),
    dateCreated: optional(
      pipe(
        _IssueEventElement.entries.dateCreated,
        description("ISO 8601 creation timestamp"),
      ),
    ),
    crashFile: optional(
      pipe(_IssueEventElement.entries.crashFile, description("Crash file URL")),
    ),
    metadata: optional(
      pipe(_IssueEventElement.entries.metadata, description("Event metadata")),
    ),
  }),
  description("Issue event (list endpoint)"),
);

const _DroppedEventsBucket =
  vListOrganizationEventsDroppedResponse.entries.droppedEvents.item.entries;

/**
 * One (outcome, reason) slice of event volume in `event analytics`: the
 * accepted total or one kind of drop. One JSON row each.
 */
export const EventOutcomeRowSchema = pipe(
  object({
    outcome: pipe(
      _DroppedEventsBucket.outcome,
      description(
        "Outcome code: accepted, or a drop such as rate_limited or filtered",
      ),
    ),
    label: pipe(string(), description("Human-readable outcome label")),
    reason: pipe(
      _DroppedEventsBucket.reason,
      description(
        "Reason within the outcome (e.g. spike_protection); accepted for accepted volume",
      ),
    ),
    category: pipe(
      _DroppedEventsBucket.category,
      description("Data category (e.g. error, span)"),
    ),
    events: pipe(number(), description("Events in this slice")),
    share: pipe(
      number(),
      description("Fraction of total volume (0-1), not a percentage string"),
    ),
    tags: pipe(
      _DroppedEventsBucket.tags,
      description(
        "Drop classification: intentional or unintentional; empty for accepted",
      ),
    ),
  }),
  description("An event-outcome row: one outcome/reason slice"),
);

export type EventOutcomeRow = InferOutput<typeof EventOutcomeRowSchema>;
