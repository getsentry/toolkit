/**
 * Sentry URL Utilities
 *
 * Utilities for constructing Sentry web URLs.
 * Supports self-hosted instances via SENTRY_URL environment variable.
 */

import {
  DEFAULT_SENTRY_HOST,
  DEFAULT_SENTRY_URL,
  getConfiguredSentryUrl,
  normalizeUrl,
} from "./constants.js";

/**
 * Get the Sentry web base URL.
 * Supports self-hosted instances via SENTRY_URL env var.
 */
export function getSentryBaseUrl(): string {
  return getConfiguredSentryUrl() ?? DEFAULT_SENTRY_URL;
}

/**
 * Build the org-scoped base URL using the subdomain pattern.
 * E.g. "https://sentry.io" + "my-org" → "https://my-org.sentry.io"
 *
 * @param orgSlug - Organization slug
 * @returns Origin URL with org as subdomain
 */
export function getOrgBaseUrl(orgSlug: string): string {
  const base = getSentryBaseUrl();
  if (!isSentrySaasUrl(base)) {
    return base;
  }
  const parsed = new URL(base);
  parsed.hostname = `${orgSlug}.${parsed.hostname}`;
  return parsed.origin;
}

/**
 * Whether the CLI is currently pointed at Sentry SaaS (sentry.io).
 *
 * Resolves the configured base URL (env `SENTRY_HOST`/`SENTRY_URL`, else the
 * default SaaS URL) and applies the hostname-only {@link isSentrySaasUrl}
 * check. Intended for routing/UX decisions (e.g. choosing a SaaS-only default),
 * NOT for credential-trust decisions — use {@link isSaaSTrustOrigin} for those.
 *
 * @returns true when the active base URL is sentry.io or a subdomain of it
 */
export function isSaaS(): boolean {
  return isSentrySaasUrl(getSentryBaseUrl());
}

/**
 * Check if a URL is a Sentry SaaS domain (hostname check only).
 *
 * Used for routing decisions: which URLs are multi-region-eligible, which
 * are self-hosted, whether telemetry should route to SaaS, etc. Matches
 * on hostname alone — scheme and port are NOT checked, so this accepts
 * e.g. `http://sentry.io` and `https://sentry.io:8443` even though those
 * aren't legitimate production SaaS addresses. That's intentional for
 * routing (test harnesses occasionally use these).
 *
 * For TRUST decisions (deciding whether a SaaS-scoped token is valid for
 * a given origin), use {@link isSaaSTrustOrigin} which additionally
 * requires https scheme and default port.
 *
 * @param url - URL string to validate
 * @returns true if the hostname is sentry.io or a subdomain of sentry.io
 */
export function isSentrySaasUrl(url: string): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === DEFAULT_SENTRY_HOST ||
      parsed.hostname.endsWith(`.${DEFAULT_SENTRY_HOST}`)
    );
  } catch {
    return false;
  }
}

/**
 * Check if a URL is a Sentry SaaS origin for TRUST purposes.
 *
 * Stricter than {@link isSentrySaasUrl}: additionally requires
 * - scheme = `https:` (production SaaS is HTTPS-only; `http://sentry.io`
 *   is never legitimate and a crafted plaintext URL must NOT inherit
 *   SaaS trust)
 * - port = default (empty `port` in WHATWG URL means the scheme's
 *   default port; any explicit non-default port indicates either a
 *   crafted URL or DNS redirect we don't trust)
 *
 * Used by the host-scoping trust check (`token-host.ts::isHostTrusted`)
 * to decide SaaS equivalence. Keep in sync with {@link isSentrySaasUrl}
 * when adding new trust classes.
 *
 * @param url - URL string to validate
 * @returns true only if the URL is a strictly-SaaS origin
 */
export function isSaaSTrustOrigin(url: string): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.port === "" && isSentrySaasUrl(url)
    );
  } catch {
    return false;
  }
}

/**
 * Normalize a URL (or fetch input) to its canonical origin
 * (`scheme://host[:port]`). Returns `undefined` for inputs that don't parse
 * as URLs. Bare hostnames are NOT accepted — use {@link normalizeUserInputToOrigin}
 * for user-supplied strings that may be bare hostnames.
 */
export function normalizeOrigin(
  input: string | URL | Request | undefined | null
): string | undefined {
  if (input === null || input === undefined) {
    return;
  }
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof URL) {
    raw = input.href;
  } else {
    raw = input.url;
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return new URL(raw).origin;
  } catch {
    return;
  }
}

