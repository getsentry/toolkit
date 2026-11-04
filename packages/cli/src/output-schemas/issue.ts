/**
 * Output schemas of the `sentry issue` commands.
 */

import {
  vGetOrganizationIssueResponse,
  vGetOrganizationIssueTagResponse,
} from "@sentry/api/valibot";
import {
  array,
  boolean,
  description,
  looseObject,
  nullable,
  number,
  object,
  optional,
  partial,
  pick,
  pipe,
  string,
  unknown,
} from "valibot";
import type { SentryEvent } from "../types/index.js";
import { opaque } from "./output.js";

/**
 * Valibot schema describing the key fields of a {@link SentryIssue} for JSON output.
 *
 * This is a documentation-oriented schema — it describes the commonly-available
 * fields that appear in `--json` output, used by the help system and SKILL.md
 * generation to inform agents and users about available `--fields` selections.
 *
 * Not a validation schema — the actual API response may include additional
 * SDK-derived fields not listed here. Fields listed as optional may still be
 * present in most responses; optionality reflects the TypeScript type.
 */
/**
 * Derived from the auto-generated `vGetOrganizationIssueResponse` schema.
 *
 * The generated schema makes all API-documented fields required. We widen it
 * with `.partial()` so only the core identifiers (id, shortId, title) are
 * required — matching how the CLI uses partial API responses and test mocks.
 * Extra fields not in the OpenAPI spec (substatus, priority, isUnhandled,
 * seerFixabilityScore) are added via `.extend()`.
 */
export const SentryIssueSchema = pipe(
  looseObject({
    ...partial(
      pick(vGetOrganizationIssueResponse, [
        "id",
        "shortId",
        "title",
        "culprit",
        "count",
        "userCount",
        "firstSeen",
        "lastSeen",
        "level",
        "status",
        "permalink",
        "project",
        "metadata",
        "assignedTo",
      ]),
    ).entries,
    id: pipe(string(), description("Numeric issue ID")),
    shortId: pipe(
      string(),
      description("Human-readable short ID (e.g. PROJ-ABC)"),
    ),
    title: pipe(string(), description("Issue title")),
    priority: optional(pipe(string(), description("Triage priority"))),
    platform: optional(pipe(string(), description("Platform"))),
    substatus: optional(
      pipe(nullable(string()), description("Issue substatus")),
    ),
    isUnhandled: optional(
      pipe(boolean(), description("Whether the issue is unhandled")),
    ),
    seerFixabilityScore: optional(
      pipe(nullable(number()), description("Seer AI fixability score (0-1)")),
    ),
  }),
  description("Sentry issue"),
);

/**
 * Fields `issue view` adds to the issue in its JSON output. The command's
 * data type (`SingleIssueViewData`) is derived from them.
 */
export const IssueViewOutputFields = object({
  event: pipe(
    nullable(opaque<SentryEvent>()),
    description(
      "Latest event for the issue (full detail). Select named fields with " +
        "`--fields event.id,event.title` to avoid pulling the whole payload; " +
        "the `request` entry may include live session data.",
    ),
  ),
  org: pipe(nullable(string()), description("Organization slug")),
  replayIds: pipe(array(string()), description("Related Session Replay IDs")),
  trace: pipe(
    nullable(
      object({
        traceId: pipe(string(), description("Trace ID from the latest event")),
        spans: pipe(array(unknown()), description("Span tree data")),
      }),
    ),
    description("Trace context from the latest event's span tree"),
  ),
});

/**
 * Documentation-oriented schema for `issue view` JSON output.
 *
 * The view command's jsonTransform spreads all issue fields at the top level
 * and adds {@link IssueViewOutputFields}. This schema describes that
 * flattened shape for `--help`, `sentry help issue view`, and SKILL.md field
 * table generation.
 */
export const IssueViewOutputSchema = pipe(
  looseObject({
    ...SentryIssueSchema.entries,
    ...IssueViewOutputFields.entries,
  }),
  description("Issue view output"),
);

/** JSON output of `issue tags`: the tag's top values across retained events. */
export const IssueTagsOutputSchema = object({
  ...vGetOrganizationIssueTagResponse.entries,
  totalValues: pipe(
    vGetOrganizationIssueTagResponse.entries.totalValues,
    description(
      "Total retained events, including missing tag values; not a lifetime count",
    ),
  ),
  topValues: pipe(
    vGetOrganizationIssueTagResponse.entries.topValues,
    description(
      "Up to 9 values ordered by count, with nullable counts and first/last seen timestamps",
    ),
  ),
});
