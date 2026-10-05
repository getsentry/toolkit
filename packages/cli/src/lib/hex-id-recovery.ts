/**
 * Hex ID Recovery
 *
 * Attempts to recover from malformed hex ID inputs that `validateHexId`
 * rejects. Follows the AGENTS.md UX principle: "do the intent, gently nudge".
 *
 * Pipeline (cheapest first):
 *
 * 1. **Syntactic strip** — `<full-hex><non-hex junk>` → drop junk and
 *    return the prefix. Pure, no API calls.
 * 2. **Cross-entity redirect** — input is a valid ID of a *different*
 *    entity type (e.g., 16-char span passed to `trace view`) → look up
 *    the parent/related entity via the API.
 * 3. **Fuzzy prefix lookup** — input has a ≥8-hex prefix (optionally
 *    with a middle-ellipsis suffix) → scan recent entities in the
 *    configured project and filter client-side.
 *
 * On unrecoverable input, returns a structured failure with classification
 * (sentinel leak, looks-like-slug, too-short, no-matches, multiple-matches,
 * over-nested, api-error, past-retention) so the command layer can produce
 * a targeted error.
 *
 * Regex/const primitives live in `hex-id.ts` and `retention.ts` — this
 * module only owns the recovery-specific control flow.
 */

import { addBreadcrumb } from "@sentry/node-core/light";

import type { SpanListItem } from "../types/index.js";
import { listLogs, listSpans, queryEvents } from "./api-client.js";
import {
  type ParsedOrgProject,
  ProjectSpecificationType,
} from "./arg-parsing.js";
import { AuthError, ResolutionError, ValidationError } from "./errors.js";
import type { HexEntityType } from "./hex-id.js";
import {
  ALPHA_SEGMENT_RE,
  ageInDaysFromUuidV7,
  decodeUuidV7Timestamp,
  HEX_ID_RE,
  LEADING_HEX_CHAR_RE,
  LEADING_HEX_RE,
  MIDDLE_ELLIPSIS_RE,
  NON_HEX_RE,
  PURE_HEX_RE,
  SPAN_ID_RE,
  UUID_DASH_RE,
} from "./hex-id.js";
import { logger } from "./logger.js";
import { resolveEffectiveOrg } from "./region.js";
import { RETENTION_DAYS, SCAN_PERIODS } from "./retention.js";

const log = logger.withTag("hex-id-recovery");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// `HexEntityType` lives in `./hex-id.js` so `retention.ts` and other
// low-level modules can reference it without circular type dependencies.
// Re-exported here for callers that already import from this module.
export type { HexEntityType } from "./hex-id.js";

/**
 * Extracted prefix/suffix from a raw malformed input.
 * `suffix` is only populated when the input contained a middle ellipsis.
 */
export type HexCandidate = {
  prefix: string;
  suffix?: string;
};

/** Why recovery failed (for targeted error messages). */
export type RecoveryFailureReason =
  | "too-short"
  | "no-matches"
  | "multiple-matches"
  | "api-error"
  | "sentinel-leak"
  | "looks-like-slug"
  | "over-nested"
  | "past-retention";

/**
 * Result of attempting to recover a malformed hex ID.
 *
 * - `stripped`: input was `<valid-id><trailing-junk>`; returned the valid ID.
 * - `fuzzy`: input was a hex prefix; found exactly one match via API.
 * - `redirect`: input was a valid ID of a different entity type; the command
 *   layer should re-target (e.g., 16-char span ID → use span's parent trace).
 * - `failed`: recovery not possible; `reason` classifies why and `candidates`
 *   lists ambiguous matches (for `multiple-matches`).
 */
export type RecoveryResult =
  | { kind: "stripped"; id: string; original: string; stripped: string }
  | {
      kind: "fuzzy";
      id: string;
      original: string;
      prefix: string;
      suffix?: string;
    }
  | {
      kind: "redirect";
      id: string;
      original: string;
      fromEntity: HexEntityType;
      toEntity: HexEntityType;
    }
  | {
      kind: "failed";
      original: string;
      reason: RecoveryFailureReason;
      candidates?: string[];
      hint?: string;
    };

