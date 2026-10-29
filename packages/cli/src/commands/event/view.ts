/**
 * sentry event view
 *
 * View detailed information about a Sentry event.
 */

import pLimit from "p-limit";
import type { SentryContext } from "../../context.js";
import {
  findEventAcrossOrgs,
  getEvent,
  getIssueByShortId,
  getIssueInOrg,
  getLatestEvent,
  ISSUE_DETAIL_COLLAPSE,
  ORG_FANOUT_CONCURRENCY,
  type ResolvedEvent,
  resolveEventInOrg,
} from "../../lib/api-client.js";
import {
  type ParsedOrgProject,
  ProjectSpecificationType,
  parseOrgProjectInput,
  spansFlag,
  splitNewlineArg,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ORG_PROJECT_TARGET } from "../../lib/completion-target.js";
import {
  ApiError,
  AuthError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import {
  attachmentDownloadHint,
  type EventViewAttachment,
  eventProjectSlug,
  formatEventAttachments,
  loadEventAttachments,
} from "../../lib/event-attachments.js";
import { formatEventDetails } from "../../lib/formatters/index.js";
import { filterFields } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { validateHexId } from "../../lib/hex-id.js";
import {
  handleRecoveryResult,
  recoverHexId,
  resolveRecoveryOrg,
} from "../../lib/hex-id-recovery.js";
import { ID_KINDS, parseIdArguments } from "../../lib/id-arguments.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { resolveEffectiveOrg } from "../../lib/region.js";
import { getReplayIdFromEvent } from "../../lib/replay-search.js";
import {
  resolveOrg,
  resolveOrgAndProject,
  resolveProjectBoundSlug,
} from "../../lib/resolve-target.js";
import {
  applySentryUrlContext,
  type ParsedSentryUrl,
  parseSentryUrl,
} from "../../lib/sentry-url-parser.js";
import { buildEventSearchUrl } from "../../lib/sentry-web-urls.js";
import { getSpanTreeLines } from "../../lib/span-tree.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import { EventViewOutputSchema, type SentryEvent } from "../../types/index.js";

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly spans: number;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/** Return type for a single event — includes all data both renderers need */
type SingleEventViewData = {
  event: SentryEvent;
  trace: { traceId: string; spans: unknown[] } | null;
  /** Pre-formatted span tree lines for human output (not serialized) */
  spanTreeLines?: string[];
  /** Attachment metadata; omitted from human output when empty */
  attachments?: EventViewAttachment[];
  /** Resolved organization, including cross-org fallback results */
  org?: string;
};

/**
 * Output type for event view — supports both single and multi-event.
 * Multi-event output occurs when agents paste newline-separated IDs.
 */
type EventViewData = {
  events: SingleEventViewData[];
  /** Number of events originally requested (before partial failures) */
  requestedCount: number;
};

/**
 * Format event view data for human-readable terminal output.
 *
 * Renders event details and optional span tree. Multiple events
 * are separated by horizontal rules.
 */
export function formatEventView(data: EventViewData): string {
  const parts: string[] = [];

  for (const entry of data.events) {
    if (parts.length > 0) {
      parts.push("\n---\n");
    }

    parts.push(formatEventDetails(entry.event, `Event ${entry.event.eventID}`));

    if (entry.spanTreeLines && entry.spanTreeLines.length > 0) {
      parts.push(entry.spanTreeLines.join("\n"));
    }

    const attachments = formatEventAttachments(entry.attachments ?? []);
    if (attachments) {
      parts.push(attachments);
    }
  }

  return parts.join("\n");
}

/**
 * Transform event view data for JSON output.
 *
 * For single-event output, flattens the event as the primary object so that
 * `--fields eventID,title` works directly on event properties. The `trace`
 * enrichment data is attached as a nested key. Attachment metadata is always
 * present as `attachments` (empty array when none), with a `download` URL for
 * each listed attachment.
 *
 * For multi-event output, returns an array of flattened event objects.
 * This preserves backward compatibility: single-event callers still get
 * a flat object, while multi-event callers get an array.
 */
export function jsonTransformEventView(
  data: EventViewData,
  fields?: string[],
): unknown {
  const transform = (entry: SingleEventViewData): Record<string, unknown> => {
    const result: Record<string, unknown> = {
      ...entry.event,
      trace: entry.trace,
      attachments: entry.attachments ?? [],
    };
    if (fields && fields.length > 0) {
      return filterFields(result, fields) as Record<string, unknown>;
    }
    return result;
  };

  // Use requestedCount (not events.length) to decide the shape so that
  // partial failures don't non-deterministically switch from array to object.
  if (data.requestedCount <= 1) {
    const [first] = data.events;
    if (first) {
      return transform(first);
    }
  }
  return data.events.map(transform);
}

/**
 * Build a CLI-native replay hint when the event is linked to a replay.
 */
function replayHint(org: string, event: SentryEvent): string | undefined {
  const replayId = getReplayIdFromEvent(event);
  return replayId
    ? `Related replay: sentry replay view ${org}/${replayId}`
    : undefined;
}

function joinHintParts(parts: Array<string | undefined>): string | undefined {
  const hints = parts.filter((part): part is string => Boolean(part));
  return hints.length > 0 ? hints.join(" | ") : undefined;
}

function viewOutputHint(
  org: string,
  data: SingleEventViewData | undefined,
  extra?: string,
): string | undefined {
  if (!data) {
    return extra;
  }
  return joinHintParts([
    extra,
    replayHint(org, data.event),
    attachmentDownloadHint(data.attachments ?? []),
  ]);
}

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry event view <org>/<project> <event-id>";

/**
 * Expand positional args by splitting each on newlines.
 *
 * When an agent pastes `"org/project/id1\nid2\nid3"` as a single arg,
 * this produces `["org/project/id1", "id2", "id3"]` — the first retains
 * the org/project prefix so the target is still found (CLI-1HT).
 */
export function expandNewlineArgs(args: readonly string[]): string[] {
  return args.flatMap(splitNewlineArg);
}

/**
 * Sentinel eventId for "fetch the latest event for this issue."
 * Uses the @-prefix convention from {@link IssueSelector} magic selectors.
 */
const LATEST_EVENT_SENTINEL = "@latest";

/**
 * Shared usage hint shown when a bare "latest" is passed without an issue.
 * There is no "latest event of a project" API — the latest-event lookup is
 * keyed by issue, so the user must supply an issue ID (or short ID).
 */
const BARE_LATEST_HINT = "sentry event view <issue-id>";

/**
 * The arguments of `event view`, parsed. Parsing has no side effects: the
 * server of a pasted URL and the warnings are applied when they resolve.
 */
type EventViewInput = {
  /**
   * The event ID, as typed (validated when it resolves), or
   * {@link LATEST_EVENT_SENTINEL} for an issue's latest event
   */
  eventId: string;
  /** The org/project target argument; `undefined` to auto-detect */
  targetArg: string | undefined;
  /** `targetArg`, parsed */
  target: ParsedOrgProject;
  /** Numeric issue ID, from an issue URL or argument: its latest event */
  issueId?: string;
  /** Issue short ID (e.g. `BRUNCHIE-APP-29`) the event belongs to */
  issueShortId?: string;
  /** More event IDs, as typed, from more arguments or lines */
  extraEventIds?: string[];
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  baseUrl?: string;
  /** Warnings to log, such as for reversed arguments */
  warnings: readonly string[];
};

/** `event view` arguments that name an issue before the event, if any. */
type IssueInput = Omit<EventViewInput, "target" | "warnings" | "baseUrl">;

/**
 * Parse the arguments of `event view`.
 *
 * Event IDs take the forms every ID-taking command does (see
 * `parseIdArguments` and `ID_KINDS.event`): `<event-id>`,
 * `<org>/<project>/<event-id>`, `<target> <event-id> [<event-id>...]`,
 * reversed arguments, and Sentry event URLs. A lone `<x>/<event-id>` names
 * project `<x>`.
 *
 * Before those, `event view` takes an issue instead of, or with, an event:
 * - `[<org>/[<project>/]]<issue-short-id>` or `...<numeric-issue-id>`: the
 *   issue's latest event; also as the ID after a target
 * - `[<org>/[<project>/]]<issue-short-id> <event-id>` and
 *   `<issue-short-id>/<event-id>`: an event of the issue, whose project it is
 *   looked up in
 * - an issue URL without an event: the issue's latest event
 *
 * @throws {ContextError} When the event ID is missing, or is `latest`
 *   without an issue
 * @throws {ValidationError} When the target or an issue's event ID is
 *   invalid
 */
export function parseEventViewInput(args: readonly string[]): EventViewInput {
  const tokens = expandNewlineArgs(args);
  const [first] = tokens;
  if (first === undefined) {
    throw new ContextError("Event ID", USAGE_HINT, []);
  }

  let input: IssueInput;
  let baseUrl: string | undefined;
  let warnings: readonly string[] = [];
  const url = parseSentryUrl(first);
  const issue = url ? issueFromUrl(url) : issueForms(tokens);
  if (issue) {
    input = issue;
    baseUrl = url?.baseUrl;
  } else {
    const parsed = parseIdArguments(tokens, ID_KINDS.event, {
      usageHint: USAGE_HINT,
      multiple: true,
      needsProject: true,
      validate: false,
    });
    const [eventId = "", ...extraEventIds] = parsed.ids;
    input = issueFromEventId(eventId, parsed.target) ?? {
      eventId,
      targetArg: parsed.target,
    };
    if (extraEventIds.length > 0) {
      input.extraEventIds = extraEventIds;
    }
    baseUrl = parsed.baseUrl;
    warnings = parsed.warnings;
  }

  if (input.eventId.toLowerCase() === "latest") {
    // There is no "latest event of a project" endpoint — the latest-event
    // lookup is keyed by issue, so a bare "latest" has nothing to resolve
    throw new ContextError("Issue ID", BARE_LATEST_HINT, [
      "'latest' resolves the newest event of an issue — pass an issue ID, e.g. 'sentry event view 17370'",
    ]);
  }
  const target = parseOrgProjectInput(input.targetArg);
  return {
    ...input,
    target: target.parsed,
    baseUrl: baseUrl ?? target.baseUrl,
    warnings,
  };
}

/**
 * The issue in a Sentry URL without an event ID, whose latest event to
 * show; `null` for an event URL.
 *
 * @throws {ContextError} When the URL names neither an event nor an issue
 */
function issueFromUrl(url: ParsedSentryUrl): IssueInput | null {
  if (url.eventId && url.org) {
    return null;
  }
  if (url.issueId && url.org) {
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: `${url.org}/`,
      issueId: url.issueId,
    };
  }
  throw new ContextError("Event ID", USAGE_HINT, [
    "Pass an event URL: https://sentry.io/organizations/{org}/issues/{id}/events/{eventId}/",
    "Or an issue URL to view the latest event: https://sentry.io/organizations/{org}/issues/{id}/",
  ]);
}