/**
 * Normalize a user-supplied string (env var, CLI flag, rc file value) to a
 * canonical origin. Accepts bare hostnames (`sentry.acme.com`) by prefixing
 * with `https://` via {@link normalizeUrl} before parsing.
 *
 * Returns `undefined` for empty/whitespace input or strings that still fail
 * to parse after the prefix.
 */
export function normalizeUserInputToOrigin(
  input: string | undefined
): string | undefined {
  const prefixed = normalizeUrl(input);
  return prefixed ? normalizeOrigin(prefixed) : undefined;
}

/**
 * Build URL to view an organization in Sentry.
 *
 * @param orgSlug - Organization slug
 * @returns Full URL to the organization page
 */
export function buildOrgUrl(orgSlug: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/`;
}

/**
 * Build URL to view a project in Sentry.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @returns Full URL to the project settings page
 */
export function buildProjectUrl(orgSlug: string, projectSlug: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/settings/projects/${projectSlug}/`;
  }
  return `${getSentryBaseUrl()}/settings/${orgSlug}/projects/${projectSlug}/`;
}

/**
 * Build URL to view an issue in Sentry.
 *
 * @param orgSlug - Organization slug
 * @param issueId - Numeric issue ID
 * @returns Full URL to the issue detail page
 */
export function buildIssueUrl(orgSlug: string, issueId: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/issues/${issueId}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/issues/${issueId}/`;
}

/**
 * Build URL to search for an event in Sentry.
 * Uses the issues search with event.id filter.
 *
 * @param orgSlug - Organization slug
 * @param eventId - Event ID (hexadecimal)
 * @returns Full URL to search results showing the event
 */
export function buildEventSearchUrl(orgSlug: string, eventId: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/issues/?query=event.id:${eventId}`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/issues/?query=event.id:${eventId}`;
}

/**
 * Build URL to the project-scoped Issues stream — where a project's errors
 * land. This is the destination a freshly-instrumented project wants to watch
 * for its first event, as opposed to {@link buildProjectUrl} (settings).
 *
 * @param orgSlug - Organization slug
 * @param projectId - Numeric project ID; when omitted the org-wide stream is
 *   returned (still correct, just unfiltered).
 * @returns Full URL to the Issues stream, filtered to the project when possible
 */
export function buildProjectIssuesUrl(
  orgSlug: string,
  projectId?: string
): string {
  const filter = projectId ? `?project=${projectId}` : "";
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/issues/${filter}`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/issues/${filter}`;
}

/**
 * Recover the org and project slugs from a project settings URL as built by
 * {@link buildProjectUrl}. Used as a fallback when the server didn't hand the
 * slugs back directly, so the CLI can still build Issues / MCP URLs. Returns
 * `{}` for anything that doesn't parse.
 *
 * SaaS shape:        `https://{org}.sentry.io/settings/projects/{project}/`
 * Self-hosted shape: `{base}/settings/{org}/projects/{project}/`
 */
export function parseOrgProjectFromSettingsUrl(url: string): {
  orgSlug?: string;
  projectSlug?: string;
} {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const projectsIndex = segments.indexOf("projects");
    const projectSlug =
      projectsIndex >= 0 ? segments[projectsIndex + 1] : undefined;
    if (isSentrySaasUrl(url)) {
      // Org is the subdomain; guard against the bare apex (no org subdomain).
      const [subdomain] = parsed.hostname.split(".");
      const orgSlug =
        parsed.hostname === DEFAULT_SENTRY_HOST ? undefined : subdomain;
      return { orgSlug, projectSlug };
    }
    // Self-hosted: org is the path segment right after `settings`.
    const settingsIndex = segments.indexOf("settings");
    const orgSlug =
      settingsIndex >= 0 ? segments[settingsIndex + 1] : undefined;
    return { orgSlug, projectSlug };
  } catch {
    return {};
  }
}

// Settings URLs

/**
 * Build URL to organization settings page.
 *
 * @param orgSlug - Organization slug
 * @param hash - Optional anchor hash (e.g., "hideAiFeatures")
 * @returns Full URL to the organization settings page
 */
export function buildOrgSettingsUrl(orgSlug: string, hash?: string): string {
  const url = isSaaS()
    ? `${getOrgBaseUrl(orgSlug)}/settings/`
    : `${getSentryBaseUrl()}/settings/${orgSlug}/`;
  return hash ? `${url}#${hash}` : url;
}

