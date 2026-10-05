/** Credential-aware web links without importing auth into the pure URL helpers. */
import { getApiBaseUrl } from "./sentry-client.js";
import * as urls from "./sentry-urls.js";

function render<T>(build: () => T): T {
  return urls.withSentryBaseUrl(getApiBaseUrl(), build);
}

export function getSentryBaseUrl(): string {
  return render(urls.getSentryBaseUrl);
}

export function isSaaS(): boolean {
  return render(urls.isSaaS);
}

export function getOrgBaseUrl(orgSlug: string): string {
  return render(() => urls.getOrgBaseUrl(orgSlug));
}

export function buildOrgUrl(orgSlug: string): string {
  return render(() => urls.buildOrgUrl(orgSlug));
}

export function buildProjectUrl(orgSlug: string, projectSlug: string): string {
  return render(() => urls.buildProjectUrl(orgSlug, projectSlug));
}

export function buildIssueUrl(orgSlug: string, issueId: string): string {
  return render(() => urls.buildIssueUrl(orgSlug, issueId));
}

export function buildEventSearchUrl(orgSlug: string, eventId: string): string {
  return render(() => urls.buildEventSearchUrl(orgSlug, eventId));
}

export function buildProjectIssuesUrl(orgSlug: string, projectId?: string): string {
  return render(() => urls.buildProjectIssuesUrl(orgSlug, projectId));
}

export function buildOrgSettingsUrl(orgSlug: string, hash?: string): string {
  return render(() => urls.buildOrgSettingsUrl(orgSlug, hash));
}

export function buildSeerSettingsUrl(orgSlug: string): string {
  return render(() => urls.buildSeerSettingsUrl(orgSlug));
}

export function buildBillingUrl(orgSlug: string, product?: string): string {
  return render(() => urls.buildBillingUrl(orgSlug, product));
}

export function buildLogsUrl(orgSlug: string, logId?: string): string {
  return render(() => urls.buildLogsUrl(orgSlug, logId));
}

export function buildReplayUrl(orgSlug: string, replayId: string): string {
  return render(() => urls.buildReplayUrl(orgSlug, replayId));
}

export function buildDashboardsListUrl(orgSlug: string): string {
  return render(() => urls.buildDashboardsListUrl(orgSlug));
}

export function buildDashboardUrl(orgSlug: string, dashboardId: string): string {
  return render(() => urls.buildDashboardUrl(orgSlug, dashboardId));
}

export function buildTraceUrl(orgSlug: string, traceId: string): string {
  return render(() => urls.buildTraceUrl(orgSlug, traceId));
}

export function buildIssueAlertsUrl(orgSlug: string, projectSlug?: string): string {
  return render(() => urls.buildIssueAlertsUrl(orgSlug, projectSlug));
}

export function buildMetricAlertsUrl(orgSlug: string): string {
  return render(() => urls.buildMetricAlertsUrl(orgSlug));
}

export function buildReleaseUrl(orgSlug: string, version: string): string {
  return render(() => urls.buildReleaseUrl(orgSlug, version));
}