/**
 * The issue `event view` arguments name in their own forms, before any
 * event ID; `null` when they name none.
 *
 * @throws {ValidationError} When the event ID after an issue short ID is
 *   invalid: it must not fall back to the latest event
 */
function issueForms(tokens: readonly string[]): IssueInput | null {
  const [first = "", second] = tokens;
  // `[<org>/[<project>/]]<x>`: the last segment, and the target before it
  // (`<org>/` names an org, `<org>/<project>` a project)
  const slash = first.lastIndexOf("/");
  const id = first.slice(slash + 1);
  const prefix = slash === -1 ? undefined : first.slice(0, slash);
  const target =
    prefix === undefined || prefix.includes("/") ? prefix : `${prefix}/`;

  if (second === undefined) {
    // `<issue-short-id>/<event-id>`: the event of an issue. Short IDs are
    // uppercase, and project slugs never are. `<org>/<issue-short-id>`
    // comes first, then this, even for an all-digit event ID, and then
    // `<org>/<numeric-issue-id>`.
    const afterShortId =
      prefix !== undefined &&
      issueForm(prefix) === "short-id" &&
      issueForm(id) !== "short-id";
    if (
      afterShortId &&
      (ID_KINDS.event.isId(id) || issueForm(id) !== "numeric")
    ) {
      return {
        eventId: ID_KINDS.event.validate(id),
        targetArg: undefined,
        issueShortId: prefix,
      };
    }
    return issueFromEventId(id, target);
  }
  // `[<target>/]<issue-short-id> <event-id>`: the event of an issue. A
  // second argument with a slash is a target: the arguments are reversed.
  if (issueForm(id) === "short-id" && !second.includes("/")) {
    return {
      // Issue shortcuts skip the event ID's recovery
      eventId: ID_KINDS.event.validate(second),
      targetArg: target,
      issueShortId: id,
    };
  }
  return null;
}

