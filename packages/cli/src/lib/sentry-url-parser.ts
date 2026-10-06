/**
 * Sentry URL Parser
 *
 * Extracts org, project, issue, event, replay, and trace identifiers from Sentry web URLs.
 * Supports both SaaS (*.sentry.io) and self-hosted instances.
 *
 * For self-hosted URLs, also configures the SENTRY_URL environment variable
 * so that subsequent API calls reach the correct instance.
 */

import { DEFAULT_SENTRY_HOST } from "./constants.js";
import { getEnv } from "./env.js";
import { HostScopeError } from "./errors.js";
import { tryNormalizeHexId } from "./hex-id.js";
import { logger } from "./logger.js";
import { isSaaSTrustOrigin } from "./sentry-urls.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

const log = logger.withTag("url-parser");

const FEEDBACK_SLUG_RE = /^([a-z0-9][a-z0-9_-]*):(\d+)$/i;

/**
 * Components extracted from a Sentry web URL.
 *
 * `baseUrl` is always present. `org` is present for most URL patterns but
 * absent for share URLs on bare domains (e.g., `sentry.io/share/issue/...`).
 * All other fields are optional — presence depends on which URL pattern
 * was matched.
 */
export type ParsedSentryUrl = {
  /** Scheme + host of the Sentry instance (e.g., "https://sentry.io" or "https://sentry.example.com") */
  baseUrl: string;
  /** Organization slug from the URL path or subdomain (absent for share URLs without org context) */
  org?: string;
  /** Issue identifier — numeric group ID (e.g., "32886") or short ID (e.g., "CLI-G") */
  issueId?: string;
  /** Event ID from /issues/{id}/events/{eventId}/ paths */
  eventId?: string;
  /** Project slug from /settings/{org}/projects/{project}/ paths */
  project?: string;
  /** Trace ID from /organizations/{org}/traces/{traceId}/ paths */
  traceId?: string;
  /** Replay ID from replay detail URLs */
  replayId?: string;
  /** Share ID from /share/issue/{shareId}/ paths (32-char hex string) */
  shareId?: string;
  /** Dashboard ID from /dashboard/{id}/ paths (numeric string) */
  dashboardId?: string;
};

/**
 * Try to match /organizations/{org}/... path patterns.
 *
 * @returns Parsed result or null if pattern doesn't match
 */
function matchOrganizationsPath(
  baseUrl: string,
  segments: string[],
  searchParams: URLSearchParams
): ParsedSentryUrl | null {
  if (segments[0] !== "organizations" || !segments[1]) {
    return null;
  }

  const org = segments[1];

  // /organizations/{org}/issues/{id}/ (optionally with /events/{eventId}/)
  if (segments[2] === "issues" && segments[3]) {
    const eventId =
      segments[4] === "events" && segments[5] ? segments[5] : undefined;
    return { baseUrl, org, issueId: segments[3], eventId };
  }

  if (segments[2] === "share" && segments[3] === "issue" && segments[4]) {
    return { baseUrl, org, shareId: segments[4] };
  }

  const tracePath = matchTracePath(segments, 2);
  if (tracePath.status === "detail") {
    return { baseUrl, org, traceId: tracePath.traceId };
  }

  const replayPath = matchReplayPath(segments, 2);
  if (replayPath.status === "detail") {
    return { baseUrl, org, replayId: replayPath.replayId };
  }
  if (replayPath.status === "invalid") {
    return null;
  }

  const feedbackPath = matchFeedbackPath(segments, 2, searchParams);
  if (feedbackPath) {
    return { baseUrl, org, ...feedbackPath };
  }

  // /organizations/{org}/dashboard/{id}/
  if (segments[2] === "dashboard" && segments[3]) {
    return { baseUrl, org, dashboardId: segments[3] };
  }

  // /organizations/{org}/ (org only)
  return { baseUrl, org };
}