/**
 * Build URL to Seer settings page.
 *
 * @param orgSlug - Organization slug
 * @returns Full URL to the Seer settings page
 */
export function buildSeerSettingsUrl(orgSlug: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/settings/seer/`;
  }
  return `${getSentryBaseUrl()}/settings/${orgSlug}/seer/`;
}

/**
 * Build URL to billing page with optional product filter.
 *
 * @param orgSlug - Organization slug
 * @param product - Optional product to highlight (e.g., "seer")
 * @returns Full URL to the billing overview page
 */
export function buildBillingUrl(orgSlug: string, product?: string): string {
  const base = isSaaS()
    ? `${getOrgBaseUrl(orgSlug)}/settings/billing/overview/`
    : `${getSentryBaseUrl()}/settings/${orgSlug}/billing/overview/`;
  return product ? `${base}?product=${product}` : base;
}

// Logs URLs

/**
 * Build URL to the Logs explorer, optionally filtered to a specific log entry.
 *
 * @param orgSlug - Organization slug
 * @param logId - Optional log item ID to filter to
 * @returns Full URL to the Logs explorer
 */
export function buildLogsUrl(orgSlug: string, logId?: string): string {
  const base = isSaaS()
    ? `${getOrgBaseUrl(orgSlug)}/explore/logs/`
    : `${getSentryBaseUrl()}/organizations/${orgSlug}/explore/logs/`;
  return logId ? `${base}?query=sentry.item_id:${logId}` : base;
}

/**
 * Build URL to view a replay in the Replay explorer.
 *
 * @param orgSlug - Organization slug
 * @param replayId - Replay ID (32-character hex string)
 * @returns Full URL to the replay detail view
 */
export function buildReplayUrl(orgSlug: string, replayId: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/explore/replays/${replayId}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/explore/replays/${replayId}/`;
}

// Dashboard URLs

/**
 * Build URL to the dashboards list page.
 *
 * @param orgSlug - Organization slug
 * @returns Full URL to the dashboards list page
 */
export function buildDashboardsListUrl(orgSlug: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/dashboards/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/dashboards/`;
}

/**
 * Build URL to view a specific dashboard.
 *
 * @param orgSlug - Organization slug
 * @param dashboardId - Dashboard ID
 * @returns Full URL to the dashboard view page
 */
export function buildDashboardUrl(
  orgSlug: string,
  dashboardId: string
): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/dashboard/${dashboardId}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/dashboard/${dashboardId}/`;
}

/**
 * Build URL to view a trace in Sentry.
 *
 * @param orgSlug - Organization slug
 * @param traceId - Trace ID (32-character hex string)
 * @returns Full URL to the trace view
 */
export function buildTraceUrl(orgSlug: string, traceId: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/explore/traces/trace/${traceId}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/explore/traces/trace/${traceId}/`;
}

// Alert URLs

/**
 * Build URL to the issue alert rules list for a project.
 *
 * @param orgSlug - Organization slug
 * @param projectSlug - Project slug
 * @returns Full URL to the issue alert rules page
 */
export function buildIssueAlertsUrl(
  orgSlug: string,
  projectSlug?: string
): string {
  const projectFilter = projectSlug ? `?project=${projectSlug}` : "";
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/alerts/rules/${projectFilter}`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/alerts/rules/${projectFilter}`;
}

/**
 * Build URL to the metric alert rules list for an organization.
 *
 * @param orgSlug - Organization slug
 * @returns Full URL to the metric alert rules page
 */
export function buildMetricAlertsUrl(orgSlug: string): string {
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/alerts/metric-rules/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/alerts/metric-rules/`;
}

/**
 * Build URL to view a release in Sentry.
 *
 * Version is URI-encoded since release versions often contain special
 * characters (e.g., `sentry-cli@0.24.0`, `1.0.0-beta+build.123`).
 *
 * @param orgSlug - Organization slug
 * @param version - Release version string
 * @returns Full URL to the release detail page
 */
export function buildReleaseUrl(orgSlug: string, version: string): string {
  const encoded = encodeURIComponent(version);
  if (isSaaS()) {
    return `${getOrgBaseUrl(orgSlug)}/releases/${encoded}/`;
  }
  return `${getSentryBaseUrl()}/organizations/${orgSlug}/releases/${encoded}/`;
}