/**
 * The issue named where an event ID goes (a short ID or a numeric issue
 * ID), whose latest event to show; `null` for anything else.
 */
function issueFromEventId(
  id: string,
  targetArg: string | undefined,
): IssueInput | null {
  switch (issueForm(id)) {
    case "short-id":
      return { eventId: LATEST_EVENT_SENTINEL, targetArg, issueShortId: id };
    case "numeric":
      return { eventId: LATEST_EVENT_SENTINEL, targetArg, issueId: id };
    default:
      return null;
  }
}

/** The issue ID forms `event view` tells apart from event IDs */
function issueForm(value: string): "short-id" | "numeric" | null {
  return ID_KINDS.issue.distinctForm(value);
}

/**
 * Validate the raw event ID via `validateHexId`, falling back to
 * `recoverHexId` + `handleRecoveryResult` when validation fails.
 *
 * Returns the usable event ID (original, stripped, fuzzy-recovered, or
 * cross-entity-redirected). Throws the original or augmented error when
 * recovery can't produce a usable ID.
 *
 * Skips validation entirely when the event ID is a sentinel (`LATEST_EVENT_SENTINEL`)
 * or when the caller already resolved via an issue URL / short ID path —
 * those cases look up the event through issue lookup, not by hex ID.
 */
async function validateAndRecoverEventId(
  rawEventId: string,
  parsed: ParsedOrgProject,
  skipValidation: boolean,
): Promise<string> {
  if (skipValidation) {
    return rawEventId;
  }
  try {
    return validateHexId(rawEventId, "event ID");
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err;
    }
    const recoveryOrg = await resolveRecoveryOrg(parsed);
    const recoveryCtx = recoveryOrg ?? { org: "", project: undefined };
    const result = await recoverHexId(rawEventId, "event", recoveryCtx);
    return handleRecoveryResult(result, err, {
      entityType: "event",
      canonicalCommand: `sentry event view ${recoveryCtx.org || "<org>"}/${recoveryCtx.project ?? "<project>"}/<id>`,
      logTag: "event.view",
    });
  }
}