/**
 * Try to match /settings/{org}/projects/{project}/ path pattern.
 *
 * @returns Parsed result or null if pattern doesn't match
 */
function matchSettingsPath(
  baseUrl: string,
  segments: string[]
): ParsedSentryUrl | null {
  if (
    segments[0] !== "settings" ||
    !segments[1] ||
    segments[2] !== "projects" ||
    !segments[3]
  ) {
    return null;
  }

  return { baseUrl, org: segments[1], project: segments[3] };
}

/**
 * Match the path portion of a SaaS subdomain-style URL against known patterns.
 *
 * Extracts entity-specific fields (issueId, traceId, dashboardId, etc.)
 * from the path segments. Returns a partial result to merge with org/baseUrl,
 * or null if no pattern matches.
 */
function matchSubdomainPath(
  segments: string[],
  searchParams: URLSearchParams
): Omit<ParsedSentryUrl, "baseUrl" | "org"> | null {
  // /issues/{id}/ (optionally with /events/{eventId}/)
  if (segments[0] === "issues" && segments[1]) {
    const eventId =
      segments[2] === "events" && segments[3] ? segments[3] : undefined;
    return { issueId: segments[1], eventId };
  }
  const tracePath = matchTracePath(segments, 0);
  if (tracePath.status === "detail") {
    return { traceId: tracePath.traceId };
  }
  if (tracePath.status === "list") {
    // A bare trace list URL (e.g. `/explore/traces/`) resolves to the org,
    // matching the replay-list behavior below.
    return {};
  }

  const replayPath = matchReplayPath(segments, 0);
  if (replayPath.status === "detail") {
    return { replayId: replayPath.replayId };
  }
  if (replayPath.status === "invalid") {
    return null;
  }
  if (replayPath.status === "list") {
    return {};
  }
  return matchSubdomainTailPath(segments, searchParams);
}

function matchSubdomainTailPath(
  segments: string[],
  searchParams: URLSearchParams
): Omit<ParsedSentryUrl, "baseUrl" | "org"> | null {
  // /settings/projects/{project}/ (org-scoped subdomain settings URL)
  if (segments[0] === "settings" && segments[1] === "projects" && segments[2]) {
    return { project: segments[2] };
  }
  // /dashboard/{id}/
  if (segments[0] === "dashboard" && segments[1]) {
    return { dashboardId: segments[1] };
  }
  // /share/issue/{shareId}/
  if (segments[0] === "share" && segments[1] === "issue" && segments[2]) {
    return { shareId: segments[2] };
  }
  const feedbackPath = matchFeedbackPath(segments, 0, searchParams);
  if (feedbackPath) {
    return feedbackPath;
  }
  // Bare org subdomain URL (no path segments)
  if (segments.length === 0) {
    return {};
  }
  return null;
}

/**
 * Match a trace path, canonical or legacy.
 *
 * The trace detail view is mounted at `trace/:traceSlug/`. Canonical URLs are
 * `explore/traces/trace/{id}/`; the `trace/` segment is what distinguishes a
 * detail URL from the traces list. Legacy `traces/{id}/` (no `explore/` prefix,
 * no `trace/` segment) is still accepted so previously-copied links keep
 * resolving.
 *
 * The `trace/` segment is only optional in the legacy non-`explore/` form.
 * Under the `explore/` prefix the `trace/` segment is required — otherwise a
 * URL like `explore/traces/{something}/` (e.g. a future sub-route) would be
 * misread as a trace detail with a bogus ID.
 */
function matchTracePath(
  segments: string[],
  startIndex: number
): { status: "absent" | "list" } | { status: "detail"; traceId: string } {
  let index = startIndex;
  const hasExplorePrefix = segments[index] === "explore";
  if (hasExplorePrefix) {
    index += 1;
  }
  if (segments[index] !== "traces") {
    return { status: "absent" };
  }
  index += 1;

  const hasTraceSegment = segments[index] === "trace";
  if (hasTraceSegment) {
    index += 1;
  } else if (hasExplorePrefix) {
    // `explore/traces/` without the `trace/` segment is the list route (or an
    // unrelated sub-route), never a detail — don't treat the next segment as an ID.
    return { status: "list" };
  }

  const traceId = segments[index];
  if (!traceId) {
    return { status: "list" };
  }

  return { status: "detail", traceId };
}

