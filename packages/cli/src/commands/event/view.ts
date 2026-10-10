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
  detectSwappedViewArgs,
  looksLikeIssueShortId,
  ProjectSpecificationType,
  parseOrgProjectArg,
  parseSlashSeparatedArg,
  spansFlag,
  splitNewlineArg,
} from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
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
import { HEX_ID_RE, normalizeHexId, validateHexId } from "../../lib/hex-id.js";
import {
  handleRecoveryResult,
  recoverHexId,
  resolveRecoveryOrg,
} from "../../lib/hex-id-recovery.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { resolveEffectiveOrg } from "../../lib/region.js";
import { getReplayIdFromEvent } from "../../lib/replay-search.js";
import {
  resolveOrg,
  resolveOrgAndProject,
  resolveProjectBoundSlug,
} from "../../lib/resolve-target.js";
import {
  applySentryUrlContext,
  parseSentryUrl,
} from "../../lib/sentry-url-parser.js";
import { buildEventSearchUrl } from "../../lib/sentry-web-urls.js";
import { getSpanTreeLines } from "../../lib/span-tree.js";
import { setOrgProjectContext } from "../../lib/telemetry.js";
import { isAllDigits } from "../../lib/utils.js";
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
 * the org/project prefix so `parsePositionalArgs` can extract the target.
 */
export function expandNewlineArgs(args: string[]): string[] {
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
 * Parse a single positional arg for event view, handling issue short ID
 * detection both in bare form ("BRUNCHIE-APP-29") and org-prefixed form
 * ("figma/FULLSCREEN-2RN").
 *
 * Must run before `parseSlashSeparatedArg` because that function throws
 * ContextError for single-slash args like "org/SHORT-ID", which looks like
 * "org/project" with a missing event ID.
 */
function parseSingleArg(arg: string): ParsedPositionalArgs {
  // Detect single-slash shortcuts ("org/SHORT-ID", "SHORT-ID/EVENT-ID",
  // "project/EVENT-ID", "org/NUMERIC-ID") before parseSlashSeparatedArg,
  // which throws ContextError for single-slash args.
  const slashIdx = arg.indexOf("/");
  if (slashIdx !== -1 && arg.indexOf("/", slashIdx + 1) === -1) {
    const singleSlash = parseSingleSlashArg(
      arg.slice(0, slashIdx),
      arg.slice(slashIdx + 1),
    );
    if (singleSlash) {
      return singleSlash;
    }
  }

  const { id: eventId, targetArg } = parseSlashSeparatedArg(
    arg,
    "Event ID",
    USAGE_HINT,
  );

  // Detect bare issue short ID passed as event ID (e.g., "BRUNCHIE-APP-29").
  if (!targetArg && looksLikeIssueShortId(eventId)) {
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: undefined,
      issueShortId: eventId,
    };
  }

  // Reject bare "latest" (without the "@" prefix sentinel). There is no
  // "latest event of a project" endpoint — the latest-event lookup is keyed
  // by issue, so a bare "latest" has nothing to resolve against.
  if (eventId.toLowerCase() === "latest") {
    throw new ContextError("Issue ID", BARE_LATEST_HINT, [
      "'latest' resolves the newest event of an issue — pass an issue ID, e.g. 'sentry event view 17370'",
    ]);
  }

  // Detect numeric issue ID (e.g., "17370") — treat as issueId and fetch latest event.
  if (isAllDigits(eventId)) {
    return { eventId: LATEST_EVENT_SENTINEL, targetArg, issueId: eventId };
  }

  return { eventId, targetArg };
}

/**
 * Resolve a single-slash positional arg (`before/after`) to a parsed result,
 * or `null` when it isn't one of the recognized shortcut shapes and should
 * fall through to `parseSlashSeparatedArg`.
 *
 * Handled shapes:
 * - `org/SHORT-ID` → org-all + issue short ID (latest event)
 * - `SHORT-ID/EVENT-ID` → specific event via issue short ID
 * - `org/NUMERIC-ID` → org-all + numeric issue ID (latest event)
 * - `project/EVENT-ID` → project slug + hex event ID
 *
 * Extracted from `parseSingleArg` to keep it under the cognitive-complexity
 * limit.
 */