/** `event view` arguments, with the event ID validated or recovered. */
type ResolvedEventViewInput = Omit<EventViewInput, "baseUrl" | "warnings">;

/** The arguments of `event view`. */
type EventViewArguments = BoundArguments<
  EventViewInput,
  ResolvedEventViewInput
>;

/**
 * Resolve `event view` arguments: apply a pasted URL's server, log the
 * warnings, and validate the event ID or recover a malformed one. An issue
 * shortcut's event ID needs neither: the issue finds the event.
 */
async function resolveEventViewInput(
  input: EventViewInput,
): Promise<ResolvedEventViewInput> {
  const { baseUrl, warnings, ...resolved } = input;
  if (baseUrl) {
    applySentryUrlContext(baseUrl);
  }
  for (const warning of warnings) {
    logger.withTag("event.view").warn(warning);
  }
  const skipValidation =
    resolved.eventId === LATEST_EVENT_SENTINEL ||
    resolved.issueId !== undefined ||
    resolved.issueShortId !== undefined;
  return {
    ...resolved,
    eventId: await validateAndRecoverEventId(
      resolved.eventId,
      resolved.target,
      skipValidation,
    ),
  };
}

/**
 * Resolved target type for event commands.
 * @internal Exported for testing
 */
export type ResolvedEventTarget = {
  org: string;
  project: string;
  orgDisplay: string;
  projectDisplay: string;
  detectedFrom?: string;
  /** Pre-fetched event from cross-project resolution — avoids a second API call */
  prefetchedEvent?: ResolvedEvent["event"];
};

/** Options for resolving the event target */
type ResolveTargetOptions = {
  parsed: ParsedOrgProject;
  eventId: string;
  cwd: string;
};

/**
 * Resolve org/project context for the event view command.
 *
 * Handles all target types (explicit, search, org-all, auto-detect)
 * including cross-project fallback via the eventids endpoint.
 * Tags `sentry.org` / `sentry.project` on success because several of
 * those paths skip `resolve-target`'s telemetry helper.
 *
 * @internal Exported for testing
 */
export async function resolveEventTarget(
  options: ResolveTargetOptions,
): Promise<ResolvedEventTarget | null> {
  const { parsed, eventId, cwd } = options;

  let target: ResolvedEventTarget | null;
  switch (parsed.type) {
    case ProjectSpecificationType.Explicit: {
      const org = await resolveEffectiveOrg(parsed.org);
      target = {
        org,
        project: parsed.project,
        orgDisplay: parsed.org,
        projectDisplay: parsed.project,
      };
      break;
    }

    case ProjectSpecificationType.ProjectSearch: {
      const resolved = await resolveProjectBoundSlug(
        parsed.projectSlug,
        USAGE_HINT,
        `sentry event view <org>/${parsed.projectSlug} ${eventId}`,
        parsed.originalSlug,
      );
      target = {
        org: resolved.org,
        project: resolved.project,
        orgDisplay: resolved.org,
        projectDisplay: resolved.project,
      };
      break;
    }

    case ProjectSpecificationType.OrgAll: {
      const org = await resolveEffectiveOrg(parsed.org);
      target = await resolveOrgAllTarget(org, eventId, cwd);
      break;
    }

    case ProjectSpecificationType.AutoDetect:
      target = await resolveAutoDetectTarget(eventId, cwd);
      break;

    default: {
      const _exhaustiveCheck: never = parsed;
      target = null;
      break;
    }
  }

  if (target) {
    setOrgProjectContext([target.org], [target.project]);
  }
  return target;
}

/**
 * Resolve target when only an org is known (e.g., from a Sentry event URL).
 * Uses the eventids endpoint to find the project directly.
 *
 * Throws a ContextError if the event is not found in the given org, with a
 * message that names the org so the error is not misleading.
 * Propagates auth/network errors from resolveEventInOrg.
 *
 * @internal Exported for testing
 */
export async function resolveOrgAllTarget(
  org: string,
  eventId: string,
  _cwd: string,
): Promise<ResolvedEventTarget> {
  const resolved = await resolveEventInOrg(org, eventId);
  if (!resolved) {
    throw new ResolutionError(
      `Event ${eventId} in organization "${org}"`,
      "not found",
      `sentry event view ${org}/<project> ${eventId}`,
    );
  }
  return {
    org: resolved.org,
    project: resolved.project,
    orgDisplay: org,
    projectDisplay: resolved.project,
    prefetchedEvent: resolved.event,
  };
}

/**
 * Resolve target via auto-detect cascade, falling back to cross-project
 * event search across all accessible orgs.
 *
 * @internal Exported for testing
 */