/** Context for adapter API calls. */
export type LookupContext = {
  org: string;
  /** When present, scopes the scan to a single project. */
  project?: string;
  /** Required for span lookup (spans are unique only within a trace). */
  traceId?: string;
  /** Override for the default scan window (e.g. "90d", "7d"). */
  period?: string;
};

/** Context passed by command code to produce consistent warnings/errors. */
export type HandleRecoveryOptions = {
  /** Entity label for warnings (e.g., "event", "trace"). */
  entityType: HexEntityType;
  /**
   * Canonical command template with `<id>` placeholder. Used in the
   * `multiple-matches` `ResolutionError` and hints.
   * Example: `sentry event view <org>/<project>/<id>`.
   */
  canonicalCommand: string;
  /** Logger tag (e.g., "event.view"). */
  logTag: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum hex prefix length to attempt a fuzzy API lookup. */
export const MIN_FUZZY_PREFIX = 8;

/** Max candidates surfaced to the user in a `multiple-matches` error. */
const MAX_CANDIDATES = 5;

/** Page size for fuzzy-lookup API scans. */
const SCAN_LIMIT = 100;

/** Larger page size for logs — high-volume, sparse matches. */
const LOG_SCAN_LIMIT = 1000;

/** Sentinel strings produced by common shell/pipeline leaks. */
const SENTINEL_VALUES: ReadonlySet<string> = new Set([
  "null",
  "undefined",
  "nan",
  "none",
  "nil",
  "latest",
  "@latest",
  "get",
  "false",
  "true",
  "n/a",
]);

/** URL-fragment prefixes that precede a raw ID in Sentry URLs. */
const URL_FRAGMENT_PREFIXES = ["span-", "txn-", "event-", "trace-"] as const;

/** Threshold (slash-separated segments) above which a path is "over-nested". */
const OVER_NESTED_MIN_SEGMENTS = 4;

/** Per-command slug redirect hints (used by the `looks-like-slug` branch). */
const SLUG_REDIRECT_COMMAND: Record<HexEntityType, string> = {
  event: "sentry issue list",
  trace: "sentry trace list",
  log: "sentry log list",
  // Spans are trace-scoped — a slug-only input can't map to a list command.
  span: "",
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Pre-normalize a raw input before further analysis. Pipeline:
 *
 * 1. Trim whitespace and lowercase.
 * 2. Peel URL-fragment prefixes (`span-`, `txn-`, `event-`, `trace-`)
 *    repeatedly until none apply. The loop ensures idempotence for
 *    pathological inputs like `span-span-abc`.
 * 3. If the result matches a shell/pipeline sentinel (`null`, `latest`,
 *    …), short-circuit with `sentinel` set — runs AFTER prefix-stripping
 *    so inputs like `span-null` (shell leak via a URL builder) are
 *    classified correctly.
 * 4. If the result is a full UUID (8-4-4-4-12), strip dashes and return.
 * 5. Otherwise strip partial-UUID dashes ONLY when the dashless result
 *    starts with a hex digit — avoids silently mangling slug-like inputs
 *    (e.g., `human-interfaces` stays intact because `h` isn't hex).
 */
export function preNormalize(input: string): {
  cleaned: string;
  sentinel?: string;
} {
  const lowered = input.trim().toLowerCase();

  // Strip URL fragment prefixes repeatedly so the function is idempotent.
  // A pathological double-prefixed input like `span-span-abc` would otherwise
  // strip only the outer `span-` and leave the inner prefix in place, which
  // breaks `preNormalize(preNormalize(x)) === preNormalize(x)`.
  let cleaned = lowered;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of URL_FRAGMENT_PREFIXES) {
      if (cleaned.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length);
        stripped = true;
        break;
      }
    }
  }

  // Sentinel check runs AFTER URL-prefix stripping so inputs like
  // `span-null` (shell variable leak through a URL-builder) surface as
  // a sentinel rather than a misleading "looks like a slug" error.
  if (SENTINEL_VALUES.has(cleaned)) {
    return { cleaned, sentinel: cleaned };
  }

  if (UUID_DASH_RE.test(cleaned)) {
    return { cleaned: cleaned.replaceAll("-", "") };
  }

  if (cleaned.includes("-")) {
    const dashless = cleaned.replaceAll("-", "");
    if (LEADING_HEX_CHAR_RE.test(dashless)) {
      cleaned = dashless;
    }
  }

  return { cleaned };
}

