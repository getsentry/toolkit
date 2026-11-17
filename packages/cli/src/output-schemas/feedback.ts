/**
 * Output schemas of the `sentry feedback` commands.
 */

import { vEventAttachmentDetailsResponse } from "@sentry/api/valibot";
import {
  array,
  boolean,
  description,
  literal,
  looseObject,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
} from "valibot";
import type { SentryEvent } from "../types/index.js";
import { SentryIssueSchema } from "./issue.js";
import { opaque } from "./output.js";

/** Documentation schema for Feedback metadata. */
export const FeedbackMetadataSchema = pipe(
  looseObject({
    message: pipe(string(), description("Feedback message")),
    contact_email: optional(
      nullable(pipe(string(), description("End-user email address"))),
    ),
    name: optional(
      nullable(pipe(string(), description("End-user display name"))),
    ),
    title: optional(pipe(string(), description("Feedback title"))),
    value: optional(pipe(string(), description("Feedback display value"))),
    initial_priority: optional(
      pipe(
        number(),
        description("Initial priority assigned when the feedback was created"),
      ),
    ),
    source: optional(
      nullable(pipe(string(), description("Feedback capture source"))),
    ),
    summary: optional(
      nullable(pipe(string(), description("AI-generated summary"))),
    ),
    sdk: optional(
      pipe(
        object({
          name: pipe(string(), description("SDK name")),
          name_normalized: optional(
            pipe(string(), description("Normalized SDK name")),
          ),
        }),
        description("SDK that captured the feedback"),
      ),
    ),
    associated_event_id: optional(
      pipe(string(), description("Associated error event ID")),
    ),
  }),
  description("Feedback metadata"),
);

/** Documentation schema for a modern Feedback issue. */
export const SentryFeedbackSchema = pipe(
  looseObject({
    ...SentryIssueSchema.entries,
    issueCategory: pipe(
      literal("feedback"),
      description("Issue category discriminator"),
    ),
    issueType: pipe(
      literal("feedback"),
      description("Issue type discriminator"),
    ),
    metadata: FeedbackMetadataSchema,
    hasSeen: optional(
      pipe(boolean(), description("Whether the feedback has been read")),
    ),
    latestEventHasAttachments: optional(
      pipe(boolean(), description("Whether the latest event has attachments")),
    ),
  }),
  description("Sentry User Feedback"),
);

/**
 * Fields `feedback view` adds to the Feedback issue in its JSON output; the
 * rest of {@link FeedbackViewResult} is derived from them.
 */
export const FeedbackViewOutputFields = object({
  /** Resolved organization slug, or null when unavailable. */
  org: pipe(nullable(string()), description("Organization slug")),
  event: pipe(
    nullable(opaque<SentryEvent>()),
    description("Latest feedback event"),
  ),
  replayIds: pipe(array(string()), description("Related Session Replay IDs")),
  attachments: pipe(
    array(vEventAttachmentDetailsResponse),
    description("Attachments on the latest feedback event"),
  ),
});

/** Documentation schema for flattened `feedback view` JSON output. */
export const FeedbackViewOutputSchema = pipe(
  looseObject({
    ...SentryFeedbackSchema.entries,
    ...FeedbackViewOutputFields.entries,
  }),
  description("Feedback view output"),
);