export async function resolveAutoDetectTarget(
  eventId: string,
  cwd: string,
): Promise<ResolvedEventTarget | null> {
  const autoTarget = await resolveOrgAndProject({ cwd, usageHint: USAGE_HINT });
  if (autoTarget) {
    return autoTarget;
  }

  const resolved = await findEventAcrossOrgs(eventId);
  if (resolved) {
    logger
      .withTag("event.view")
      .warn(
        `Found event in ${resolved.org}/${resolved.project}. ` +
          `Use: sentry event view ${resolved.org}/${resolved.project} ${eventId}`,
      );
    return {
      org: resolved.org,
      project: resolved.project,
      orgDisplay: resolved.org,
      projectDisplay: resolved.project,
      prefetchedEvent: resolved.event,
    };
  }
  return null;
}

/**
 * Build {@link EventViewData} from a pre-fetched event, optionally
 * including span tree data. Shared by all event-fetch paths so the
 * span-tree assembly logic lives in one place.
 *
 * @param org - Organization slug (needed for span tree API call)
 * @param event - Already-fetched event
 * @param spans - Span tree depth (0 = skip)
 * @param project - Project slug for attachment listing, when already resolved
 */
async function buildSingleEventViewData(
  org: string,
  event: SentryEvent,
  spans: number,
  project?: string,
): Promise<SingleEventViewData> {
  const projectSlug = project ?? eventProjectSlug(event);
  const [spanTreeResult, attachments] = await Promise.all([
    spans > 0
      ? getSpanTreeLines(org, event, spans)
      : Promise.resolve(undefined),
    loadEventAttachments(org, projectSlug, event.eventID),
  ]);
  const trace =
    spanTreeResult?.success && spanTreeResult.traceId
      ? { traceId: spanTreeResult.traceId, spans: spanTreeResult.spans ?? [] }
      : null;
  return {
    event,
    trace,
    spanTreeLines: spanTreeResult?.lines,
    attachments,
    org,
  };
}

/**
 * Fetch the latest event for an issue URL and build the output data.
 * Extracted from func() to reduce cyclomatic complexity.
 */
async function fetchLatestEventData(
  org: string,
  issueId: string,
  spans: number,
  project?: string,
): Promise<SingleEventViewData> {
  const event = await getLatestEvent(org, issueId);
  return await buildSingleEventViewData(org, event, spans, project);
}

/**
 * Try to find an event via cross-project and cross-org fallbacks.
 *
 * 1. Same-org fallback: tries the eventids resolution endpoint within `org`.
 * 2. Cross-org fallback: fans out to all accessible orgs (skipping `org`).
 *
 * Returns the resolved location and event, or null when the event cannot be
 * found anywhere.
 */
async function tryEventFallbacks(
  org: string,
  project: string,
  eventId: string,
): Promise<ResolvedEvent | null> {
  // Same-org fallback: try cross-project lookup within the specified org.
  // Handles wrong-project resolution from DSN auto-detect or config defaults.
  // Track whether the search completed so we can skip the org in cross-org
  // only when we got a definitive "not found" (not a transient failure).
  let sameOrgSearched = false;
  // Track rate-limit separately: a 429 means the org is reachable but throttled.
  // Retrying it immediately in the cross-org fallback would just hit the same
  // limit again, producing consecutive identical HTTP requests (CLI-2Y1).
  let orgRateLimited = false;
  try {
    const resolved = await resolveEventInOrg(org, eventId);
    sameOrgSearched = true;
    if (resolved) {
      logger.warn(
        `Event not found in ${org}/${project}, but found in ${resolved.org}/${resolved.project}.`,
      );
      return resolved;
    }
  } catch (sameOrgError) {
    // Propagate auth errors — they indicate a global problem (expired token)
    if (sameOrgError instanceof AuthError) {
      throw sameOrgError;
    }
    if (sameOrgError instanceof ApiError && sameOrgError.status === 429) {
      // Rate-limited — exclude the org from cross-org search; an immediate
      // retry against the same endpoint would hit the same limit.
      orgRateLimited = true;
    }
    logger.debug("Same-org event lookup failed", sameOrgError);
  }

  // Cross-org fallback: the event may exist in a different organization.
  // Exclude the org when the same-org search completed (returned null) OR
  // when it was rate-limited — either way, re-querying it immediately is futile.
  try {
    const crossOrg = await findEventAcrossOrgs(eventId, {
      excludeOrgs: sameOrgSearched || orgRateLimited ? [org] : undefined,
    });
    if (crossOrg) {
      // Use project-scoped phrasing when found in same org (different project)
      // to avoid the contradictory "not found in 'org', found in org/project".
      const location = `${crossOrg.org}/${crossOrg.project}`;
      const prefix =
        crossOrg.org === org
          ? `Event not found in ${org}/${project}`
          : `Event not found in '${org}'`;
      logger.warn(`${prefix}, but found in ${location}.`);
      return crossOrg;
    }
  } catch (fallbackError) {
    // Propagate auth errors — they indicate a global problem (expired token)
    if (fallbackError instanceof AuthError) {
      throw fallbackError;
    }
    // Swallow transient errors — continue to suggestions
  }

  return null;
}