function parseSingleSlashArg(
  beforeSlash: string,
  afterSlash: string,
): ParsedPositionalArgs | null {
  // "org/SHORT-ID" → auto-redirect to that issue's latest event.
  // e.g., "figma/FULLSCREEN-2RN". Use "org/" (trailing slash) to signal
  // OrgAll mode so downstream parseOrgProjectArg treats it as an org.
  if (afterSlash && looksLikeIssueShortId(afterSlash)) {
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: `${beforeSlash}/`,
      issueShortId: afterSlash,
    };
  }

  // "SHORT-ID/EVENT-ID" → view a specific event identified by issue short ID.
  // e.g., "CLI-G5/abc123def456abc123def456abc123de"
  if (
    beforeSlash &&
    looksLikeIssueShortId(beforeSlash) &&
    afterSlash &&
    HEX_ID_RE.test(normalizeHexId(afterSlash))
  ) {
    return {
      eventId: normalizeHexId(afterSlash),
      targetArg: undefined,
      issueShortId: beforeSlash,
    };
  }

  // "org/NUMERIC-ID" → org-all + numeric issue ID (latest event).
  // e.g., "my-org/17370". Mirrors bare "17370" and "my-org/my-project 17370",
  // and matches how `sentry issue view org/numericId` already behaves.
  if (beforeSlash && afterSlash && isAllDigits(afterSlash)) {
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: `${beforeSlash}/`,
      issueId: afterSlash,
    };
  }

  // "project/EVENT-ID" → project slug + hex event ID.
  // e.g., "my-project/abc123def456abc123def456abc123de"
  if (afterSlash && HEX_ID_RE.test(normalizeHexId(afterSlash))) {
    return {
      eventId: normalizeHexId(afterSlash),
      targetArg: beforeSlash,
    };
  }

  return null;
}

/** Return type for parsePositionalArgs */
type ParsedPositionalArgs = {
  eventId: string;
  targetArg: string | undefined;
  /** Issue ID from a Sentry issue URL — triggers latest-event fetch */
  issueId?: string;
  /** Issue short ID detected from positional args (e.g., "BRUNCHIE-APP-29") */
  issueShortId?: string;
  /** Warning message if arguments appear to be in the wrong order */
  warning?: string;
  /** Additional event IDs from newline-separated input or extra positional args */
  extraEventIds?: string[];
};

/**
 * Parse positional arguments for event view.
 *
 * Handles:
 * - `<event-id>` — event ID only (auto-detect org/project)
 * - `<target> <event-id>` — explicit target + event ID
 * - `<sentry-event-url>` — extract eventId and org from a Sentry event URL
 *   (e.g., `https://sentry.example.com/organizations/my-org/issues/123/events/abc/`)
 * - `<sentry-issue-url>` — extract issueId and org; caller fetches latest event
 *   (e.g., `https://sentry.example.com/organizations/my-org/issues/123/`)
 *
 * For event URLs, the org is returned as `targetArg` in `"{org}/"` format
 * (OrgAll). Since event URLs don't contain a project slug, the caller
 * must fall back to auto-detection for the project.
 *
 * For issue URLs (no eventId segment), the `issueId` field is set so the
 * caller can fetch the latest event via `getLatestEvent(org, issueId)`.
 *
 * @returns Parsed event ID and optional target arg
 */