/**
 * Strip trailing non-hex chars and return the hex prefix **only when** the
 * result matches `expectedLen` exactly AND the stripped tail actually
 * contains non-hex characters. Returns null when:
 *
 * - the input is already ≤ `expectedLen` (nothing to strip);
 * - the leading hex run is shorter than `expectedLen`;
 * - the input starts with a non-hex char;
 * - the entire input is valid hex (the tail is all hex). This last case
 *   prevents silently truncating a 32-char trace ID to a 16-char "span ID"
 *   when the caller passes the wrong entity type — `validateSpanId` has a
 *   dedicated "looks like a trace ID" hint for that scenario.
 *
 * @example
 * stripTrailingNonHex("c0a5a9d4dce44358ab4231fc3bead7e9ios", 32)
 * // → { hex: "c0a5a9d4dce44358ab4231fc3bead7e9", stripped: "ios" }
 * stripTrailingNonHex("<32 hex chars>", 16)
 * // → null (all hex; would silently truncate a trace ID to a span ID)
 */
export function stripTrailingNonHex(
  input: string,
  expectedLen: 32 | 16
): { hex: string; stripped: string } | null {
  if (input.length <= expectedLen) {
    return null;
  }
  const match = input.match(LEADING_HEX_RE);
  if (!match || match[0].length < expectedLen) {
    return null;
  }
  const stripped = input.slice(expectedLen);
  // Require at least one non-hex char in the stripped tail, otherwise we'd
  // be truncating a longer valid hex ID (likely a wrong-entity-type input).
  if (!NON_HEX_RE.test(stripped)) {
    return null;
  }
  return {
    hex: match[0].slice(0, expectedLen),
    stripped,
  };
}

/**
 * Extract a prefix (and optional suffix from middle ellipsis) from the
 * input. Returns null when there's no leading hex run.
 *
 * @example
 * extractHexCandidate("abc123...def456")
 * // → { prefix: "abc123", suffix: "def456" }
 */
export function extractHexCandidate(input: string): HexCandidate | null {
  const ellipsisMatch = input.match(MIDDLE_ELLIPSIS_RE);
  if (ellipsisMatch) {
    const [, prefix = "", suffix = ""] = ellipsisMatch;
    if (!(prefix || suffix)) {
      return null;
    }
    return suffix ? { prefix, suffix } : { prefix };
  }
  const prefixMatch = input.match(LEADING_HEX_RE);
  if (!prefixMatch) {
    return null;
  }
  return { prefix: prefixMatch[0] };
}

/**
 * Heuristic: does the input "look like" a project slug a user mistakenly
 * passed as a hex ID? Slugs contain dashes AND at least one 2+ letter
 * alphabetic segment. Pure hex prefixes (even with a spurious dash) are
 * recoverable via fuzzy lookup and must NOT match.
 */
export function looksLikeSlug(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.includes("/")) {
    return false;
  }
  if (trimmed.length < 3 || !trimmed.includes("-")) {
    return false;
  }
  if (!trimmed.split("-").some((s) => ALPHA_SEGMENT_RE.test(s))) {
    return false;
  }
  const dashless = trimmed.replaceAll("-", "");
  return !(PURE_HEX_RE.test(dashless) && dashless.length >= MIN_FUZZY_PREFIX);
}

/** Returns true for paths with 4+ slash-separated non-empty segments. */
export function isOverNestedPath(input: string): boolean {
  return input.split("/").filter(Boolean).length >= OVER_NESTED_MIN_SEGMENTS;
}

/**
 * Extract recovery context from a parsed org/project target.
 *
 * Shared by command-layer wrappers that need to feed `recoverHexId` an
 * `{org, project?}` context. Only returns a concrete value for `explicit`
 * and `org-all` modes — `project-search` and `auto-detect` deliberately
 * return null because kicking off DSN auto-detection or cross-org project
 * search during recovery would be expensive, and the cheap local
 * classifications inside `recoverHexId` run fine without an org anyway.
 *
 * Routes through {@link resolveEffectiveOrg} to normalize DSN-style
 * numeric org IDs (e.g. `o1081365`) to slugs — otherwise fuzzy-adapter
 * API calls silently 404 on numeric orgs.
 *
 * Swallows non-auth errors defensively: a secondary resolution failure
 * during recovery must never mask the original validation error.
 * AuthError is re-thrown so the auto-login flow still triggers.
 */