/**
 * Fetch an event, enriching 404 errors with actionable suggestions.
 *
 * The generic "Failed to get event: 404 Not Found" is the most common
 * event view failure (CLI-6F, 54 users). This wrapper adds context about
 * data retention, ID format, and cross-project/cross-org lookup.
 *
 * When the project-scoped fetch returns 404, automatically tries:
 * 1. Org-wide eventids resolution (wrong project within correct org)
 * 2. Cross-org search across all accessible orgs (wrong org entirely)
 *
 * @param prefetchedEvent - Already-resolved event (from cross-org lookup), or null
 * @param org - Organization slug
 * @param project - Project slug
 * @param eventId - Event ID being looked up
 * @returns The event and its resolved organization/project
 */
export async function fetchEventWithContext(
  prefetchedEvent: SentryEvent | null,
  org: string,
  project: string,
  eventId: string,
): Promise<ResolvedEvent> {
  if (prefetchedEvent) {
    return { org, project, event: prefetchedEvent };
  }
  try {
    const event = await getEvent(org, project, eventId);
    return { org, project, event };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const fallback = await tryEventFallbacks(org, project, eventId);
      if (fallback) {
        return fallback;
      }

      const suggestions = [
        "The ID format is valid but no matching event was found in any accessible organization",
        "Check that you are querying the right org/project — the ID may belong to a different one",
        "Events past your plan's retention window are no longer retrievable",
      ];

      // Nudge the user when the event ID looks like an issue short ID
      if (issueForm(eventId) === "short-id") {
        suggestions.unshift(
          `This looks like an issue short ID. Try: sentry issue view ${eventId}`,
        );
      }

      throw new ResolutionError(
        `Event '${eventId}'`,
        `not found in ${org}/${project}`,
        `sentry event view ${org}/<project> ${eventId}`,
        suggestions,
      );
    }
    throw error;
  }
}

/**
 * Resolve an issue short ID and fetch its latest event.
 *
 * Used when the user passes an issue short ID (e.g., "BRUNCHIE-APP-29")
 * to `event view` instead of a hex event ID. We auto-detect this and
 * show the latest event for the issue, with a warning nudging them
 * toward `sentry issue view`.
 *
 * @param issueShortId - Issue short ID (e.g., "BRUNCHIE-APP-29")
 * @param org - Organization slug
 * @param spans - Span tree depth
 */
async function resolveIssueShortIdEvent(
  issueShortId: string,
  org: string,
  spans: number,
): Promise<SingleEventViewData> {
  const issue = await getIssueByShortId(org, issueShortId);
  return await fetchLatestEventData(org, issue.id, spans, issue.project?.slug);
}

/** Result from an issue-based shortcut (URL or short ID) */
type IssueShortcutResult = {
  org: string;
  data: SingleEventViewData;
  hint: string;
};

/** Options for resolving issue-based shortcuts */
type IssueShortcutOptions = {
  parsed: ParsedOrgProject;
  eventId: string;
  issueId: string | undefined;
  issueShortId: string | undefined;
  cwd: string;
  spans: number;
};

/**
 * Best-effort project resolution for numeric issue shortcuts.
 */
async function tryResolveIssueProject(
  org: string,
  issueId: string,
): Promise<string | undefined> {
  try {
    const issue = await getIssueInOrg(org, issueId, {
      collapse: ISSUE_DETAIL_COLLAPSE,
    });
    return issue.project?.slug;
  } catch (error) {
    logger
      .withTag("event.view")
      .debug("Failed to resolve project for issue attachments", error);
    return;
  }
}

/**
 * Fetch the latest event for a numeric issue ID (or issue-URL issue ID).
 *
 * The organization comes from an explicit target (`org/` or `org/project`) or
 * auto-detection. When the project is not explicit, issue details provide its
 * slug so attachment lookup can use the project-scoped endpoint.
 */
async function resolveIssueIdShortcut(
  parsed: ParsedOrgProject,
  issueId: string,
  cwd: string,
  spans: number,
): Promise<IssueShortcutResult> {
  const log = logger.withTag("event.view");
  const explicitOrg =
    parsed.type === "org-all" || parsed.type === "explicit"
      ? parsed.org
      : undefined;
  const resolved = await resolveOrg({ org: explicitOrg, cwd });
  if (!resolved) {
    throw new ContextError("Organization", `sentry event view ${issueId}`);
  }
  const org = resolved.org;
  log.info(`Fetching latest event for issue ${issueId}...`);
  const explicitProject =
    parsed.type === ProjectSpecificationType.Explicit
      ? parsed.project
      : undefined;
  const projectPromise = explicitProject
    ? Promise.resolve(explicitProject)
    : tryResolveIssueProject(org, issueId);
  const [event, project] = await Promise.all([
    getLatestEvent(org, issueId),
    projectPromise,
  ]);
  const data = await buildSingleEventViewData(org, event, spans, project);
  return { org, data, hint: `Showing latest event for issue ${issueId}` };
}

/**
 * Handle issue-based shortcuts: issue URLs and issue short IDs.
 *
 * Resolve the issue's project for an explicit event ID, or fetch the latest
 * event when no event was selected. Extracted from func() to reduce complexity.
 *
 * @returns Result with org, data, and hint — or null if not an issue shortcut
 */