// positional arg parsing has many format branches by design
export function parsePositionalArgs(args: string[]): ParsedPositionalArgs {
  if (args.length === 0) {
    throw new ContextError("Event ID", USAGE_HINT, []);
  }

  const first = args[0];
  if (first === undefined) {
    throw new ContextError("Event ID", USAGE_HINT, []);
  }

  // URL detection — extract eventId and org from Sentry event URLs
  const urlParsed = parseSentryUrl(first);
  if (urlParsed) {
    applySentryUrlContext(urlParsed.baseUrl);
    if (urlParsed.eventId && urlParsed.org) {
      // Event URL: pass org as OrgAll target ("{org}/").
      // Event URLs don't contain a project slug, so viewCommand falls
      // back to auto-detect for the project while keeping the org context.
      return { eventId: urlParsed.eventId, targetArg: `${urlParsed.org}/` };
    }
    if (urlParsed.issueId && urlParsed.org) {
      // Issue URL without event ID — fetch the latest event for this issue.
      // The caller uses issueId to fetch via getLatestEvent.
      return {
        eventId: LATEST_EVENT_SENTINEL,
        targetArg: `${urlParsed.org}/`,
        issueId: urlParsed.issueId,
      };
    }
    // URL recognized but no eventId or issueId — not useful for event view
    throw new ContextError("Event ID", USAGE_HINT, [
      "Pass an event URL: https://sentry.io/organizations/{org}/issues/{id}/events/{eventId}/",
      "Or an issue URL to view the latest event: https://sentry.io/organizations/{org}/issues/{id}/",
    ]);
  }

  if (args.length === 1) {
    return parseSingleArg(first);
  }

  // When newline expansion splits "org/project/id1\nid2" into multiple args,
  // the first arg is "org/project/id1" (2+ slashes). Route it through the
  // single-arg path to correctly extract org/project vs id, then collect the
  // remaining args as extra event IDs (CLI-1HT).
  const slashCount = (first.match(/\//g) ?? []).length;
  if (slashCount >= 2) {
    const parsed = parseSingleArg(first);
    const extraEventIds = args.slice(1);
    return { ...parsed, extraEventIds };
  }

  const second = args[1];
  if (second === undefined) {
    // Should not happen given length check, but TypeScript needs this
    return { eventId: first, targetArg: undefined };
  }

  // Detect swapped args: user put ID first and target second
  const swapWarning = detectSwappedViewArgs(first, second);
  if (swapWarning) {
    const extraEventIds = args.length > 2 ? args.slice(2) : undefined;
    return {
      eventId: first,
      targetArg: second,
      warning: swapWarning,
      extraEventIds,
    };
  }

  // Detect issue short ID passed as first arg (e.g., "CAM-82X 95fd7f5a").
  // Auto-redirect to the issue's latest event instead of treating the short
  // ID as a project slug (which would fail — slugs are lowercase, short IDs
  // are uppercase). The second arg is ignored since we fetch the latest event.
  if (looksLikeIssueShortId(first)) {
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: undefined,
      issueShortId: first,
      warning: `'${first}' is an issue short ID, not a project slug. Ignoring second argument '${second}'.`,
    };
  }

  // Reject bare "latest" as second arg (e.g., "my-org/my-project latest").
  // Even with an explicit project there is no "latest event of a project"
  // endpoint — latest is resolved per-issue, so this has nothing to key on.
  if (second.toLowerCase() === "latest") {
    throw new ContextError("Issue ID", BARE_LATEST_HINT, [
      "'latest' resolves the newest event of an issue — pass an issue ID, e.g. 'sentry event view 17370'",
    ]);
  }

  // Detect numeric issue ID as second arg (e.g., "my-org/my-project 17370").
  if (isAllDigits(second)) {
    const extraEventIds = args.length > 2 ? args.slice(2) : undefined;
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: first,
      issueId: second,
      extraEventIds,
    };
  }

  // Detect issue short ID as second arg (e.g., "my-org/my-project BRUNCHIE-APP-29").
  // Auto-redirect to that issue's latest event instead of treating the short
  // ID as an event hex ID (which would fail validation).
  if (looksLikeIssueShortId(second)) {
    const extraEventIds = args.length > 2 ? args.slice(2) : undefined;
    return {
      eventId: LATEST_EVENT_SENTINEL,
      targetArg: first,
      issueShortId: second,
      extraEventIds,
    };
  }

  // Two or more args - first is target, second is event ID.
  // Any additional args are extra event IDs (from newline-separated input).
  const extraEventIds = args.length > 2 ? args.slice(2) : undefined;
  return { eventId: second, targetArg: first, extraEventIds };
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
  parsed: ReturnType<typeof parseOrgProjectArg>,
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
  parsed: ReturnType<typeof parseOrgProjectArg>;
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
  return buildSingleEventViewData(org, event, spans, project);
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
      if (looksLikeIssueShortId(eventId)) {
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
  return fetchLatestEventData(org, issue.id, spans, issue.project?.slug);
}

/** Result from an issue-based shortcut (URL or short ID) */
type IssueShortcutResult = {
  org: string;
  data: SingleEventViewData;
  hint: string;
};

/** Options for resolving issue-based shortcuts */
type IssueShortcutOptions = {
  parsed: ReturnType<typeof parseOrgProjectArg>;
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
  parsed: ReturnType<typeof parseOrgProjectArg>,
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
 * Both paths resolve an issue and fetch its latest event. Extracted from
 * func() to reduce cyclomatic complexity.
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

    // When the user specified a specific event ID (SHORT-ID/EVENT-ID),
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
      "Target specification:\n" +
      "  sentry event view <event-id>                         # auto-detect from DSN or config\n" +
      "  sentry event view <org>/<proj> <event-id> [<id>...]  # explicit org and project\n" +
      "  sentry event view <project> <event-id> [<id>...]     # find project across all orgs\n\n" +
      "Multiple event IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument (handy when piping from other commands).\n\n" +
      "Attachment metadata (id, name, size, mimetype, download URL) is included when available.\n" +
      "Download bytes with:\n" +
      '  sentry api "<attachments[].download>" > file',
  },
  output: {
    human: formatEventView,
    jsonTransform: jsonTransformEventView,
    schema: EventViewOutputSchema,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "org/project/event-id",
        brief:
          "[<org>/<project>] <event-id> [<event-id>...] - Target (optional) and one or more event IDs",
        parse: String,
      },
    },
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
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const log = logger.withTag("event.view");

    // Expand newline-separated args — agents paste multiple event IDs
    // as a single newline-separated argument (CLI-1HT).
    const expandedArgs = expandNewlineArgs(args);

    // Parse positional args
    const parsedArgs = parsePositionalArgs(expandedArgs);
    if (parsedArgs.warning) {
      log.warn(parsedArgs.warning);
    }
    const { targetArg, issueId, issueShortId, extraEventIds } = parsedArgs;
    let { eventId } = parsedArgs;

    const parsed = parseOrgProjectArg(targetArg);

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

    // Validate + attempt recovery. `skipValidation` is true when the ID is
    // the LATEST_EVENT_SENTINEL or when resolveIssueShortcut already handled
    // the request (issueId / issueShortId paths).
    const skipValidation =
      eventId === LATEST_EVENT_SENTINEL ||
      issueId !== undefined ||
      issueShortId !== undefined;
    eventId = await validateAndRecoverEventId(eventId, parsed, skipValidation);

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