/** Match a Feedback detail path and extract its project slug and group ID. */
function matchFeedbackPath(
  segments: string[],
  startIndex: number,
  searchParams: URLSearchParams
): Omit<ParsedSentryUrl, "baseUrl" | "org"> | null {
  if (
    segments[startIndex] !== "feedback" ||
    segments.length !== startIndex + 1
  ) {
    return null;
  }

  const feedbackSlug = searchParams.get("feedbackSlug");
  const match = feedbackSlug?.match(FEEDBACK_SLUG_RE);
  if (!match) {
    return {};
  }
  return { project: match[1], issueId: match[2] };
}

function matchReplayPath(
  segments: string[],
  startIndex: number
):
  | { status: "absent" | "list" | "invalid" }
  | { status: "detail"; replayId: string } {
  let replayId: string | undefined;

  if (
    segments[startIndex] === "explore" &&
    segments[startIndex + 1] === "replays"
  ) {
    replayId = segments[startIndex + 2];
  } else if (segments[startIndex] === "replays") {
    replayId = segments[startIndex + 1];
  } else {
    return { status: "absent" };
  }

  if (!replayId) {
    return { status: "list" };
  }

  const normalizedReplayId = tryNormalizeHexId(replayId);
  if (!normalizedReplayId) {
    return { status: "invalid" };
  }

  return { status: "detail", replayId: normalizedReplayId };
}

/**
 * Try to extract org from a SaaS subdomain-style URL.
 *
 * Matches `https://{org}.sentry.io/issues/{id}/` and similar paths
 * where the org is in the hostname rather than the URL path.
 * Only applies to SaaS URLs — self-hosted instances don't use this pattern.
 *
 * @returns Parsed result or null if not a subdomain-style SaaS URL with a known path
 */
function matchSubdomainOrg(
  baseUrl: string,
  hostname: string,
  segments: string[],
  searchParams: URLSearchParams
): ParsedSentryUrl | null {
  // Must be a subdomain of sentry.io (e.g., "my-org.sentry.io")
  if (!hostname.endsWith(`.${DEFAULT_SENTRY_HOST}`)) {
    return null;
  }

  const org = hostname.slice(0, -`.${DEFAULT_SENTRY_HOST}`.length);

  // Skip region subdomains (us.sentry.io, de.sentry.io, etc.) —
  // these are API hosts, not org subdomains.
  if (org.length <= 2) {
    return null;
  }

  const pathResult = matchSubdomainPath(segments, searchParams);
  if (!pathResult) {
    return null;
  }
  return { baseUrl, org, ...pathResult };
}

/**
 * Try to match /share/issue/{shareId}/ path pattern.
 *
 * Catches share URLs on non-subdomain hosts (bare `sentry.io`, self-hosted).
 * Subdomain share URLs (e.g., `gibush-kq.sentry.io/share/issue/...`) are
 * handled by {@link matchSubdomainOrg} which extracts the org from the subdomain.
 *
 * @returns Parsed result or null if pattern doesn't match
 */
function matchSharePath(
  baseUrl: string,
  segments: string[]
): ParsedSentryUrl | null {
  if (segments[0] !== "share" || segments[1] !== "issue" || !segments[2]) {
    return null;
  }
  return { baseUrl, shareId: segments[2] };
}