async function resolveIssueShortcut(
  options: IssueShortcutOptions,
): Promise<IssueShortcutResult | null> {
  const { parsed, eventId, issueId, issueShortId, cwd, spans } = options;
  const log = logger.withTag("event.view");

  // Issue URL / numeric issue ID shortcut: fetch the latest event directly
  // via the issue ID, bypassing project resolution (getLatestEvent only needs
  // org + issue ID).
  if (issueId) {
    return await resolveIssueIdShortcut(parsed, issueId, cwd, spans);
  }

  // Issue short ID auto-redirect: user passed an issue short ID
  // (e.g., "BRUNCHIE-APP-29" or "CLI-G5/abc123...") instead of or
  // alongside a hex event ID. Resolve the issue to get org/project.
  if (issueShortId) {
    // Use the explicit org from the parsed target if available (e.g.,
    // "figma/" → org-all, or "figma/project" → explicit, both carry the
    // org), otherwise fall back to auto-detection via DSN/env/config.
    const explicitOrg =
      parsed.type === "org-all" || parsed.type === "explicit"
        ? parsed.org
        : undefined;
    const resolved = await resolveOrg({ org: explicitOrg, cwd });
    if (!resolved) {
      throw new ContextError(
        "Organization",
        `sentry issue view ${issueShortId}`,
      );
    }

    // When the user specified an event ID (SHORT-ID/ID or SHORT-ID ID),
    // resolve the issue to get the project, then fetch the specific event.
    if (eventId !== LATEST_EVENT_SENTINEL) {
      const issue = await getIssueByShortId(resolved.org, issueShortId);
      const issueProject = issue.project?.slug;
      if (!issueProject) {
        throw new ResolutionError(
          `Issue '${issueShortId}'`,
          "has no associated project",
          `sentry event view <org>/<project> ${eventId}`,
          ["Specify the project explicitly to view this event"],
        );
      }
      const event = await getEvent(resolved.org, issueProject, eventId);
      const data = await buildSingleEventViewData(
        resolved.org,
        event,
        spans,
        issueProject,
      );
      return {
        org: resolved.org,
        data,
        hint: `Viewing event ${eventId} for issue ${issueShortId}`,
      };
    }

    log.warn(
      `'${issueShortId}' is an issue short ID, not an event ID. Showing the latest event.`,
    );
    const data = await resolveIssueShortIdEvent(
      issueShortId,
      resolved.org,
      spans,
    );
    return {
      org: resolved.org,
      data,
      hint: `Tip: Use 'sentry issue view ${issueShortId}' to view the full issue`,
    };
  }

  return null;
}

/**
 * Validate extra event IDs from newline-expanded agent input.
 *
 * Skips invalid IDs with an info log — agent-pasted lists may contain
 * garbage (partial lines, headers, etc).
 *
 * @param extraIds - Raw extra event IDs to validate
 * @param primaryId - Already-validated primary event ID
 * @returns All valid event IDs (primary + validated extras)
 */
export function collectEventIds(
  primaryId: string,
  extraIds: string[] | undefined,
): string[] {
  const seen = new Set<string>([primaryId]);
  const allIds = [primaryId];
  if (!extraIds || extraIds.length === 0) {
    return allIds;
  }
  const log = logger.withTag("event.view");
  for (const rawId of extraIds) {
    try {
      const validated = validateHexId(rawId, "Event ID");
      if (!seen.has(validated)) {
        seen.add(validated);
        allIds.push(validated);
      }
    } catch {
      log.info(`Skipping invalid event ID: ${rawId}`);
    }
  }
  return allIds;
}

/** Options for fetching multiple events in parallel */
type FetchMultipleOptions = {
  /** Event IDs to fetch */
  eventIds: string[];
  /** Organization slug */
  org: string;
  /** Project slug */
  project: string;
  /** Pre-fetched event for the primary ID (from cross-project resolution) */
  prefetchedEvent: SentryEvent | null;
  /** The primary event ID (may have a prefetched event) */
  primaryId: string;
};

/**
 * Fetch multiple events with bounded concurrency, collecting successes
 * and warning on failures.
 *
 * Uses {@link ORG_FANOUT_CONCURRENCY} (5) to avoid overwhelming the API
 * when agents paste dozens of IDs.
 *
 * When all fetches fail, re-throws the error from the primary (first) event.
 */