export async function resolveRecoveryOrg(
  parsed: ParsedOrgProject
): Promise<{ org: string; project?: string } | null> {
  try {
    switch (parsed.type) {
      case ProjectSpecificationType.Explicit:
        return {
          org: await resolveEffectiveOrg(parsed.org),
          project: parsed.project,
        };
      case ProjectSpecificationType.OrgAll:
        return { org: await resolveEffectiveOrg(parsed.org) };
      case ProjectSpecificationType.ProjectSearch:
      case ProjectSpecificationType.AutoDetect:
        return null;
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// UUIDv7 retention check
// ---------------------------------------------------------------------------

/**
 * If `input` is a UUIDv7 whose creation timestamp exceeds the entity's hard
 * retention window, return a `past-retention` result. Otherwise null — the
 * caller falls through to the regular no-match flow.
 *
 * Only `log` has a known hard retention cap (90 days, all plans). Traces
 * and events have plan-dependent retention, so we can't speak with
 * certainty about them and return null.
 */
function checkRetentionExpiry(
  input: string,
  entityType: HexEntityType
): RecoveryResult | null {
  const retentionDays = RETENTION_DAYS[entityType];
  if (retentionDays === null) {
    return null;
  }
  const age = ageInDaysFromUuidV7(input);
  if (age === null || age <= retentionDays) {
    return null;
  }
  const decoded = decodeUuidV7Timestamp(input);
  const createdIso = decoded?.createdAt.toISOString().slice(0, 10) ?? "unknown";
  const entityCap = entityType.charAt(0).toUpperCase() + entityType.slice(1);
  return {
    kind: "failed",
    original: input,
    reason: "past-retention",
    hint:
      `${entityCap} ${input} was created ${createdIso} ` +
      `(${Math.floor(age)} days ago), past the ${retentionDays}-day ` +
      `${entityType} retention window. This ${entityType} is no longer available.`,
  };
}

// ---------------------------------------------------------------------------
// Fuzzy lookup adapters
// ---------------------------------------------------------------------------

/**
 * Adapter signature: scan recent entities in the configured project and
 * return the IDs (event, trace, log, span) as strings. Empty array when no
 * data. Propagates AuthError; other errors become `api-error` at the call
 * site.
 */
export type FuzzyLookupAdapter = (ctx: LookupContext) => Promise<string[]>;

/** Deduplicate while preserving order, then filter by prefix + suffix. */
function filterByCandidate(ids: string[], candidate: HexCandidate): string[] {
  const unique = Array.from(new Set(ids));
  return unique.filter(
    (id) =>
      id.startsWith(candidate.prefix) &&
      (!candidate.suffix || id.endsWith(candidate.suffix))
  );
}

const eventAdapter: FuzzyLookupAdapter = async (ctx) => {
  if (!(ctx.org && ctx.project)) {
    return [];
  }
  const { data } = await queryEvents(ctx.org, {
    dataset: "errors",
    fields: ["id"],
    query: `project:${ctx.project}`,
    limit: SCAN_LIMIT,
    sort: "-timestamp",
    statsPeriod: ctx.period ?? SCAN_PERIODS.event,
  });
  return data.data.map((row) => String(row.id ?? "")).filter(Boolean);
};

const traceAdapter: FuzzyLookupAdapter = async (ctx) => {
  if (!(ctx.org && ctx.project)) {
    return [];
  }
  const { data } = await listSpans(ctx.org, ctx.project, {
    limit: SCAN_LIMIT,
    statsPeriod: ctx.period ?? SCAN_PERIODS.trace,
    sort: "date",
  });
  return (data as SpanListItem[]).map((s) => s.trace);
};

const logAdapter: FuzzyLookupAdapter = async (ctx) => {
  if (!(ctx.org && ctx.project)) {
    return [];
  }
  const logs = await listLogs(ctx.org, ctx.project, {
    limit: LOG_SCAN_LIMIT,
    statsPeriod: ctx.period ?? SCAN_PERIODS.log,
    sort: "newest",
  });
  return logs.map((l) => l["sentry.item_id"]);
};

const spanAdapter: FuzzyLookupAdapter = async (ctx) => {
  if (!(ctx.org && ctx.traceId && ctx.project)) {
    return [];
  }
  const { data } = await listSpans(ctx.org, ctx.project, {
    limit: SCAN_LIMIT,
    query: `trace:${ctx.traceId}`,
    statsPeriod: ctx.period ?? SCAN_PERIODS.span,
    sort: "date",
  });
  return (data as SpanListItem[]).map((s) => s.id);
};

/** Registry of adapters by entity type. Mutable so tests can stub. */
export const ADAPTERS: Record<HexEntityType, FuzzyLookupAdapter> = {
  event: eventAdapter,
  trace: traceAdapter,
  log: logAdapter,
  span: spanAdapter,
};

/**
 * Look up a span by its full ID to find the parent trace ID. Used for
 * cross-entity redirect when a user passes a span ID to `trace view`.
 */
async function findTraceBySpanId(
  spanId: string,
  ctx: LookupContext
): Promise<string | null> {
  if (!(ctx.org && ctx.project)) {
    return null;
  }
  const { data } = await listSpans(ctx.org, ctx.project, {
    limit: 10,
    query: `id:${spanId}`,
    statsPeriod: ctx.period ?? SCAN_PERIODS.span,
  });
  return (data as SpanListItem[])[0]?.trace ?? null;
}

// ---------------------------------------------------------------------------
// Failure-result builders (data-driven where possible)
// ---------------------------------------------------------------------------

/**
 * Format a slug-redirect hint: the input looks like a project slug, so
 * nudge the user toward the corresponding `<entity> list` command.
 */
function buildSlugHint(
  input: string,
  entityType: HexEntityType,
  org: string
): string {
  const orgPart = org ? `${org}/` : "<org>/";
  const cmd = SLUG_REDIRECT_COMMAND[entityType];
  if (cmd) {
    return `'${input}' looks like a project slug, not a ${entityType} ID. Try: ${cmd} ${orgPart}${input}`;
  }
  return `'${input}' looks like a project slug, not a ${entityType} ID. Spans are identified by 16 hex chars within a trace.`;
}

/**
 * Format a "no matching prefix" hint.
 *
 * For logs we state the scan-window boundary AND the retention cap
 * separately because they differ (scan caps at 30d due to degraded API
 * behavior above that window, retention is 90d). A log 30-90 days old
 * is *within retention* but *outside the scan window* — the hint must
 * tell the user to pass the full ID in that case instead of suggesting
 * the log is gone.
 *
 * Traces/events use plan-dependent retention (null in RETENTION_DAYS),
 * so we speak only about scan window. Spans are trace-scoped; no window
 * to mention.
 */
function buildNoMatchHint(
  entityType: HexEntityType,
  period: string | undefined
): string {
  const window = period ?? SCAN_PERIODS[entityType];
  const retention = RETENTION_DAYS[entityType];
  if (entityType === "log" && retention !== null) {
    return (
      `No log matched this prefix in the last ${window}. ` +
      `Prefix lookups are limited to ${window}; logs are retained for up to ${retention} days — ` +
      `pass the full 32-character ID to look up a log older than ${window}.`
    );
  }
  if (entityType === "span") {
    return "No span matched this prefix within the trace.";
  }
  if (entityType === "event") {
    return (
      `No event matched this prefix in the last ${window}. ` +
      "Sentry cannot search by a partial event ID — pass the full " +
      "32-character ID printed by `sentry event list`."
    );
  }
  return (
    `No ${entityType} matched this prefix in the last ${window}. ` +
    `The ID format is valid but no matching ${entityType} exists in this project — ` +
    `check that you're querying the right org/project, or pass the full ID if older than ${window}.`
  );
}

/**
 * Build the appropriate CliError for a `failed` recovery result.
 *
 * Error class picks follow the AGENTS.md convention:
 *
 * - {@link ResolutionError} — the user **provided** a value that couldn't
 *   be found/resolved (`multiple-matches`, `no-matches`, `past-retention`,
 *   `looks-like-slug`).
 * - {@link ValidationError} — the input is **malformed** (`sentinel-leak`,
 *   `over-nested`, `too-short`).
 * - `api-error` — recovery itself couldn't run, so we surface the strict
 *   validator's original error unchanged.
 */
function buildRecoveryError(
  result: Extract<RecoveryResult, { kind: "failed" }>,
  fallbackError: Error,
  options: HandleRecoveryOptions
): Error {
  const entityCap =
    options.entityType.charAt(0).toUpperCase() + options.entityType.slice(1);

  switch (result.reason) {
    case "multiple-matches": {
      const candidates = result.candidates ?? [];
      return new ResolutionError(
        `${entityCap} prefix '${result.original}'`,
        `matches ${candidates.length} ${options.entityType}s`,
        `Re-run with more characters or the full ID: ${options.canonicalCommand}`,
        candidates.map((c) => options.canonicalCommand.replace("<id>", c))
      );
    }
    case "no-matches":
    case "past-retention":
    case "looks-like-slug":
      return new ResolutionError(
        `${entityCap} '${result.original}'`,
        failedReasonHeadline(result.reason),
        options.canonicalCommand,
        result.hint ? [result.hint] : []
      );
    case "api-error":
      return fallbackError;
    case "sentinel-leak":
    case "over-nested":
    case "too-short": {
      const base = fallbackError.message;
      const hint = result.hint ?? "";
      return new ValidationError(hint ? `${base}\n\n${hint}` : base);
    }
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
}

/** Short headline describing why resolution failed, for ResolutionError. */
function failedReasonHeadline(
  reason: "no-matches" | "past-retention" | "looks-like-slug"
): string {
  switch (reason) {
    case "no-matches":
      return "not found";
    case "past-retention":
      return "is past retention";
    case "looks-like-slug":
      return "is not a valid ID";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Always returns a structured result. The command layer renders warnings
 * and errors via {@link handleRecoveryResult}. A telemetry breadcrumb is
 * emitted for every recovery attempt so we can track which recovery
 * classes actually fire in the wild.
 */
export async function recoverHexId(
  input: string,
  entityType: HexEntityType,
  ctx: LookupContext
): Promise<RecoveryResult> {
  const result = await recoverHexIdInternal(input, entityType, ctx);
  recordRecoveryOutcome(entityType, input, result);
  return result;
}

/**
 * Emit a Sentry breadcrumb so we can correlate recovery outcomes with
 * the CLI-16G / CLI-M0 / CLI-EQ issue classes. No PII — the prefix is a
 * hex substring, not a user slug.
 */
function recordRecoveryOutcome(
  entityType: HexEntityType,
  input: string,
  result: RecoveryResult
): void {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    addBreadcrumb({
      category: "hex_id_recovery",
      type: "info",
      level: result.kind === "failed" ? "warning" : "info",
      message: `recovery ${result.kind}`,
      data: {
        entityType,
        resultKind: result.kind,
        inputLength: input.length,
        ...(result.kind === "failed" && { failureReason: result.reason }),
        ...(result.kind === "fuzzy" && {
          prefixLength: result.prefix.length,
          hadSuffix: Boolean(result.suffix),
        }),
      },
    });
  } catch {
    // Sentry may not be initialized (e.g. in tests); breadcrumb is
    // best-effort and must never throw into the recovery path.
  }
}

/**
 * Core decision tree for {@link recoverHexId}. Kept separate so the
 * wrapper can unconditionally record a breadcrumb without cluttering
 * every return statement.
 */
async function recoverHexIdInternal(
  input: string,
  entityType: HexEntityType,
  ctx: LookupContext
): Promise<RecoveryResult> {
  const expectedLen: 32 | 16 = entityType === "span" ? 16 : 32;
  const { cleaned, sentinel } = preNormalize(input);

  if (sentinel) {
    return {
      kind: "failed",
      original: input,
      reason: "sentinel-leak",
      hint: `'${sentinel}' is not a hex ${entityType} ID — this often means a shell variable or pipeline value was empty.`,
    };
  }
  if (isOverNestedPath(cleaned)) {
    return {
      kind: "failed",
      original: input,
      reason: "over-nested",
      hint: "Use exactly <org>/<project>/<id>; extra path segments are not supported.",
    };
  }

  // If pre-normalization already produced a valid full-length ID, return
  // it directly — no need to scan. Happens when the input differs only by
  // URL-fragment prefix or UUID dashes from a valid hex.
  const preNormalized = tryPreNormalizedValidId(input, cleaned, entityType);
  if (preNormalized) {
    return preNormalized;
  }

  const stripped = stripTrailingNonHex(cleaned, expectedLen);
  if (stripped) {
    // When the stripped ID is a UUIDv7 past retention, the user will hit
    // a definite "not found" downstream. Surface that up front instead of
    // returning a hex ID that only leads to a 404.
    const expired = checkRetentionExpiry(stripped.hex, entityType);
    if (expired) {
      return expired;
    }
    return {
      kind: "stripped",
      id: stripped.hex,
      original: input,
      stripped: stripped.stripped,
    };
  }

  const redirect = await tryCrossEntityRedirect(cleaned, entityType, ctx);
  if (redirect) {
    return redirect;
  }

  // Slug-shape check on the RAW input before fuzzy lookup. Slug-like
  // inputs where the dashless form happens to start with enough hex
  // chars (e.g. `cafe-babe-app` → `cafebabeapp`) would otherwise reach
  // runFuzzyLookup and waste an API call on a clearly-mistaken input.
  if (looksLikeSlug(input)) {
    return {
      kind: "failed",
      original: input,
      reason: "looks-like-slug",
      hint: buildSlugHint(input, entityType, ctx.org),
    };
  }

  const candidate = extractHexCandidate(cleaned);
  const longEnough =
    candidate !== null &&
    (candidate.prefix.length >= MIN_FUZZY_PREFIX ||
      (candidate.suffix?.length ?? 0) >= MIN_FUZZY_PREFIX);
  if (!(longEnough && candidate)) {
    // Raw-input slug check already ran above; here it's either a short
    // pure-hex prefix or a short non-hex blob — neither is a slug.
    return {
      kind: "failed",
      original: input,
      reason: "too-short",
      hint: `Need at least ${MIN_FUZZY_PREFIX} hex chars of the ${entityType} ID to attempt recovery.`,
    };
  }

  return runFuzzyLookup(input, entityType, candidate, ctx);
}

/**
 * If `cleaned` is already a valid full-length hex ID of the expected type
 * but differs from the raw input (after trim+lowercase), return a stripped
 * result immediately. Prevents a valid ID from falling through to fuzzy
 * lookup just because the user prefixed it with `span-` etc.
 *
 * Building an accurate `stripped` field is tricky when pre-normalization
 * removed both a URL-fragment prefix AND UUID dashes (the dashless
 * `cleaned` isn't a literal substring of the dashed `lowered`). Rather
 * than reconstruct the removed pieces, we report the raw difference in
 * the raw input vs the cleaned result — good enough for the warning
 * message, and the recovered ID is always correct regardless.
 */
function tryPreNormalizedValidId(
  input: string,
  cleaned: string,
  entityType: HexEntityType
): RecoveryResult | null {
  const expectedRe = entityType === "span" ? SPAN_ID_RE : HEX_ID_RE;
  const lowered = input.trim().toLowerCase();
  if (cleaned === lowered || !expectedRe.test(cleaned)) {
    return null;
  }
  const retention = checkRetentionExpiry(cleaned, entityType);
  if (retention) {
    return retention;
  }
  return {
    kind: "stripped",
    id: cleaned,
    original: input,
    stripped: describeStrippedParts(lowered, cleaned),
  };
}

/**
 * Produce a human-readable description of what was removed from `raw` to
 * get `cleaned`. Returns the exact substring diff when possible (a simple
 * substring match); otherwise a summary of the transformation (URL prefix
 * layers, UUID dashes, or both).
 *
 * Mirrors the peel-loop in {@link preNormalize} so nested prefixes like
 * `span-span-abc` report "span- + span-" rather than just the outer one.
 */
function describeStrippedParts(raw: string, cleaned: string): string {
  // Simple case: cleaned is a substring of raw — return the concatenation
  // of everything outside that substring.
  const idx = raw.indexOf(cleaned);
  if (idx !== -1) {
    return raw.slice(0, idx) + raw.slice(idx + cleaned.length);
  }
  // Mixed case: both URL prefix(es) AND internal dashes were stripped, so
  // cleaned isn't a literal substring. Peel prefixes layer-by-layer so
  // we report every one that was stripped.
  const parts: string[] = [];
  let remaining = raw;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of URL_FRAGMENT_PREFIXES) {
      if (remaining.startsWith(prefix)) {
        parts.push(prefix);
        remaining = remaining.slice(prefix.length);
        stripped = true;
        break;
      }
    }
  }
  if (remaining.includes("-")) {
    parts.push("UUID dashes");
  }
  return parts.length > 0 ? parts.join(" + ") : "formatting";
}

/**
 * Cross-entity redirect: currently only `trace view` given a valid 16-hex
 * span ID. `span view` given a 32-hex trace ID is handled at the command
 * level (it already has a targeted ContextError path).
 */
async function tryCrossEntityRedirect(
  cleaned: string,
  entityType: HexEntityType,
  ctx: LookupContext
): Promise<RecoveryResult | null> {
  // `SPAN_ID_RE` matches exactly 16 hex chars, so the earlier guard
  // already rules out 32-char trace IDs — no separate `HEX_ID_RE` check
  // needed.
  if (entityType !== "trace" || !SPAN_ID_RE.test(cleaned)) {
    return null;
  }
  try {
    const trace = await findTraceBySpanId(cleaned, ctx);
    if (trace) {
      return {
        kind: "redirect",
        id: trace,
        original: cleaned,
        fromEntity: "span",
        toEntity: "trace",
      };
    }
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    log.debug(
      `Cross-entity lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return null;
}

/** Call the registered adapter and shape the result into a RecoveryResult. */
async function runFuzzyLookup(
  input: string,
  entityType: HexEntityType,
  candidate: HexCandidate,
  ctx: LookupContext
): Promise<RecoveryResult> {
  let raw: string[];
  try {
    raw = await ADAPTERS[entityType](ctx);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    log.debug(
      `Fuzzy ${entityType} lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { kind: "failed", original: input, reason: "api-error" };
  }

  const filtered = filterByCandidate(raw, candidate);
  if (filtered.length === 0) {
    return {
      kind: "failed",
      original: input,
      reason: "no-matches",
      hint: buildNoMatchHint(entityType, ctx.period),
    };
  }
  if (filtered.length > 1) {
    return {
      kind: "failed",
      original: input,
      reason: "multiple-matches",
      candidates: filtered.slice(0, MAX_CANDIDATES),
    };
  }
  // `filtered.length === 1` by elimination; the non-null assertion here
  // is safe and keeps TypeScript's `noUncheckedIndexedAccess` happy.
  // biome-ignore lint/style/noNonNullAssertion: exactly one element after the checks above
  const id = filtered[0]!;
  return {
    kind: "fuzzy",
    id,
    original: input,
    prefix: candidate.prefix,
    ...(candidate.suffix ? { suffix: candidate.suffix } : {}),
  };
}

// ---------------------------------------------------------------------------
// Command-layer helper: unwrap a RecoveryResult and emit warnings
// ---------------------------------------------------------------------------

/**
 * Unwrap a {@link RecoveryResult} and produce a validated ID or throw a
 * structured error. Centralizes the warn/error behavior so every command
 * behaves identically.
 *
 * - `stripped` / `fuzzy` / `redirect` → emit a `log.warn` describing the
 *   recovery, return the usable ID.
 * - `failed` → throw the appropriate {@link ValidationError} or
 *   {@link ResolutionError} based on the classification.
 */
export function handleRecoveryResult(
  result: RecoveryResult,
  fallbackError: Error,
  options: HandleRecoveryOptions
): string {
  const scoped = logger.withTag(options.logTag);
  switch (result.kind) {
    case "stripped":
      scoped.warn(
        `Stripped trailing '${result.stripped}' from ${options.entityType} ID. Using ${result.id}.`
      );
      return result.id;
    case "fuzzy": {
      const via = result.suffix
        ? `prefix ${result.prefix}…${result.suffix}`
        : `prefix ${result.prefix}`;
      scoped.warn(
        `Interpreting '${result.original}' as ${options.entityType} ${result.id} (matched ${via}).`
      );
      return result.id;
    }
    case "redirect":
      scoped.warn(
        `'${result.original}' is a ${result.fromEntity} ID, not a ${result.toEntity} ID. Using the associated ${result.toEntity} ${result.id}.`
      );
      return result.id;
    case "failed":
      throw buildRecoveryError(result, fallbackError, options);
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