/**
 * Parse a Sentry web URL and extract its components.
 *
 * Recognizes these path patterns (both SaaS and self-hosted):
 * - `/organizations/{org}/issues/{id}/`
 * - `/organizations/{org}/issues/{id}/events/{eventId}/`
 * - `/organizations/{org}/share/issue/{shareId}/`
 * - `/settings/{org}/projects/{project}/`
 * - `/organizations/{org}/explore/traces/trace/{traceId}/` (canonical)
 * - `/organizations/{org}/traces/{traceId}/` (legacy)
 * - `/organizations/{org}/explore/replays/{replayId}/`
 * - `/organizations/{org}/replays/{replayId}/`
 * - `/organizations/{org}/dashboard/{id}/`
 * - `/organizations/{org}/feedback/?feedbackSlug={project}:{id}`
 * - `/organizations/{org}/`
 * - `/share/issue/{shareId}/`
 *
 * Also recognizes SaaS subdomain-style URLs:
 * - `https://{org}.sentry.io/issues/{id}/`
 * - `https://{org}.sentry.io/explore/traces/trace/{traceId}/` (canonical)
 * - `https://{org}.sentry.io/traces/{traceId}/` (legacy)
 * - `https://{org}.sentry.io/explore/replays/{replayId}/`
 * - `https://{org}.sentry.io/replays/{replayId}/`
 * - `https://{org}.sentry.io/issues/{id}/events/{eventId}/`
 * - `https://{org}.sentry.io/dashboard/{id}/`
 * - `https://{org}.sentry.io/share/issue/{shareId}/`
 * - `https://{org}.sentry.io/feedback/?feedbackSlug={project}:{id}`
 *
 * @param input - Raw string that may or may not be a URL
 * @returns Parsed components, or null if input is not a recognized Sentry URL
 */
export function parseSentryUrl(input: string): ParsedSentryUrl | null {
  // Quick reject — must look like a URL
  if (!(input.startsWith("http://") || input.startsWith("https://"))) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    log.debug("Failed to parse URL", input, error);
    return null;
  }

  const baseUrl = `${url.protocol}//${url.host}`;
  const segments = url.pathname.split("/").filter(Boolean);

  return (
    matchOrganizationsPath(baseUrl, segments, url.searchParams) ??
    matchSettingsPath(baseUrl, segments) ??
    matchSubdomainOrg(baseUrl, url.hostname, segments, url.searchParams) ??
    matchSharePath(baseUrl, segments)
  );
}

/**
 * Configure `SENTRY_URL` for self-hosted instances detected from a parsed
 * URL, with a host-scoping trust check.
 *
 * SaaS URLs proceed (credentials scoped to SaaS are valid for any sentry.io
 * subdomain). Non-SaaS URLs require the active token's host to match —
 * otherwise throws `HostScopeError`. Only `sentry auth login --url <url>`
 * establishes trust for a new non-SaaS host.
 *
 * @param baseUrl - The scheme + host extracted from the URL
 * @throws {HostScopeError} On non-SaaS URL that doesn't match the token
 */
export function applySentryUrlContext(baseUrl: string): void {
  const env = getEnv();
  // Strict SaaS check (https + default port) matches isHostTrusted
  // semantics downstream — `http://sentry.io` and `:8443` must not bypass
  // the trust check.
  if (isSaaSTrustOrigin(baseUrl)) {
    // Clear any self-hosted URL so API calls fall back to default SaaS routing.
    // biome-ignore lint/performance/noDelete: env registry requires delete to truly unset; assignment coerces to string in Node.js
    delete env.SENTRY_HOST;
    // biome-ignore lint/performance/noDelete: env registry requires delete to truly unset; assignment coerces to string in Node.js
    delete env.SENTRY_URL;
    return;
  }

  const tokenHost = getActiveTokenHost();
  if (!(tokenHost && isHostTrusted(baseUrl, tokenHost))) {
    throw new HostScopeError("URL argument", baseUrl, tokenHost);
  }

  env.SENTRY_HOST = baseUrl;
  env.SENTRY_URL = baseUrl;
}