export async function fetchMultipleEvents(
  options: FetchMultipleOptions,
): Promise<ResolvedEvent[]> {
  const { eventIds, org, project, prefetchedEvent, primaryId } = options;
  const log = logger.withTag("event.view");
  const limit = pLimit(ORG_FANOUT_CONCURRENCY);

  const results = await Promise.allSettled(
    eventIds.map((id) =>
      limit(() =>
        fetchEventWithContext(
          id === primaryId ? prefetchedEvent : null,
          org,
          project,
          id,
        ),
      ),
    ),
  );

  const events: ResolvedEvent[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === "fulfilled") {
      events.push(result.value);
    } else if (result?.status === "rejected") {
      log.warn(`Failed to fetch event ${eventIds[i]}: ${result.reason}`);
    }
  }

  if (events.length === 0) {
    const firstResult = results[0];
    if (firstResult?.status === "rejected") {
      throw firstResult.reason;
    }
  }

  return events;
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of one or more events",
    fullDescription:
      "View detailed information about Sentry events by their IDs.\n\n" +
      "Pass an issue short ID followed by an event ID to resolve the project from the issue.\n" +
      "An issue short ID without an event ID shows its latest event.\n\n" +
      "Multiple event IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument (handy when piping from other commands).\n\n" +
      "Attachment metadata (id, name, size, mimetype, download URL) is included when available.\n" +
      "Download the bytes with `sentry api` and the attachment's download URL.",
    examples: [
      {
        description: "View an event",
        command: "sentry event view abc123def456abc123def456abc12345",
      },
      {
        description: "View a specific event using an issue short ID",
        command: "sentry event view PROJ-ABC 7388f6a62b7d436ab77bb5365f97a1ac",
      },
      {
        description: "View a specific event with an explicit organization",
        command:
          "sentry event view my-org/PROJ-ABC 7388f6a62b7d436ab77bb5365f97a1ac",
      },
      {
        description: "View the latest event for an issue",
        command: "sentry event view PROJ-ABC",
      },
      {
        description: "Open in the browser",
        command: "sentry event view abc123def456abc123def456abc12345 -w",
      },
      {
        description:
          "Download an attachment listed by --json (with sentry api)",
        command:
          "sentry api 'https://sentry.io/api/0/projects/my-org/my-project/events/EVENT_ID/attachments/ATTACHMENT_ID/?download=1' > screenshot.png",
      },
      {
        description: "View an event in an explicit project",
        command:
          "sentry event view my-org/my-project abc123def456abc123def456abc12345",
      },
      {
        description:
          "View several events, finding the project across organizations",
        command:
          "sentry event view my-project abc123def456abc123def456abc12345 def456abc123def456abc123def45678",
      },
    ],
  },
  output: {
    human: formatEventView,
    jsonTransform: jsonTransformEventView,
    schema: EventViewOutputSchema,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project/event-id",
      brief:
        "[<org>/<project>] <event-id> [<event-id>...] - Target (optional) and one or more event IDs",
      kind: ORG_PROJECT_TARGET,
      parse: parseEventViewInput,
      resolve: resolveEventViewInput,
    }),
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      ...spansFlag,
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, args: EventViewArguments) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const log = logger.withTag("event.view");
    const {
      target: parsed,
      eventId,
      issueId,
      issueShortId,
      extraEventIds,
    } = await args.resolved;

    // Handle issue-based shortcuts (issue URLs and short IDs) before
    // normal event resolution. When eventId is LATEST_EVENT_SENTINEL,
    // fetches the latest event; otherwise fetches the specific event.
    const issueShortcut = await resolveIssueShortcut({
      parsed,
      eventId,
      issueId,
      issueShortId,
      cwd,
      spans: flags.spans,
    });
    if (issueShortcut) {
      if (flags.web) {
        await openInBrowser(
          buildEventSearchUrl(
            issueShortcut.org,
            issueShortcut.data.event.eventID,
          ),
          "event",
        );
        return;
      }
      yield new CommandOutput({
        events: [issueShortcut.data],
        requestedCount: 1,
      });
      return {
        hint: viewOutputHint(
          issueShortcut.org,
          issueShortcut.data,
          issueShortcut.hint,
        ),
      };
    }

    const target = await resolveEventTarget({
      parsed,
      eventId,
      cwd,
    });

    if (!target) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    if (flags.web) {
      if (extraEventIds && extraEventIds.length > 0) {
        log.warn(
          "--web only opens the first event; extra event IDs are ignored.",
        );
      }
      await openInBrowser(buildEventSearchUrl(target.org, eventId), "event");
      return;
    }

    // Collect all event IDs (primary + validated extras from newline expansion)
    const allEventIds = collectEventIds(eventId, extraEventIds);

    // Fetch all events in parallel, warning on individual failures
    const fetchedEvents = await fetchMultipleEvents({
      eventIds: allEventIds,
      org: target.org,
      project: target.project,
      prefetchedEvent: target.prefetchedEvent ?? null,
      primaryId: eventId,
    });

    // Build view data for each event in parallel
    const viewDataEntries = await Promise.all(
      fetchedEvents.map((resolved) =>
        buildSingleEventViewData(
          resolved.org,
          resolved.event,
          flags.spans,
          resolved.project,
        ),
      ),
    );

    yield new CommandOutput({
      events: viewDataEntries,
      requestedCount: allEventIds.length,
    });
    return {
      hint: viewOutputHint(
        viewDataEntries[0]?.org ?? target.org,
        viewDataEntries[0],
        target.detectedFrom
          ? `Detected from ${target.detectedFrom}`
          : undefined,
      ),
    };
  },
});
